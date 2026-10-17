import { describe, it, expect, beforeEach } from "vitest";
import { freshDb, demoSession, testSettings } from "./helpers";
import { NasdaqPriceProvider, NasdaqSnapshotProvider, parseNasdaqDate, YahooHistoryProvider, YahooPriceProvider } from "@/lib/market-data/prices";
import { screen, type CapsByCik } from "@/lib/market-data/discovery";
import { ScreeningCriteriaSchema, screeningCriteria } from "@/lib/config";
import { referenceQuote, registerQuote } from "@/lib/orchestrator/tools";
import { syntheticMarketData } from "@/lib/market-data/synthetic";
import type { PriceProvider, Quote } from "@/lib/market-data/types";

beforeEach(() => freshDb());

const yahoo = {
  chart: {
    result: [
      {
        meta: { currency: "USD", regularMarketPrice: 176.98, regularMarketTime: 1792180803 },
        timestamp: [1792000000, 1792086400],
        indicators: { quote: [{ close: [180.5, 176.98] }], adjclose: [{ adjclose: [179.9, 176.98] }] },
      },
    ],
  },
};

describe("price providers", () => {
  it("parses Yahoo quotes and history (split-adjusted close + total-return close)", () => {
    const q = YahooPriceProvider.parse("ANET", yahoo, "u", "2026-10-17T00:00:00Z")!;
    expect(q.price).toBe(176.98);
    expect(q.kind).toBe("DELAYED");
    expect(q.asOf.startsWith("2026-10-")).toBe(true);
    const h = YahooHistoryProvider.parse("ANET", yahoo, "u", "r")!;
    expect(h.points).toHaveLength(2);
    expect(h.points[1]).toMatchObject({ close: 176.98, totalReturnClose: 176.98 });
    expect(h.adjustment).toBe("splits");
    // Non-USD listings are not used as a USD reference
    expect(YahooPriceProvider.parse("X", { chart: { result: [{ meta: { ...yahoo.chart.result[0].meta, currency: "EUR" } }] } }, "u", "r")).toBeNull();
  });

  it("parses Nasdaq quotes, dates and the market snapshot", () => {
    const q = NasdaqPriceProvider.parse("ANET", { data: { primaryData: { lastSalePrice: "$1,176.98", lastTradeTimestamp: "Oct 15, 2026" } } }, "u", "2026-10-17T00:00:00Z")!;
    expect(q.price).toBe(1176.98);
    expect(q.asOf).toBe("2026-10-15");
    expect(parseNasdaqDate("Oct 16, 2026 4:00 PM ET")).toBe("2026-10-16");
    expect(NasdaqPriceProvider.parse("X", { data: { primaryData: { lastSalePrice: "N/A" } } }, "u", "r")).toBeNull();
    const snap = NasdaqSnapshotProvider.parse({ data: { rows: [{ symbol: "BRK/B", marketCap: "1000000000", lastsale: "$400" }, { symbol: "ZZZ", marketCap: "" }] } }, "r");
    expect(snap.data).toEqual([{ ticker: "BRK.B", marketCap: 1e9, lastPrice: 400, sector: null, industry: null, country: null }]);
  });
});

const quoteFrom = (id: string, price: number | null): PriceProvider => ({
  id,
  quote: async (ticker: string): Promise<Quote | null> =>
    price === null ? null : { ticker, price, currency: "USD", asOf: "2026-10-16", kind: "DELAYED", delayNote: `${id} retrasado.`, source: id, url: `https://${id}.example/q`, retrievedAt: "2026-10-17T00:00:00Z" },
});

describe("reference price corroboration", () => {
  const ctxFor = (prices: PriceProvider[]) => {
    const sess = demoSession(testSettings());
    return { sessionId: sess.id, role: "CIO" as const, phase: "DISCOVERY", round1: false, md: { ...syntheticMarketData(), synthetic: false, prices }, settings: testSettings() };
  };

  it("two sources that agree give a HIGH-confidence verified price", async () => {
    const ctx = ctxFor([quoteFrom("a", 100), quoteFrom("b", 100.5)]);
    const r = (await referenceQuote(ctx, "TEST"))!;
    expect(r.corroboration?.diff).toBeCloseTo(0.005);
    const ev = registerQuote(ctx, "TEST", r);
    expect(ev).toMatchObject({ value: 100, verification: "VERIFIED", confidence: "HIGH" });
  });

  it("a gap between sources is flagged, a single source is MEDIUM, and failures fall through", async () => {
    const gap = ctxFor([quoteFrom("a", 100), quoteFrom("b", 110)]);
    const ev = registerQuote(gap, "TEST", (await referenceQuote(gap, "TEST"))!);
    expect(ev.confidence).toBe("LOW");
    expect(ev.confidenceReason).toMatch(/DISCREPANCIA/);
    const single = ctxFor([quoteFrom("down", null), quoteFrom("b", 50)]);
    const r = (await referenceQuote(single, "TEST"))!;
    expect(r.providerId).toBe("b");
    expect(registerQuote(single, "TEST", r).confidence).toBe("MEDIUM");
    expect(await referenceQuote(ctxFor([quoteFrom("down", null)]), "TEST")).toBeNull();
  });
});

describe("screening with valuation", () => {
  const row = (cik: string, value: number) => ({ cik, entityName: cik, value, periodEnd: "", accession: "" });
  // Same quality for A and B; B is much cheaper (higher FCF yield). C fails the margin filter.
  const frames = {
    revenue: [row("A", 1e9), row("B", 1e9), row("C", 1e9), row("D", 5e7)],
    revenueOld: [row("A", 8e8), row("B", 8e8), row("C", 8e8), row("D", 4e7)],
    operatingIncome: [row("A", 2e8), row("B", 2e8), row("C", 5e7), row("D", 1e7)],
    operatingCashFlow: [row("A", 2.5e8), row("B", 2.5e8), row("C", 2e8), row("D", 1e7)],
    capex: [row("A", 5e7), row("B", 5e7), row("C", 1e7), row("D", 1e6)],
  };
  const caps: CapsByCik = new Map([
    ["A", { marketCap: 2e10, capSegment: "large" }],
    ["B", { marketCap: 2e9, capSegment: "mid" }],
    ["C", { marketCap: 2e9, capSegment: "mid" }],
    ["D", { marketCap: 1e8, capSegment: "micro" }],
  ]);

  it("ranks the cheaper of two equal-quality companies first and records why others were dropped", () => {
    const rows = screen(frames, 2025, ScreeningCriteriaSchema.parse({}), caps);
    const by = Object.fromEntries(rows.map((r) => [r.cik, r]));
    expect(by.B.fcfYield).toBeCloseTo(0.1);
    expect(by.A.fcfYield).toBeCloseTo(0.01);
    // A fails the default 2 % FCF-yield floor; B passes and ranks first
    expect(by.A.rejectedBy).toBe("rentabilidad FCF");
    expect(rows[0].cik).toBe("B");
    expect(by.C.rejectedBy).toBe("margen operativo");
    expect(by.D.rejectedBy).toBe("ingresos");
  });

  it("criteria are configurable, and old configs without them get the defaults", () => {
    const loose = ScreeningCriteriaSchema.parse({ minFcfYield: 0, weights: { fcfYield: 0, earningsYield: 0 } });
    const rows = screen(frames, 2025, loose, caps);
    const by = Object.fromEntries(rows.map((r) => [r.cik, r]));
    expect(by.A.rejectedBy).toBeNull();
    expect(by.A.screenScore).toBe(by.B.screenScore); // valuation ignored → same quality, same score
    expect(screeningCriteria({})).toEqual(ScreeningCriteriaSchema.parse({}));
  });
});
