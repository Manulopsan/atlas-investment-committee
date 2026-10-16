/**
 * Deterministic return mathematics. Nothing here depends on the AI model:
 * agents provide assumptions, these functions compute the numbers shown to the
 * user. Every function returns `null` instead of a misleading number when the
 * inputs are missing or invalid (missing data is never treated as zero).
 */

export type Maybe = number | null | undefined;

export function isNum(x: Maybe): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** CAGR = (final / entry)^(1/years) − 1, for a single terminal value and no interim flows. */
export function cagr(finalValue: Maybe, entryPrice: Maybe, years: Maybe): number | null {
  if (!isNum(finalValue) || !isNum(entryPrice) || !isNum(years)) return null;
  if (entryPrice <= 0 || years <= 0 || finalValue < 0) return null;
  return Math.pow(finalValue / entryPrice, 1 / years) - 1;
}

export interface TotalReturnInput {
  entryPrice: Maybe;
  endPrice: Maybe;
  /** Cumulative dividends per share received over the horizon (not reinvested). */
  dividendsPerShare: Maybe;
  years: Maybe;
}

export interface TotalReturnOutput {
  /** Price-only cumulative return. */
  priceReturn: number;
  /** Cumulative dividend yield on entry price. */
  dividendReturn: number;
  /** priceReturn + dividendReturn (dividends counted exactly once). */
  totalReturn: number;
  priceCagr: number;
  totalCagr: number;
  /** totalCagr − priceCagr: the annualised contribution of dividends. */
  dividendCagrContribution: number;
  methodology: string;
}

export const TOTAL_RETURN_METHOD =
  "Rentabilidad total = (precio final + dividendos acumulados por acción − precio de entrada) / precio de entrada. " +
  "Los dividendos se suman una sola vez, sin reinversión. CAGR total = ((precio final + dividendos) / entrada)^(1/años) − 1. " +
  "La contribución anualizada de dividendos es CAGR total − CAGR de precio.";

export function totalReturn(input: TotalReturnInput): TotalReturnOutput | null {
  const { entryPrice, endPrice, years } = input;
  if (!isNum(entryPrice) || !isNum(endPrice) || !isNum(years) || entryPrice <= 0 || years <= 0 || endPrice < 0) return null;
  // Unknown dividends are NOT assumed to be zero.
  if (input.dividendsPerShare === undefined || input.dividendsPerShare === null) return null;
  if (!isNum(input.dividendsPerShare) || input.dividendsPerShare < 0) return null;
  const divs = input.dividendsPerShare;
  const priceReturn = endPrice / entryPrice - 1;
  const dividendReturn = divs / entryPrice;
  const priceCagr = cagr(endPrice, entryPrice, years)!;
  const totalCagr = cagr(endPrice + divs, entryPrice, years)!;
  return {
    priceReturn,
    dividendReturn,
    totalReturn: priceReturn + dividendReturn,
    priceCagr,
    totalCagr,
    dividendCagrContribution: totalCagr - priceCagr,
    methodology: TOTAL_RETURN_METHOD,
  };
}

/**
 * Highest entry price at which (end value + dividends) still compounds at the
 * target rate: P_max = (V_N + D) / (1 + target)^N.
 */
export function maxPriceForTarget(endValue: Maybe, dividendsPerShare: Maybe, targetAnnual: Maybe, years: Maybe): number | null {
  if (!isNum(endValue) || !isNum(dividendsPerShare) || !isNum(targetAnnual) || !isNum(years)) return null;
  if (endValue < 0 || dividendsPerShare < 0 || years <= 0 || targetAnnual <= -1) return null;
  return (endValue + dividendsPerShare) / Math.pow(1 + targetAnnual, years);
}

/** Margin of safety = (fair value − price) / fair value. Negative means price above fair value. */
export function marginOfSafety(fairValue: Maybe, price: Maybe): number | null {
  if (!isNum(fairValue) || !isNum(price) || fairValue <= 0 || price <= 0) return null;
  return (fairValue - price) / fairValue;
}

/** Present value of a single future amount. */
export function presentValue(future: Maybe, rate: Maybe, years: Maybe): number | null {
  if (!isNum(future) || !isNum(rate) || !isNum(years) || rate <= -1 || years < 0) return null;
  return future / Math.pow(1 + rate, years);
}

/**
 * Proposed entry price: the lower of (a) the price that still reaches the
 * target in the base case and (b) the central fair value less the required
 * margin of safety.
 */
export function proposedEntryPrice(fairValueCentral: Maybe, requiredMos: Maybe, maxPrice: Maybe): number | null {
  if (!isNum(fairValueCentral) || !isNum(requiredMos) || !isNum(maxPrice)) return null;
  if (fairValueCentral <= 0 || maxPrice <= 0 || requiredMos < 0 || requiredMos >= 1) return null;
  return Math.min(fairValueCentral * (1 - requiredMos), maxPrice);
}

/**
 * FX: rates are quoted as USD per 1 EUR (ECB EUR/USD reference rate).
 * EUR amount = USD amount / (USD per EUR).
 */
export function usdToEur(usd: Maybe, usdPerEur: Maybe): number | null {
  if (!isNum(usd) || !isNum(usdPerEur) || usdPerEur <= 0) return null;
  return usd / usdPerEur;
}

export function eurToUsd(eur: Maybe, usdPerEur: Maybe): number | null {
  if (!isNum(eur) || !isNum(usdPerEur) || usdPerEur <= 0) return null;
  return eur * usdPerEur;
}

/**
 * Approximate annualised return for a EUR-based investor in a USD asset:
 * (1 + R_eur)^N = (1 + R_usd)^N × (fx_start / fx_end), fx in USD per EUR.
 * A stronger euro at the end (higher fx_end) reduces the EUR return.
 */
export function eurCagr(usdCagr: Maybe, years: Maybe, fxStart: Maybe, fxEnd: Maybe): number | null {
  if (!isNum(usdCagr) || !isNum(years) || !isNum(fxStart) || !isNum(fxEnd)) return null;
  if (years <= 0 || fxStart <= 0 || fxEnd <= 0 || usdCagr <= -1) return null;
  return Math.pow(Math.pow(1 + usdCagr, years) * (fxStart / fxEnd), 1 / years) - 1;
}

/** EUR returns under constant FX and ±shock moves of the euro. */
export function fxSensitivity(usdCagr: Maybe, years: Maybe, fxStart: Maybe, shocks = [-0.1, 0, 0.1]) {
  if (!isNum(fxStart)) return null;
  return shocks.map((s) => ({
    eurMove: s,
    fxEnd: fxStart * (1 + s),
    eurCagr: eurCagr(usdCagr, years, fxStart, fxStart * (1 + s)),
  }));
}

export function round(x: Maybe, digits = 2): number | null {
  if (!isNum(x)) return null;
  const f = Math.pow(10, digits);
  return Math.round(x * f) / f;
}

export function pct(x: Maybe, digits = 1): string {
  return isNum(x) ? `${(x * 100).toFixed(digits)}%` : "n/d";
}
