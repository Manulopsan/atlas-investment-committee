import { describe, it, expect, beforeEach } from "vitest";
import { freshDb, demoSession, testSettings } from "./helpers";
import { extractFigures, reconcileText } from "@/lib/evidence/reconcile";
import { addEvidence, listEvidence } from "@/lib/evidence/registry";
import { extractSection, htmlToParagraphs, rankPassages } from "@/lib/market-data/filings";
import { AlphaVantageHistoryProvider, parseEcbCsv, StooqHistoryProvider } from "@/lib/market-data/prices";
import { pointOnOrBefore, type PriceHistory } from "@/lib/market-data/types";
import { parseAnnualFacts } from "@/lib/market-data/sec";
import { syntheticMarketData } from "@/lib/market-data/synthetic";
import { runTool, type ToolContext } from "@/lib/orchestrator/tools";
import { acquireLease, getSession, listRunnable, listUsage, releaseLease, renewLease, requestRun, sessionSignature, insertMessage, listReports } from "@/lib/db/repo";
import { runWithLease } from "@/lib/orchestrator/manager";
import { runSession } from "@/lib/orchestrator/runner";
import { ScriptedAdapter } from "@/lib/llm/scripted";
import { DEMO_EVAL, computeMetrics, evalMarkdown, listEvalRuns, realizedOutcome, runEval } from "@/lib/evals";
import { basicAuthAllows } from "@/lib/security/basicAuth";
import type { ModelRequest } from "@/lib/llm/adapter";
import type { StoredReport } from "@/lib/agents/schemas";

beforeEach(() => freshDb());

const ctxFor = (sessionId: string, asOf: string | null = null): ToolContext => {
  const s = testSettings((x) => void (x.investment.asOfDate = asOf));
  return { sessionId, role: "RISK", phase: "DEBATE", round1: false, md: { ...syntheticMarketData(), asOf }, settings: s };
};

describe("free-text figure reconciliation", () => {
  it("extracts percentages, money and multiples (Spanish and English formats)", () => {
    const f = extractFigures("Margen operativo del 24,5%, ingresos de $4.2 billion, 1.200 millones de USD y un PER de 18x.");
    expect(f.find((x) => x.kind === "pct")!.value).toBeCloseTo(0.245);
    expect(f.find((x) => x.raw.startsWith("$4.2"))!.value).toBeCloseTo(4.2e9);
    expect(f.find((x) => x.raw.includes("1.200"))!.value).toBeCloseTo(1.2e9);
    expect(f.find((x) => x.kind === "multiple")!.value).toBe(18);
  });
  it("matches figures against the registry and flags the rest", () => {
    const s = demoSession();
    addEvidence(s.id, { ticker: "X", metric: "operating_margin", value: 0.2412, unit: "ratio", period: "FY2025", periodType: "FY", source: "e", url: "https://x.test", dataType: "CALCULATED", formula: "a/b", verification: "VERIFIED", confidence: "HIGH", createdBy: "system:engine" });
    const r = reconcileText(listEvidence(s.id, { ticker: "X" }), "El margen es del 24% y el crecimiento esperado del 12%.");
    expect(r.matched.map((m) => m.metric)).toEqual(["operating_margin"]);
    expect(r.unmatched.map((u) => u.raw)).toEqual(["12%"]);
  });
  it("initial reports carry a reconciliation per company", async () => {
    const settings = testSettings();
    const s = demoSession(settings);
    await runSession(s.id, { adapter: new ScriptedAdapter(), md: syntheticMarketData(), settings });
    const rep = listReports(s.id, "QUALITY")[0].content as StoredReport;
    expect(rep.reconciliation).toBeDefined();
    expect(Object.keys(rep.reconciliation!)).toEqual(rep.companies.map((c) => c.ticker));
  });
});

describe("10-K section reader", () => {
  const html = `<p>Table of Contents</p><p>Item 1A. Risk Factors</p><p>Item 7. MD&amp;A</p><hr/>
  <p>Item 1. Business</p><p>We make widgets used by industrial customers around the world in many markets.</p><div style="page-break-before:always"></div>
  <p>Item 1A. Risk Factors</p><p>Our substantial indebtedness could adversely affect our financial condition and limit refinancing options.</p>
  <p>A small number of customers account for a large share of revenue, and losing one would hurt results.</p><hr/>
  <p>Item 1B. Unresolved Staff Comments</p><p>None.</p><p>Item 7. Management&#8217;s Discussion and Analysis</p><p>Revenue grew 9% driven by price increases and new products across segments.</p>`;
  it("finds the real section body (not the table of contents) with paragraph and page", () => {
    const paras = htmlToParagraphs(html);
    const risk = extractSection(paras, "risk_factors");
    expect(risk).toHaveLength(2);
    expect(risk[0].text).toMatch(/indebtedness/);
    expect(risk[0].page).toBe(3);
    expect(extractSection(paras, "mda")[0].text).toMatch(/Revenue grew 9%/);
    expect(extractSection(paras, "legal_proceedings")).toHaveLength(0);
  });
  it("ranks passages by query", () => {
    const risk = extractSection(htmlToParagraphs(html), "risk_factors");
    expect(rankPassages(risk, "customers concentration", 1)[0].text).toMatch(/customers/);
  });
  it("the tool returns literal passages registered as VERIFIED citable evidence", async () => {
    const s = demoSession();
    const r = await runTool("read_filing_section", { ticker: "DEMO-C", section: "risk_factors", query: "debt indebtedness" }, ctxFor(s.id));
    expect(r.isError).toBe(false);
    expect(r.content).toMatch(/Item 1A — Risk Factors ¶\d+ · pág\. ≈\d+/);
    const ev = listEvidence(s.id, { ticker: "DEMO-C", metric: "filing:risk_factors" });
    expect(ev.length).toBeGreaterThan(0);
    expect(ev[0].verification).toBe("VERIFIED");
    expect(ev[0].valueText).toMatch(/indebtedness/);
  });
});

describe("price history, historical multiples and peers", () => {
  it("parses Stooq and Alpha Vantage histories; Alpha Vantage URL is redacted", () => {
    const h = StooqHistoryProvider.parse("X", "Date,Open,High,Low,Close,Volume\n2024-01-03,1,1,1,10.5,1\n2024-01-02,1,1,1,10,1", "u", "t")!;
    expect(h.points.map((p) => p.date)).toEqual(["2024-01-02", "2024-01-03"]);
    expect(h.adjustment).toBe("unknown");
    const a = AlphaVantageHistoryProvider.parse("X", { "Monthly Adjusted Time Series": { "2024-01-31": { "4. close": "100", "5. adjusted close": "98" } } }, "t")!;
    expect(a.points[0].totalReturnClose).toBe(98);
    expect(a.url).toContain("apikey=REDACTED");
  });
  it("pointOnOrBefore respects the tolerance window", () => {
    const h = { points: [{ date: "2024-01-31", close: 1 }, { date: "2024-02-29", close: 2 }], frequency: "monthly" } as PriceHistory;
    expect(pointOnOrBefore(h, "2024-02-15", 35)!.close).toBe(1);
    expect(pointOnOrBefore(h, "2024-06-30", 35)).toBeNull();
    expect(pointOnOrBefore(h, "2023-12-31", 35)).toBeNull();
  });
  it("ECB historical CSV", () => {
    const r = parseEcbCsv("KEY,FREQ,TIME_PERIOD,OBS_VALUE\nx,D,2021-06-29,1.19\nx,D,2021-06-30,1.1884", "u", "t")!;
    expect(r.usdPerEur).toBe(1.1884);
    expect(r.date).toBe("2021-06-30");
  });
  it("historical valuation and peer comparables are computed by the engine and registered", async () => {
    const s = demoSession();
    const h = await runTool("get_historical_valuation", { ticker: "DEMO-A" }, ctxFor(s.id));
    expect(h.content).toMatch(/Rango histórico/);
    expect(listEvidence(s.id, { ticker: "DEMO-A", metric: "hist_pe" }).length).toBeGreaterThan(0);
    const p = await runTool("get_peer_comparables", { ticker: "DEMO-A", peers: ["DEMO-E", "DEMO-F"] }, ctxFor(s.id));
    expect(p.content).toMatch(/Mediana de competidores/);
    expect(p.content).toMatch(/DEMO-E/);
  });
});

describe("point-in-time mode", () => {
  it("SEC facts filed after the analysis date are excluded", () => {
    const json = { facts: { "us-gaap": { Revenues: { units: { USD: [
      { val: 100, start: "2020-01-01", end: "2020-12-31", form: "10-K", fp: "FY", filed: "2021-02-10", accn: "a" },
      { val: 105, start: "2020-01-01", end: "2020-12-31", form: "10-K", fp: "FY", filed: "2022-02-10", accn: "b" },
      { val: 120, start: "2021-01-01", end: "2021-12-31", form: "10-K", fp: "FY", filed: "2022-02-10", accn: "b" },
    ] } } } } };
    const r = parseAnnualFacts(json, "1", "2021-06-30").filter((f) => f.key === "revenue");
    expect(r).toHaveLength(1);
    expect(r[0].value).toBe(100); // the later restatement is not visible yet
  });
  it("prices come from history at the analysis date", async () => {
    const s = demoSession();
    const r = await runTool("get_price", { ticker: "DEMO-A" }, ctxFor(s.id, "2021-06-30"));
    expect(r.content).toMatch(/a 2021-06-30/);
    const fin = await runTool("get_company_financials", { ticker: "DEMO-A" }, ctxFor(s.id, "2021-06-30"));
    expect(fin.content).not.toMatch(/FY202[1-5]:/);
  });
});

describe("worker leases and live updates", () => {
  it("only one runner can hold a session lease; expired leases are reclaimable", () => {
    const s = demoSession();
    expect(acquireLease(s.id, "a", 60_000)).toBe(true);
    expect(acquireLease(s.id, "b", 60_000)).toBe(false);
    expect(renewLease(s.id, "b", 60_000)).toBe(false);
    releaseLease(s.id, "a");
    expect(acquireLease(s.id, "b", -1)).toBe(true); // already expired
    expect(acquireLease(s.id, "c", 60_000)).toBe(true);
  });
  it("listRunnable returns queued (or crashed) sessions without a live lease", () => {
    const s = demoSession();
    expect(listRunnable().map((x) => x.id)).not.toContain(s.id);
    requestRun(s.id);
    expect(listRunnable().map((x) => x.id)).toContain(s.id);
    acquireLease(s.id, "w", 60_000);
    expect(listRunnable().map((x) => x.id)).not.toContain(s.id);
  });
  it("runWithLease executes a queued demo session and releases the lease", async () => {
    const s = demoSession(testSettings());
    requestRun(s.id);
    expect(await runWithLease(s.id, "worker:test")).toBe(true);
    const after = getSession(s.id)!;
    expect(after.status).toBe("COMPLETED");
    expect(after.leaseOwner).toBeNull();
    expect(after.runRequested).toBe(false);
  });
  it("the SSE signature changes when stored state changes", () => {
    const s = demoSession();
    const a = sessionSignature(s.id);
    insertMessage({ sessionId: s.id, round: 2, phase: "DEBATE", ticker: null, fromRole: "CIO", toRole: "ALL", type: "ARGUMENT", claim: "x x x x x", evidenceText: null, evidenceIds: [], question: null, expectedOutcome: "x", inReplyTo: null, taskKey: "t" });
    expect(sessionSignature(s.id)).not.toBe(a);
    expect(sessionSignature("nope")).toBeNull();
  });
});

describe("precise token counting and per-company cost", () => {
  it("uses the adapter's countTokens for the budget check and records the basis and ticker", async () => {
    class Counting extends ScriptedAdapter {
      counted = 0;
      async countTokens(_r: Pick<ModelRequest, "model" | "system" | "messages" | "tools">) {
        this.counted++;
        return 1234;
      }
    }
    const settings = testSettings();
    const s = demoSession(settings);
    const a = new Counting();
    await runSession(s.id, { adapter: a, md: syntheticMarketData(), settings });
    expect(a.counted).toBe(a.calls);
    const u = listUsage(s.id);
    expect(u.every((x) => x.inputEstimateBasis === "count_tokens (exacto)")).toBe(true);
    expect(u.some((x) => x.ticker && x.phase === "DEBATE")).toBe(true);
  });
});

describe("evaluation harness", () => {
  it("computes realized outcomes from price history", async () => {
    const r = await realizedOutcome(syntheticMarketData(), "DEMO-A", "2021-06-30", 3, "2026-10-16");
    expect(r.complete).toBe(true);
    expect(r.realizedCagr).not.toBeNull();
    expect(r.realizedBasis).toBe("total_return");
    const partial = await realizedOutcome(syntheticMarketData(), "DEMO-A", "2025-06-30", 3, "2026-10-16");
    expect(partial.complete).toBe(false);
    expect((await realizedOutcome(syntheticMarketData(), "NOPE", "2021-06-30", 3)).note).toMatch(/histórico/);
  });
  it("runs the demo evaluation end-to-end in point-in-time mode and stores metrics", async () => {
    const settings = testSettings((x) => void (x.investment.maxDebateCompanies = 5));
    const seen: string[] = [];
    const run = await runEval(DEMO_EVAL, "demo", settings, (s) => {
      seen.push(s.config.asOfDate ?? "");
      return { adapter: new ScriptedAdapter(), md: { ...syntheticMarketData(), asOf: s.config.asOfDate }, settings: s.settings };
    }, { today: "2026-10-16" });
    expect(run.status).toBe("COMPLETED");
    expect(seen).toEqual(["2021-06-30"]);
    expect(run.metrics!.evaluatedCompanies).toBeGreaterThan(0);
    expect(run.metrics!.caveats.join(" ")).toMatch(/anticipación/);
    const sess = getSession(run.results![0].sessionId)!;
    expect(sess.config.asOfDate).toBe("2021-06-30");
    expect(sess.coverage?.level).toBe("CANDIDATE_LIST");
    expect(listEvalRuns()[0].id).toBe(run.id);
    expect(evalMarkdown(run)).toMatch(/Advertencias/);
  });
  it("metrics handle empty results", () => {
    const m = computeMetrics([], 0.15);
    expect(m.evaluatedCompanies).toBe(0);
    expect(m.spearmanScoreVsRealized).toBeNull();
  });
});

describe("optional basic auth", () => {
  it("allows everything when not configured and checks credentials otherwise", () => {
    expect(basicAuthAllows(null, undefined)).toBe(true);
    expect(basicAuthAllows(null, "u:p")).toBe(false);
    expect(basicAuthAllows(`Basic ${btoa("u:p")}`, "u:p")).toBe(true);
    expect(basicAuthAllows(`Basic ${btoa("u:x")}`, "u:p")).toBe(false);
  });
});
