import type { PriceKind } from "../evidence/registry";

/**
 * Provider interfaces. Every value returned carries its origin and retrieval
 * time; missing values are `null`, never zero. Providers can be swapped
 * without touching the orchestrator.
 */
export interface CompanyRef {
  ticker: string;
  cik: string; // zero-padded 10 digits
  name: string;
  exchange: string | null;
}

export interface Sourced<T> {
  data: T;
  source: string;
  url: string;
  retrievedAt: string;
}

export interface CompanyProfile {
  cik: string;
  name: string;
  tickers: string[];
  exchanges: string[];
  sic: string | null;
  sicDescription: string | null;
  fiscalYearEnd: string | null;
  recentFilings: { form: string; filingDate: string; reportDate: string | null; accession: string; url: string; documentUrl: string | null; description: string | null }[];
}

export interface FactRecord {
  key: string; // internal metric key (revenue, operatingIncome…)
  concept: string; // XBRL concept used
  value: number;
  unit: string;
  fiscalYear: number; // derived from period end date
  periodEnd: string;
  periodStart: string | null;
  form: string;
  filed: string;
  accession: string;
  url: string;
}

export interface FrameRow {
  cik: string;
  entityName: string;
  value: number;
  periodEnd: string;
  accession: string;
}

export interface Quote {
  ticker: string;
  price: number;
  currency: "USD";
  /** Date (and time when known) of the quote, ISO-8601. */
  asOf: string;
  kind: PriceKind;
  delayNote: string;
  source: string;
  /** Public URL with any API key removed. */
  url: string;
  retrievedAt: string;
}

export interface FxRate {
  pair: "EURUSD";
  /** USD per 1 EUR. */
  usdPerEur: number;
  date: string;
  source: string;
  url: string;
  retrievedAt: string;
}

export interface ReferenceDataProvider {
  id: string;
  listCompanies(): Promise<Sourced<CompanyRef[]>>;
  profile(cik: string): Promise<Sourced<CompanyProfile>>;
}

export interface FundamentalsProvider {
  id: string;
  /** Annual 10-K facts; with `asOf`, only filings filed on or before that date (latest such filing wins). */
  annualFacts(cik: string, opts?: { asOf?: string | null }): Promise<Sourced<FactRecord[]>>;
  /** Cross-sectional values of one concept for a calendar-year frame (e.g. CY2025). */
  frame(concept: string, unit: string, period: string): Promise<Sourced<FrameRow[]>>;
  /** Raw HTML of a filing document (primary document of a 10-K/10-Q). */
  filingDocument?(url: string): Promise<Sourced<string>>;
  fullTextSearch?(query: string, opts?: { forms?: string[]; cik?: string }): Promise<Sourced<{ title: string; form: string; filed: string; url: string; cik: string }[]>>;
}

export interface PriceProvider {
  id: string;
  quote(ticker: string): Promise<Quote | null>;
}

export interface FxProvider {
  id: string;
  usdPerEur(): Promise<FxRate | null>;
  /** Reference rate on (or the last business day before) a date — point-in-time mode. */
  usdPerEurOn?(date: string): Promise<FxRate | null>;
}

export interface PricePoint {
  date: string; // YYYY-MM-DD
  close: number; // unadjusted (or split-adjusted, see `adjustment`)
  totalReturnClose?: number | null; // adjusted for splits and dividends, when the source provides it
}

export interface PriceHistory {
  ticker: string;
  points: PricePoint[]; // ascending by date
  adjustment: "splits" | "none" | "unknown";
  frequency: "daily" | "monthly";
  source: string;
  url: string; // public URL, API keys removed
  retrievedAt: string;
  note: string;
}

export interface PriceHistoryProvider {
  id: string;
  history(ticker: string): Promise<PriceHistory | null>;
}

/** Last point on or before a date, within a tolerance window (days). */
export function pointOnOrBefore(h: PriceHistory, date: string, maxGapDays = 10): PricePoint | null {
  const t = Date.parse(date);
  let best: PricePoint | null = null;
  for (const p of h.points) {
    const d = Date.parse(p.date);
    if (d <= t) best = p;
    else break;
  }
  if (!best) return null;
  return (t - Date.parse(best.date)) / 86_400_000 <= maxGapDays ? best : null;
}

export interface MarketData {
  synthetic: boolean;
  reference: ReferenceDataProvider;
  fundamentals: FundamentalsProvider;
  prices: PriceProvider[];
  history: PriceHistoryProvider[];
  fx: FxProvider | null;
  /** Point-in-time mode: only information available on this date (YYYY-MM-DD). */
  asOf?: string | null;
}

export class ProviderError extends Error {
  constructor(public provider: string, msg: string) {
    super(`[${provider}] ${msg}`);
    this.name = "ProviderError";
  }
}
