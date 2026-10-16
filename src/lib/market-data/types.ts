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
  recentFilings: { form: string; filingDate: string; reportDate: string | null; accession: string; url: string; description: string | null }[];
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
  annualFacts(cik: string): Promise<Sourced<FactRecord[]>>;
  /** Cross-sectional values of one concept for a calendar-year frame (e.g. CY2025). */
  frame(concept: string, unit: string, period: string): Promise<Sourced<FrameRow[]>>;
  fullTextSearch?(query: string, opts?: { forms?: string[]; cik?: string }): Promise<Sourced<{ title: string; form: string; filed: string; url: string; cik: string }[]>>;
}

export interface PriceProvider {
  id: string;
  quote(ticker: string): Promise<Quote | null>;
}

export interface FxProvider {
  id: string;
  usdPerEur(): Promise<FxRate | null>;
}

export interface MarketData {
  synthetic: boolean;
  reference: ReferenceDataProvider;
  fundamentals: FundamentalsProvider;
  prices: PriceProvider[];
  fx: FxProvider | null;
}

export class ProviderError extends Error {
  constructor(public provider: string, msg: string) {
    super(`[${provider}] ${msg}`);
    this.name = "ProviderError";
  }
}
