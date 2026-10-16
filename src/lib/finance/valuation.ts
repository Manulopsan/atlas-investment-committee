import {
  cagr,
  isNum,
  marginOfSafety,
  maxPriceForTarget,
  presentValue,
  proposedEntryPrice,
  totalReturn,
  type Maybe,
} from "./returns";

export type ScenarioName = "bear" | "base" | "bull";

export interface ScenarioAssumption {
  /** Per-share metric in year N (EPS or FCF per share), from the Valuation agent. */
  metric: "EPS" | "FCF_PER_SHARE";
  metricYearN: number | null;
  exitMultiple: number | null;
  cumulativeDividendsPerShare: number | null;
  rationale?: string;
}

export interface ScenarioResult {
  name: ScenarioName;
  valueYearN: number | null;
  dividendsPerShare: number | null;
  priceCagr: number | null;
  totalCagr: number | null;
  fairValueToday: number | null;
  insufficientData: string[];
}

export interface ScenarioSetResult {
  referencePrice: number | null;
  years: number;
  discountRate: number;
  target: number;
  scenarios: Record<ScenarioName, ScenarioResult>;
  fairValueCentral: number | null;
  fairValueLow: number | null;
  fairValueHigh: number | null;
  maxPriceForTarget: number | null;
  proposedEntryPrice: number | null;
  marginOfSafetyAtPrice: number | null;
  meetsTargetInBase: boolean | null;
  /** Spread between bull and bear CAGR — a crude sensitivity indicator. */
  cagrSpread: number | null;
  formula: string;
}

export const SCENARIO_FORMULA =
  "Valor año N = métrica por acción año N × múltiplo de salida. " +
  "Valor razonable hoy = (valor año N + dividendos acumulados) / (1 + tasa de descuento)^N. " +
  "Precio máximo = (valor año N base + dividendos base) / (1 + objetivo)^N. " +
  "Precio de entrada propuesto = mín(valor razonable central × (1 − margen requerido), precio máximo).";

export function scenarioValue(a: ScenarioAssumption | undefined): { value: number | null; missing: string[] } {
  const missing: string[] = [];
  if (!a) return { value: null, missing: ["escenario no definido"] };
  if (!isNum(a.metricYearN)) missing.push("métrica año N");
  if (!isNum(a.exitMultiple)) missing.push("múltiplo de salida");
  if (missing.length) return { value: null, missing };
  if (a.metricYearN! <= 0) return { value: null, missing: ["métrica año N ≤ 0: el múltiplo no es aplicable"] };
  if (a.exitMultiple! <= 0) return { value: null, missing: ["múltiplo ≤ 0"] };
  return { value: a.metricYearN! * a.exitMultiple!, missing };
}

export function computeScenarios(input: {
  referencePrice: Maybe;
  years: number;
  discountRate: number;
  target: number;
  requiredMos: number;
  scenarios: Partial<Record<ScenarioName, ScenarioAssumption>>;
}): ScenarioSetResult {
  const names: ScenarioName[] = ["bear", "base", "bull"];
  const price = isNum(input.referencePrice) && input.referencePrice > 0 ? input.referencePrice : null;
  const out = {} as Record<ScenarioName, ScenarioResult>;
  for (const n of names) {
    const a = input.scenarios[n];
    const { value, missing } = scenarioValue(a);
    const divs = a && isNum(a.cumulativeDividendsPerShare) ? a.cumulativeDividendsPerShare : null;
    if (a && divs === null) missing.push("dividendos acumulados (use 0 solo si la empresa no paga)");
    const tr = price !== null && value !== null && divs !== null
      ? totalReturn({ entryPrice: price, endPrice: value, dividendsPerShare: divs, years: input.years })
      : null;
    if (price === null) missing.push("precio de referencia verificado");
    out[n] = {
      name: n,
      valueYearN: value,
      dividendsPerShare: divs,
      priceCagr: price !== null ? cagr(value, price, input.years) : null,
      totalCagr: tr ? tr.totalCagr : null,
      fairValueToday: value !== null && divs !== null ? presentValue(value + divs, input.discountRate, input.years) : null,
      insufficientData: missing,
    };
  }
  const base = out.base;
  const fairValueCentral = base.fairValueToday;
  const lows = [out.bear.fairValueToday, out.bull.fairValueToday].filter(isNum);
  const maxPrice = maxPriceForTarget(base.valueYearN, base.dividendsPerShare, input.target, input.years);
  return {
    referencePrice: price,
    years: input.years,
    discountRate: input.discountRate,
    target: input.target,
    scenarios: out,
    fairValueCentral,
    fairValueLow: isNum(out.bear.fairValueToday) ? out.bear.fairValueToday : lows.length ? Math.min(...lows) : null,
    fairValueHigh: isNum(out.bull.fairValueToday) ? out.bull.fairValueToday : null,
    maxPriceForTarget: maxPrice,
    proposedEntryPrice: proposedEntryPrice(fairValueCentral, input.requiredMos, maxPrice),
    marginOfSafetyAtPrice: marginOfSafety(fairValueCentral, price),
    meetsTargetInBase: isNum(base.totalCagr) ? base.totalCagr >= input.target : null,
    cagrSpread: isNum(out.bull.totalCagr) && isNum(out.bear.totalCagr) ? out.bull.totalCagr - out.bear.totalCagr : null,
    formula: SCENARIO_FORMULA,
  };
}

export interface DcfInput {
  /** Starting free cash flow (absolute USD, last fiscal year). */
  fcf0: Maybe;
  growth: Maybe;
  years: number;
  terminalGrowth: Maybe;
  discountRate: Maybe;
  netDebt: Maybe;
  sharesOutstanding: Maybe;
}

export interface DcfOutput {
  enterpriseValue: number;
  equityValue: number;
  valuePerShare: number;
  pvExplicit: number;
  pvTerminal: number;
  terminalShare: number;
  formula: string;
}

export const DCF_FORMULA =
  "FCF_t = FCF_0 × (1+g)^t; VT = FCF_N × (1+g_t) / (r − g_t); EV = Σ FCF_t/(1+r)^t + VT/(1+r)^N; " +
  "Equity = EV − deuda neta; valor por acción = Equity / acciones.";

export function dcf(input: DcfInput): DcfOutput | null {
  const { fcf0, growth, terminalGrowth, discountRate, netDebt, sharesOutstanding, years } = input;
  if (![fcf0, growth, terminalGrowth, discountRate, netDebt, sharesOutstanding].every(isNum)) return null;
  const r = discountRate as number;
  const gt = terminalGrowth as number;
  if (r <= gt || (sharesOutstanding as number) <= 0 || years < 1 || (fcf0 as number) <= 0) return null;
  let pvExplicit = 0;
  let fcf = fcf0 as number;
  for (let t = 1; t <= years; t++) {
    fcf = fcf * (1 + (growth as number));
    pvExplicit += fcf / Math.pow(1 + r, t);
  }
  const tv = (fcf * (1 + gt)) / (r - gt);
  const pvTerminal = tv / Math.pow(1 + r, years);
  const ev = pvExplicit + pvTerminal;
  const equity = ev - (netDebt as number);
  return {
    enterpriseValue: ev,
    equityValue: equity,
    valuePerShare: equity / (sharesOutstanding as number),
    pvExplicit,
    pvTerminal,
    terminalShare: pvTerminal / ev,
    formula: DCF_FORMULA,
  };
}

/** Sensitivity grid of DCF value per share to discount rate and growth. */
export function dcfSensitivity(base: DcfInput, rateSteps = [-0.01, 0, 0.01], growthSteps = [-0.02, 0, 0.02]) {
  if (!isNum(base.discountRate) || !isNum(base.growth)) return null;
  return rateSteps.map((dr) => ({
    discountRate: base.discountRate! + dr,
    values: growthSteps.map((dg) => ({
      growth: base.growth! + dg,
      valuePerShare: dcf({ ...base, discountRate: base.discountRate! + dr, growth: base.growth! + dg })?.valuePerShare ?? null,
    })),
  }));
}

/** Simple multiples. All return null when an input is missing or the denominator is non-positive. */
export const multiples = {
  pe: (price: Maybe, eps: Maybe) => (isNum(price) && isNum(eps) && eps > 0 ? price / eps : null),
  evToEbit: (ev: Maybe, ebit: Maybe) => (isNum(ev) && isNum(ebit) && ebit > 0 ? ev / ebit : null),
  evToEbitda: (ev: Maybe, ebitda: Maybe) => (isNum(ev) && isNum(ebitda) && ebitda > 0 ? ev / ebitda : null),
  fcfYield: (fcf: Maybe, marketCap: Maybe) => (isNum(fcf) && isNum(marketCap) && marketCap > 0 ? fcf / marketCap : null),
  enterpriseValue: (marketCap: Maybe, debt: Maybe, cash: Maybe) =>
    isNum(marketCap) && isNum(debt) && isNum(cash) ? marketCap + debt - cash : null,
};
