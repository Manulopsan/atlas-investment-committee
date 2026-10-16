import type { CompanyProfile, CompanyRef, FactRecord, FrameRow, FundamentalsProvider, FxProvider, MarketData, PriceProvider, Quote, ReferenceDataProvider, Sourced } from "./types";

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
      recentFilings: [{ form: "10-K (SINTÉTICO)", filingDate: `${LAST_FY + 1}-02-20`, reportDate: `${LAST_FY}-12-31`, accession: `SYN-${c.ticker}-${LAST_FY}`, url: SYNTHETIC_URL(`${cik}/${LAST_FY}`), description: "Informe anual ficticio" }],
    }, `profile/${cik}`);
  }
  async annualFacts(cik: string): Promise<Sourced<FactRecord[]>> {
    const c = SYN_COMPANIES.find((x) => synCik(x.ticker) === cik);
    if (!c) throw new Error("Empresa sintética no encontrada");
    return wrap(synFacts(c), `facts/${cik}`);
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
}

export function syntheticMarketData(): MarketData {
  const p = new SyntheticProvider();
  return { synthetic: true, reference: p, fundamentals: p, prices: [new SyntheticPriceProvider()], fx: new SyntheticFxProvider() };
}
