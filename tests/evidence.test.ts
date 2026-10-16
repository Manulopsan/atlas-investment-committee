import { describe, it, expect, beforeEach } from "vitest";
import { freshDb, demoSession, testSettings } from "./helpers";
import { addEvidence, citationStatus, EvidenceValidationError, listEvidence } from "@/lib/evidence/registry";
import { listIssues } from "@/lib/db/repo";
import { runTool } from "@/lib/orchestrator/tools";
import { syntheticMarketData } from "@/lib/market-data/synthetic";
import { createMarketData } from "@/lib/market-data";
import { assertPublicHttpsUrl, isPrivateIp } from "@/lib/security/net";

beforeEach(() => freshDb());

const base = { ticker: "XYZ", metric: "revenue", value: 100, unit: "USD", period: "FY2025", periodType: "FY" as const, source: "test", dataType: "REPORTED" as const, confidence: "HIGH" as const };

describe("9. figures without a source are never VERIFIED", () => {
  it("rejects VERIFIED without URL and downgrades agent self-certification", () => {
    const s = demoSession();
    expect(() => addEvidence(s.id, { ...base, verification: "VERIFIED", createdBy: "system:sec" })).toThrow(EvidenceValidationError);
    const e = addEvidence(s.id, { ...base, url: "https://example.com/x", verification: "VERIFIED", createdBy: "agent:QUALITY" });
    expect(e.verification).toBe("UNVERIFIED");
    const ok = addEvidence(s.id, { ...base, metric: "netIncome", url: "https://www.sec.gov/x", verification: "VERIFIED", createdBy: "system:sec" });
    expect(ok.verification).toBe("VERIFIED");
  });
  it("a price without date or kind is invalid", () => {
    const s = demoSession();
    expect(() => addEvidence(s.id, { ...base, metric: "price", url: "https://x.test", verification: "UNVERIFIED", createdBy: "system:x" })).toThrow(/fecha/);
    expect(() => addEvidence(s.id, { ...base, metric: "price", publishedAt: "2026-01-01", url: "https://x.test", verification: "UNVERIFIED", createdBy: "system:x" })).toThrow(/cierre/);
  });
  it("calculated figures must document their formula", () => {
    const s = demoSession();
    expect(() => addEvidence(s.id, { ...base, dataType: "CALCULATED", verification: "UNVERIFIED", createdBy: "system:engine" })).toThrow(/fórmula/);
  });
  it("citations to non-existent evidence are reported as missing", () => {
    const s = demoSession();
    expect(citationStatus(s.id, ["EV-999"]).missing).toEqual(["EV-999"]);
  });
  it("record_claim is always UNVERIFIED", async () => {
    const s = demoSession();
    const r = await runTool("record_claim", { ticker: "XYZ", metric: "tam", value: 5e9, unit: "USD", period: "FY2025", period_type: "FY", basis: "NA", data_type: "ESTIMATED", source: "estimación propia", url: "https://example.com", note: "n" }, { sessionId: s.id, role: "QUALITY", phase: "ROUND_1", round1: true, md: syntheticMarketData(), settings: testSettings() });
    expect(r.content).toMatch(/UNVERIFIED/);
    expect(listEvidence(s.id)[0].verification).toBe("UNVERIFIED");
  });
});

describe("conflicting sources", () => {
  it("keeps both references and opens a DATA_CONFLICT issue", () => {
    const s = demoSession();
    addEvidence(s.id, { ...base, url: "https://a.test", verification: "VERIFIED", createdBy: "system:a", source: "A" });
    addEvidence(s.id, { ...base, value: 120, url: "https://b.test", verification: "VERIFIED", createdBy: "system:b", source: "B" });
    const ev = listEvidence(s.id, { ticker: "XYZ", metric: "revenue" });
    expect(ev).toHaveLength(2);
    expect(ev.every((e) => e.verification === "CONFLICT")).toBe(true);
    const issues = listIssues(s.id);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("DATA_CONFLICT");
    expect(issues[0].claims).toHaveLength(2);
  });
  it("small differences within tolerance are not conflicts; duplicates are de-duplicated", () => {
    const s = demoSession();
    addEvidence(s.id, { ...base, url: "https://a.test", verification: "VERIFIED", createdBy: "system:a", source: "A" });
    addEvidence(s.id, { ...base, value: 100.5, url: "https://b.test", verification: "VERIFIED", createdBy: "system:b", source: "B" });
    addEvidence(s.id, { ...base, url: "https://a.test", verification: "VERIFIED", createdBy: "system:a", source: "A" });
    expect(listEvidence(s.id)).toHaveLength(2);
    expect(listIssues(s.id)).toHaveLength(0);
  });
});

describe("verify_source", () => {
  const ctx = (fetchImpl: typeof fetch) => {
    const s = demoSession(testSettings(), "live");
    return { sessionId: s.id, role: "RISK" as const, phase: "DEBATE", round1: false, md: createMarketData("live", testSettings(), { fetchImpl }), settings: testSettings(), fetchImpl };
  };
  const input = { url: "https://93.184.216.34/report", quote: "Net revenue increased 12% to $4.2 billion", ticker: "XYZ", metric: "revenue", value: 4.2e9, unit: "USD", period: "FY2025" };
  it("VERIFIED only when the quoted text is found in the page", async () => {
    const c = ctx((async () => new Response("<html><p>Net revenue   increased 12% to $4.2 billion in fiscal 2025</p></html>")) as unknown as typeof fetch);
    const r = await runTool("verify_source", input, c);
    expect(r.content).toMatch(/^VERIFICADO/);
    expect(listEvidence(c.sessionId)[0].verification).toBe("VERIFIED");
  });
  it("UNVERIFIED when the text is absent", async () => {
    const c = ctx((async () => new Response("<html>nothing here</html>")) as unknown as typeof fetch);
    const r = await runTool("verify_source", input, c);
    expect(r.content).toMatch(/NO VERIFICADO/);
    expect(listEvidence(c.sessionId)[0].verification).toBe("UNVERIFIED");
  });
  it("UNREACHABLE when the source cannot be opened", async () => {
    const c = ctx((async () => new Response("err", { status: 503 })) as unknown as typeof fetch);
    await runTool("verify_source", input, c);
    expect(listEvidence(c.sessionId)[0].verification).toBe("UNREACHABLE");
  });
  it("blocks private / non-https URLs (SSRF guard)", async () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    await expect(assertPublicHttpsUrl("http://example.com")).rejects.toThrow();
    await expect(assertPublicHttpsUrl("https://127.0.0.1/")).rejects.toThrow();
    await expect(assertPublicHttpsUrl("https://localhost/")).rejects.toThrow();
    const c = ctx((async () => new Response("x")) as unknown as typeof fetch);
    const r = await runTool("verify_source", { ...input, url: "https://169.254.169.254/latest" }, c);
    expect(r.content).toMatch(/rechazada/);
  });
});
