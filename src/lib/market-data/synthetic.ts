import type { CompanyProfile, CompanyRef, FactRecord, FrameRow, FundamentalsProvider, FxProvider, MarketData, PriceHistory, PriceHistoryProvider, PricePoint, PriceProvider, Quote, ReferenceDataProvider, Sourced } from "./types";

/**
 * SYNTHETIC DEMO DATA. Fictitious companies with "DEMO-" tickers (the hyphen
 * avoids any collision with real symbols). Used only in demo mode and tests;
 * never mixed with live sessions. Every record is labelled synthetic.
 */
export const SYNTHETIC_SOURCE = "DATOS SINTÉTICOS (DEMO) — no son datos reales";
export const SYNTHETIC_URL = (p: string) => `synthetic://demo/${p}`;

interface SynCompany {
  ticker: string;
  name: string;
  sic: string;
  sicDescription: string;
  revenue0: number; // FY base revenue (USD)
  growth: number;
  grossMargin: number;
  opMargin: number;
  ocfMargin: number;
  capexPct: number;
  shares: number;
  debt: number;
  cash: number;
  equity: number;
  payout: number;
  price: number;
}

export const SYN_COMPANIES: SynCompany[] = [
  { ticker: "DEMO-A", name: "Demo Alpha Instruments (SINTÉTICO)", sic: "3823", sicDescription: "Industrial Instruments", revenue0: 4.2e9, growth: 0.09, grossMargin: 0.58, opMargin: 0.24, ocfMargin: 0.26, capexPct: 0.04, shares: 210e6, debt: 1.1e9, cash: 0.9e9, equity: 5.5e9, payout: 0.25, price: 70 },
  { ticker: "DEMO-B", name: "Demo Beta Software (SINTÉTICO)", sic: "7372", sicDescription: "Prepackaged Software", revenue0: 6.0e9, growth: 0.14, grossMargin: 0.8, opMargin: 0.3, ocfMargin: 0.36, capexPct: 0.03, shares: 300e6, debt: 2.0e9, cash: 3.0e9, equity: 8.0e9, payout: 0, price: 310 },
  { ticker: "DEMO-C", name: "Demo Gamma Chemicals (SINTÉTICO)", sic: "2860", sicDescription: "Industrial Organic Chemicals", revenue0: 3.1e9, growth: 0.03, grossMargin: 0.3, opMargin: 0.12, ocfMargin: 0.14, capexPct: 0.07, shares: 120e6, debt: 4.5e9, cash: 0.2e9, equity: 1.0e9, payout: 0.5, price: 28 },
  { ticker: "DEMO-D", name: "Demo Delta Retail (SINTÉTICO)", sic: "5331", sicDescription: "Variety Stores", revenue0: 9.0e9, growth: -0.02, grossMargin: 0.22, opMargin: 0.03, ocfMargin: 0.05, capexPct: 0.03, shares: 400e6, debt: 2.5e9, cash: 0.4e9, equity: 2.0e9, payout: 0.6, price: 6.5 },
  { ticker: "DEMO-E", name: "Demo Epsilon Medical (SINTÉTICO)", sic: "3841", sicDescription: "Surgical & Medical Instruments", revenue0: 2.4e9, growth: 0.08, grossMargin: 0.62, opMargin: 0.2, ocfMargin: 0.22, capexPct: 0.05, shares: 95e6, debt: 0.8e9, cash: 0.5e9, equity: 2.8e9, payout: 0.2, price: 80 },
  { ticker: "DEMO-F", name: "Demo Phi Logistics (SINTÉTICO)", sic: "4731", sicDescription: "Arrangement of Transportation", revenue0: 1.2e9, growth: 0.12, grossMargin: 0.35, opMargin: 0.15, ocfMargin: 0.16, capexPct: 0.06, shares: 60e6, debt: 0.3e9, cash: 0.25e9, equity: 0.9e9, payout: 0.15, price: 41 },
  { ticker: "DEMO-BK", name: "Demo Kappa Bancorp (SINTÉTICO)", sic: "6022", sicDescription: "State Commercial Banks", revenue0: 2.0e9, growth: 0.04, grossMargin: 1, opMargin: 0.35, ocfMargin: 0.3, capexPct: 0.01, shares: 150e6, debt: 1.0e9, cash: 5.0e9, equity: 3.0e9, payout: 0.4, price: 33 },
];

export const SYN_FX = { usdPerEur: 1.1, date: "2026-01-02" };
const LAST_FY = 2025;

function synFacts(c: SynCompany): FactRecord[] {
  const out: FactRecord[] = [];
  const cik = synCik(c.ticker);
  for (let k = 5; k >= 0; k--) {
    const fy = LAST_FY - k;
    const rev = c.revenue0 / Math.pow(1 + c.growth, k);
    const op = rev * c.opMargin;
    const ni = op * 0.78;
    const shares = c.shares * (1 + 0.004 * k);
    const vals: Record<string, number> = {
      revenue: rev, grossProfit: rev * c.grossMargin, operatingIncome: op, netIncome: ni,
      pretaxIncome: op * 0.98, incomeTax: op * 0.98 * 0.21, operatingCashFlow: rev * c.ocfMargin, capex: rev * c.capexPct,
      dividendsPaid: ni * c.payout, buybacks: ni * 0.1, stockComp: rev * 0.02, dilutedShares: shares, epsDiluted: ni / shares,
      longTermDebt: c.debt, cash: c.cash, equity: c.equity / Math.pow(1.05, k),
    };
    for (const [key, value] of Object.entries(vals)) {
      out.push({
        key, concept: `synthetic:${key}`, value: Math.round(value * 100) / 100,
        unit: key === "dilutedShares" ? "shares" : key === "epsDiluted" ? "USD/shares" : "USD",
        fiscalYear: fy, periodEnd: `${fy}-12-31`, periodStart: `${fy}-01-01`, form: "10-K (SINTÉTICO)",
        filed: `${fy + 1}-02-20`, accession: `SYN-${c.ticker}-${fy}`, url: SYNTHETIC_URL(`${cik}/${fy}`),
      });
    }
  }
  return out;
}

export function synCik(ticker: string) {
  return String(9_000_000_000 + SYN_COMPANIES.findIndex((c) => c.ticker === ticker));
}

const now = () => new Date().toISOString();
const wrap = <T>(data: T, p: string): Sourced<T> => ({ data, source: SYNTHETIC_SOURCE, url: SYNTHETIC_URL(p), retrievedAt: now() });

export class SyntheticProvider implements ReferenceDataProvider, FundamentalsProvider {
  id = "synthetic-demo";
  async listCompanies(): Promise<Sourced<CompanyRef[]>> {
    return wrap(SYN_COMPANIES.map((c) => ({ ticker: c.ticker, cik: synCik(c.ticker), name: c.name, exchange: "DEMO" })), "tickers");
  }
  async profile(cik: string): Promise<Sourced<CompanyProfile>> {
    const c = SYN_COMPANIES.find((x) => synCik(x.ticker) === cik);
    if (!c) throw new Error("Empresa sintética no encontrada");
    return wrap({
      cik, name: c.name, tickers: [c.ticker], exchanges: ["DEMO"], sic: c.sic, sicDescription: c.sicDescription, fiscalYearEnd: "1231",
      recentFilings: [{ form: "10-K", filingDate: `${LAST_FY + 1}-02-20`, reportDate: `${LAST_FY}-12-31`, accession: `SYN-${c.ticker}-${LAST_FY}`, url: SYNTHETIC_URL(`${cik}/${LAST_FY}`), documentUrl: SYNTHETIC_URL(`doc/${c.ticker}/${LAST_FY}`), description: "Informe anual ficticio (SINTÉTICO)" }],
    }, `profile/${cik}`);
  }
  async annualFacts(cik: string, opts: { asOf?: string | null } = {}): Promise<Sourced<FactRecord[]>> {
    const c = SYN_COMPANIES.find((x) => synCik(x.ticker) === cik);
    if (!c) throw new Error("Empresa sintética no encontrada");
    return wrap(synFacts(c).filter((f) => !opts.asOf || f.filed <= opts.asOf), `facts/${cik}`);
  }
  async filingDocument(url: string): Promise<Sourced<string>> {
    const t = /doc\/([^/]+)\//.exec(url)?.[1];
    const c = SYN_COMPANIES.find((x) => x.ticker === t);
    if (!c) throw new Error("Documento sintético no encontrado");
    const lev = c.debt / Math.max(c.revenue0 * c.opMargin, 1);
    const html = `<html><body><p>TABLE OF CONTENTS</p><p>Item 1. Business</p><p>Item 1A. Risk Factors</p><p>Item 7. Management's Discussion and Analysis</p><hr/>
<p>Item 1. Business</p><p>[SINTÉTICO] ${c.name} opera en ${c.sicDescription}. Este documento es ficticio y solo sirve para la demostración.</p><hr/>
<p>Item 1A. Risk Factors</p>
<p>[SINTÉTICO] Our indebtedness could adversely affect our financial condition; total long-term debt is ${(c.debt / 1e9).toFixed(1)} billion, about ${lev.toFixed(1)} times operating income.</p>
<p>[SINTÉTICO] We depend on a limited number of customers; the loss of a major customer could reduce revenue and margins.</p>
<p>[SINTÉTICO] Competition, including new products based on artificial intelligence, could pressure our pricing power.</p><hr/>
<p>Item 7. Management's Discussion and Analysis of Financial Condition and Results of Operations</p>
<p>[SINTÉTICO] Revenue grew ${(c.growth * 100).toFixed(0)}% and operating margin was ${(c.opMargin * 100).toFixed(0)}% in fiscal ${LAST_FY}.</p>
<p>[SINTÉTICO] Free cash flow conversion remained stable; capital expenditures were ${(c.capexPct * 100).toFixed(0)}% of revenue.</p>
<p>Item 8. Financial Statements</p><p>[SINTÉTICO] Ver datos XBRL sintéticos.</p></body></html>`;
    return wrap(html, `doc/${c.ticker}`);
  }

  async frame(concept: string, _unit: string, period: string): Promise<Sourced<FrameRow[]>> {
    const fy = Number(period.replace("CY", ""));
    const key = concept.includes("Revenue") ? "revenue" : concept.includes("Operating") && concept.includes("Income") ? "operatingIncome" : concept.includes("CashProvided") ? "operatingCashFlow" : null;
    const rows: FrameRow[] = [];
    if (key) {
      for (const c of SYN_COMPANIES) {
        const f = synFacts(c).find((x) => x.key === key && x.fiscalYear === fy);
        if (f) rows.push({ cik: synCik(c.ticker), entityName: c.name, value: f.value, periodEnd: f.periodEnd, accession: f.accession });
      }
    }
    return wrap(rows, `frames/${concept}/${period}`);
  }
}

export class SyntheticPriceProvider implements PriceProvider {
  id = "synthetic-demo";
  async quote(ticker: string): Promise<Quote | null> {
    const c = SYN_COMPANIES.find((x) => x.ticker === ticker);
    if (!c) return null;
    return { ticker, price: c.price, currency: "USD", asOf: "2026-01-02T16:00:00", kind: "CLOSE", delayNote: "Precio sintético de demostración", source: SYNTHETIC_SOURCE, url: SYNTHETIC_URL(`price/${ticker}`), retrievedAt: now() };
  }
}

export class SyntheticFxProvider implements FxProvider {
  id = "synthetic-demo";
  async usdPerEur() {
    return { pair: "EURUSD" as const, usdPerEur: SYN_FX.usdPerEur, date: SYN_FX.date, source: SYNTHETIC_SOURCE, url: SYNTHETIC_URL("fx"), retrievedAt: now() };
  }
  async usdPerEurOn(date: string) {
    return { pair: "EURUSD" as const, usdPerEur: 1.15, date, source: SYNTHETIC_SOURCE, url: SYNTHETIC_URL(`fx/${date}`), retrievedAt: now() };
  }
}

/**
 * Synthetic monthly prices 2015-01 … 2026-09 that end at the demo price and
 * grow roughly with each company's revenue growth, plus a deterministic wobble.
 */
export function syntheticHistory(ticker: string): PriceHistory | null {
  const c = SYN_COMPANIES.find((x) => x.ticker === ticker);
  if (!c) return null;
  const points: PricePoint[] = [];
  const end = new Date(Date.UTC(2026, 8, 30));
  const seed = ticker.split("").reduce((a, ch) => a + ch.charCodeAt(0), 0);
  for (let m = 0; m <= 140; m++) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - m + 1, 0));
    const yearsBack = m / 12;
    const wobble = 1 + 0.12 * Math.sin((m + seed) / 5);
    const close = Math.round((c.price / Math.pow(1 + c.growth * 0.9, yearsBack)) * wobble * 100) / 100;
    const divYield = (c.payout * c.opMargin * 0.78 * c.revenue0) / c.shares / c.price;
    points.push({ date: d.toISOString().slice(0, 10), close, totalReturnClose: Math.round(close * Math.pow(1 + divYield, -yearsBack) * 100) / 100 });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  return { ticker, points, adjustment: "splits", frequency: "monthly", source: SYNTHETIC_SOURCE, url: SYNTHETIC_URL(`history/${ticker}`), retrievedAt: now(), note: "Serie de precios sintética de demostración" };
}

export class SyntheticHistoryProvider implements PriceHistoryProvider {
  id = "synthetic-demo-history";
  async history(ticker: string) {
    return syntheticHistory(ticker);
  }
}

export function syntheticMarketData(): MarketData {
  const p = new SyntheticProvider();
  return { synthetic: true, reference: p, fundamentals: p, prices: [new SyntheticPriceProvider()], history: [new SyntheticHistoryProvider()], fx: new SyntheticFxProvider() };
}
