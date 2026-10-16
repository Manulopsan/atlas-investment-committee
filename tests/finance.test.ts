import { describe, it, expect } from "vitest";
import { cagr, totalReturn, maxPriceForTarget, marginOfSafety, usdToEur, eurToUsd, eurCagr, proposedEntryPrice, presentValue, fxSensitivity } from "@/lib/finance/returns";
import { computeScenarios, dcf, multiples } from "@/lib/finance/valuation";
import { allowedVerdict, finalScore, rankFinalists, reconcileVerdict, returnPotentialScore, riskPenalty } from "@/lib/finance/scoring";
import { assertCompatible, growthCagr, IncompatibleDataError, deriveMetrics, type DataPoint } from "@/lib/finance/fundamentals";

describe("CAGR", () => {
  it("computes (final/entry)^(1/years) - 1", () => {
    expect(cagr(133.1, 100, 3)).toBeCloseTo(0.1, 10);
    expect(cagr(100, 100, 3)).toBe(0);
    expect(cagr(50, 100, 1)).toBeCloseTo(-0.5);
  });
  it("returns null on invalid or missing inputs (never a misleading figure)", () => {
    expect(cagr(null, 100, 3)).toBeNull();
    expect(cagr(100, 0, 3)).toBeNull();
    expect(cagr(100, -5, 3)).toBeNull();
    expect(cagr(100, 50, 0)).toBeNull();
    expect(cagr(NaN, 50, 3)).toBeNull();
    expect(cagr(-1, 50, 3)).toBeNull();
  });
});

describe("dividends and total return", () => {
  it("adds dividends exactly once", () => {
    const r = totalReturn({ entryPrice: 100, endPrice: 120, dividendsPerShare: 6, years: 3 })!;
    expect(r.priceReturn).toBeCloseTo(0.2);
    expect(r.dividendReturn).toBeCloseTo(0.06);
    expect(r.totalReturn).toBeCloseTo(0.26);
    expect(r.totalCagr).toBeCloseTo(Math.pow(1.26, 1 / 3) - 1);
    expect(r.priceCagr).toBeCloseTo(Math.pow(1.2, 1 / 3) - 1);
    expect(r.dividendCagrContribution).toBeCloseTo(r.totalCagr - r.priceCagr);
  });
  it("does not assume unknown dividends are zero", () => {
    expect(totalReturn({ entryPrice: 100, endPrice: 120, dividendsPerShare: null, years: 3 })).toBeNull();
    expect(totalReturn({ entryPrice: 100, endPrice: 120, dividendsPerShare: undefined, years: 3 })).toBeNull();
    expect(totalReturn({ entryPrice: 100, endPrice: 120, dividendsPerShare: 0, years: 3 })!.totalCagr).toBeCloseTo(Math.pow(1.2, 1 / 3) - 1);
  });
});

describe("maximum purchase price, entry price and margin of safety", () => {
  it("max price = (V_N + D) / (1+target)^N", () => {
    expect(maxPriceForTarget(152.0875, 0, 0.15, 3)).toBeCloseTo(100, 6);
    expect(maxPriceForTarget(140, 12.0875, 0.15, 3)).toBeCloseTo(100, 6);
    // Buying exactly at the max price yields exactly the target.
    const p = maxPriceForTarget(200, 10, 0.15, 3)!;
    expect(cagr(210, p, 3)).toBeCloseTo(0.15, 10);
    expect(maxPriceForTarget(null, 0, 0.15, 3)).toBeNull();
  });
  it("margin of safety", () => {
    expect(marginOfSafety(100, 75)).toBeCloseTo(0.25);
    expect(marginOfSafety(100, 120)).toBeCloseTo(-0.2);
    expect(marginOfSafety(0, 10)).toBeNull();
    expect(marginOfSafety(null, 10)).toBeNull();
  });
  it("proposed entry is the lower of MoS-discounted fair value and max price", () => {
    expect(proposedEntryPrice(100, 0.2, 90)).toBe(80);
    expect(proposedEntryPrice(100, 0.2, 70)).toBe(70);
    expect(proposedEntryPrice(null, 0.2, 70)).toBeNull();
  });
  it("present value", () => {
    expect(presentValue(110, 0.1, 1)).toBeCloseTo(100);
  });
});

describe("currency conversion", () => {
  it("converts with USD per EUR rate", () => {
    expect(usdToEur(110, 1.1)).toBeCloseTo(100);
    expect(eurToUsd(100, 1.1)).toBeCloseTo(110);
    expect(usdToEur(100, 0)).toBeNull();
    expect(usdToEur(100, null)).toBeNull();
  });
  it("EUR return reflects currency moves", () => {
    expect(eurCagr(0.1, 3, 1.1, 1.1)).toBeCloseTo(0.1);
    // Euro strengthens 10% → lower EUR return.
    const r = eurCagr(0.1, 3, 1.1, 1.21)!;
    expect(r).toBeLessThan(0.1);
    expect(Math.pow(1 + r, 3)).toBeCloseTo(Math.pow(1.1, 3) / 1.1);
    expect(fxSensitivity(0.1, 3, 1.1)!.map((x) => x.eurMove)).toEqual([-0.1, 0, 0.1]);
    expect(eurCagr(null, 3, 1.1, 1.1)).toBeNull();
  });
});

describe("scenarios and DCF", () => {
  it("computes scenarios deterministically and flags insufficient data", () => {
    const r = computeScenarios({
      referencePrice: 100, years: 3, discountRate: 0.09, target: 0.15, requiredMos: 0.2,
      scenarios: {
        bear: { metric: "EPS", metricYearN: 6, exitMultiple: 12, cumulativeDividendsPerShare: 3 },
        base: { metric: "EPS", metricYearN: 8, exitMultiple: 18, cumulativeDividendsPerShare: 3 },
        bull: { metric: "EPS", metricYearN: null, exitMultiple: 20, cumulativeDividendsPerShare: 3 },
      },
    });
    expect(r.scenarios.base.valueYearN).toBe(144);
    expect(r.scenarios.base.totalCagr).toBeCloseTo(Math.pow(147 / 100, 1 / 3) - 1);
    expect(r.maxPriceForTarget).toBeCloseTo(147 / Math.pow(1.15, 3));
    expect(r.meetsTargetInBase).toBe(r.scenarios.base.totalCagr! >= 0.15);
    expect(r.scenarios.bull.valueYearN).toBeNull();
    expect(r.scenarios.bull.insufficientData.length).toBeGreaterThan(0);
  });
  it("without a verified price there is no CAGR", () => {
    const r = computeScenarios({ referencePrice: null, years: 3, discountRate: 0.09, target: 0.15, requiredMos: 0.2, scenarios: { base: { metric: "EPS", metricYearN: 8, exitMultiple: 18, cumulativeDividendsPerShare: 0 } } });
    expect(r.scenarios.base.totalCagr).toBeNull();
    expect(r.marginOfSafetyAtPrice).toBeNull();
  });
  it("DCF requires r > g and positive FCF", () => {
    const d = dcf({ fcf0: 100, growth: 0.05, years: 5, terminalGrowth: 0.02, discountRate: 0.09, netDebt: 0, sharesOutstanding: 10 })!;
    expect(d.valuePerShare).toBeGreaterThan(0);
    expect(dcf({ fcf0: 100, growth: 0.05, years: 5, terminalGrowth: 0.1, discountRate: 0.09, netDebt: 0, sharesOutstanding: 10 })).toBeNull();
    expect(dcf({ fcf0: -5, growth: 0.05, years: 5, terminalGrowth: 0.02, discountRate: 0.09, netDebt: 0, sharesOutstanding: 10 })).toBeNull();
    expect(multiples.pe(100, 0)).toBeNull();
    expect(multiples.pe(100, 5)).toBe(20);
  });
});

describe("period, currency and basis guards", () => {
  const fy = (v: number, y: number, unit = "USD"): DataPoint => ({ value: v, unit, periodType: "FY", fiscalYear: y, periodEnd: `${y}-12-31`, basis: "GAAP" });
  it("refuses to mix quarterly and annual, USD and EUR, GAAP and non-GAAP", () => {
    expect(() => assertCompatible(fy(1, 2025), { ...fy(1, 2025), periodType: "Q" }, { samePeriod: true, sameUnit: true })).toThrow(IncompatibleDataError);
    expect(() => assertCompatible(fy(1, 2025), fy(1, 2025, "EUR"), { samePeriod: true, sameUnit: true })).toThrow(IncompatibleDataError);
    expect(() => assertCompatible(fy(1, 2025), { ...fy(1, 2025), basis: "NON_GAAP" }, { samePeriod: true, sameUnit: true })).toThrow(IncompatibleDataError);
    expect(() => assertCompatible(fy(1, 2025), fy(1, 2024), { samePeriod: true, sameUnit: true })).toThrow(IncompatibleDataError);
    expect(growthCagr(fy(100, 2022), fy(133.1, 2025))).toBeCloseTo(0.1);
  });
  it("derived metrics with missing inputs are null, not zero", () => {
    const d = deriveMetrics([{ fiscalYear: 2025, periodEnd: null, revenue: 100, grossProfit: null, operatingIncome: 20, netIncome: null, operatingCashFlow: null, capex: 5, dilutedShares: null, longTermDebt: null, cash: null, equity: null, incomeTax: null, pretaxIncome: null, dividendsPaid: null, buybacks: null, acquisitions: null, stockComp: null, epsDiluted: null, evidence: {} }]);
    expect(d.find((x) => x.metric === "gross_margin")!.value).toBeNull();
    expect(d.find((x) => x.metric === "free_cash_flow")!.value).toBeNull();
    expect(d.find((x) => x.metric === "operating_margin")!.value).toBeCloseTo(0.2);
  });
});

describe("final scoring and verdicts", () => {
  const good = { quality: 80, valuation: 70, risk: 30, catalysts: 50, baseCagr: 0.18, target: 0.15 };
  it("weights components and penalises risk; risk is never positive", () => {
    const s = finalScore(good);
    expect(s.final).toBeCloseTo(0.3 * 80 + 0.3 * 70 + 0.2 * returnPotentialScore(0.18, 0.15)! + 0.15 * 70 + 0.05 * 50);
    expect(riskPenalty(80)).toBeCloseTo(12);
    expect(finalScore({ ...good, risk: 80 }).final!).toBeLessThan(s.final!);
    expect(returnPotentialScore(0.15, 0.15)).toBe(70);
    expect(returnPotentialScore(-0.1, 0.15)).toBe(0);
    expect(returnPotentialScore(null, 0.15)).toBeNull();
  });
  it("missing components → no final score", () => {
    const s = finalScore({ ...good, catalysts: null });
    expect(s.final).toBeNull();
    expect(s.missing).toContain("catalysts");
  });
  it("a critical veto cannot be compensated by other scores", () => {
    const score = finalScore({ ...good, quality: 100, valuation: 100, catalysts: 100, baseCagr: 0.4 });
    const d = allowedVerdict({ score, baseCagr: 0.4, bearCagr: 0.1, target: 0.15, vetoes: [{ severity: "critical", upheld: true, reason: "fraude contable" }], criticalOpenIssues: 0, dataConfidence: 1, priceVerified: true });
    expect(d.allowed).toBe("EXCLUDE");
    expect(reconcileVerdict(d.allowed, "POTENTIAL_BUY").verdict).toBe("EXCLUDE");
  });
  it("verdict rules", () => {
    const base = { bearCagr: 0, target: 0.15, vetoes: [], criticalOpenIssues: 0, dataConfidence: 1, priceVerified: true };
    expect(allowedVerdict({ ...base, score: finalScore(good), baseCagr: 0.18 }).allowed).toBe("POTENTIAL_BUY");
    expect(allowedVerdict({ ...base, score: finalScore({ ...good, baseCagr: 0.05 }), baseCagr: 0.05 }).allowed).toBe("EXCELLENT_TOO_EXPENSIVE");
    expect(allowedVerdict({ ...base, priceVerified: false, score: finalScore(good), baseCagr: 0.18 }).allowed).toBe("PENDING_VERIFICATION");
    expect(allowedVerdict({ ...base, criticalOpenIssues: 1, score: finalScore(good), baseCagr: 0.18 }).allowed).toBe("PENDING_VERIFICATION");
    expect(allowedVerdict({ ...base, score: finalScore({ ...good, quality: 40 }), baseCagr: 0.18 }).allowed).toBe("EXCLUDE");
    expect(allowedVerdict({ ...base, vetoes: [{ severity: "high", upheld: true, reason: "x" }], score: finalScore(good), baseCagr: 0.18 }).allowed).toBe("WATCHLIST");
    expect(allowedVerdict({ ...base, vetoes: [{ severity: "critical", upheld: false, reason: "retirado" }], score: finalScore(good), baseCagr: 0.18 }).allowed).toBe("POTENTIAL_BUY");
  });
  it("the CIO can be more conservative than the engine, never less", () => {
    expect(reconcileVerdict("WATCHLIST", "POTENTIAL_BUY")).toEqual({ verdict: "WATCHLIST", overridden: true });
    expect(reconcileVerdict("POTENTIAL_BUY", "WATCHLIST")).toEqual({ verdict: "WATCHLIST", overridden: false });
    expect(reconcileVerdict("PENDING_VERIFICATION", "EXCLUDE").verdict).toBe("EXCLUDE");
  });
  it("ranking supports fewer than five and zero companies", () => {
    expect(rankFinalists([], 5)).toEqual([]);
    const r = rankFinalists([
      { ticker: "A", verdict: "WATCHLIST" as const, finalScore: 50 },
      { ticker: "B", verdict: "EXCLUDE" as const, finalScore: 90 },
      { ticker: "C", verdict: "POTENTIAL_BUY" as const, finalScore: 65 },
      { ticker: "D", verdict: "PENDING_VERIFICATION" as const, finalScore: 80 },
    ], 5);
    expect(r.map((x) => x.ticker)).toEqual(["C", "A"]);
    expect(rankFinalists([{ ticker: "B", verdict: "EXCLUDE" as const, finalScore: 90 }], 5)).toHaveLength(0);
    expect(rankFinalists([{ ticker: "A", verdict: "WATCHLIST" as const, finalScore: 50 }], 0)).toHaveLength(0);
  });
});
