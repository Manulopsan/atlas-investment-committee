import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { CompanyProfile, CompanyRef, FactRecord, FrameRow, FundamentalsProvider, ReferenceDataProvider, Sourced } from "./types";
import { ProviderError } from "./types";

/**
 * SEC EDGAR public APIs (https://www.sec.gov/search-filings/edgar-application-programming-interfaces).
 * Fair-access rules: declared User-Agent with contact, ≤10 requests/second.
 * Responses are cached on disk to avoid repeated downloads.
 */
export const SEC_URLS = {
  tickers: "https://www.sec.gov/files/company_tickers_exchange.json",
  submissions: (cik: string) => `https://data.sec.gov/submissions/CIK${cik}.json`,
  companyFacts: (cik: string) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
  frame: (taxonomy: string, concept: string, unit: string, period: string) =>
    `https://data.sec.gov/api/xbrl/frames/${taxonomy}/${concept}/${unit}/${period}.json`,
  filingIndex: (cik: string, accession: string) =>
    `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${accession}-index.htm`,
  fullText: (q: string, forms?: string[], cik?: string) =>
    `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}${forms?.length ? `&forms=${encodeURIComponent(forms.join(","))}` : ""}${cik ? `&ciks=${cik}` : ""}`,
};

/** Metric key → candidate XBRL concepts (first match per fiscal year wins). */
export const CONCEPTS: Record<string, { concepts: string[]; unit: string; taxonomy?: string; instant?: boolean }> = {
  revenue: { concepts: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"], unit: "USD" },
  grossProfit: { concepts: ["GrossProfit"], unit: "USD" },
  operatingIncome: { concepts: ["OperatingIncomeLoss"], unit: "USD" },
  netIncome: { concepts: ["NetIncomeLoss"], unit: "USD" },
  pretaxIncome: { concepts: ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"], unit: "USD" },
  incomeTax: { concepts: ["IncomeTaxExpenseBenefit"], unit: "USD" },
  operatingCashFlow: { concepts: ["NetCashProvidedByUsedInOperatingActivities"], unit: "USD" },
  capex: { concepts: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"], unit: "USD" },
  dividendsPaid: { concepts: ["PaymentsOfDividendsCommonStock", "PaymentsOfDividends"], unit: "USD" },
  buybacks: { concepts: ["PaymentsForRepurchaseOfCommonStock"], unit: "USD" },
  acquisitions: { concepts: ["PaymentsToAcquireBusinessesNetOfCashAcquired"], unit: "USD" },
  stockComp: { concepts: ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"], unit: "USD" },
  dilutedShares: { concepts: ["WeightedAverageNumberOfDilutedSharesOutstanding"], unit: "shares" },
  epsDiluted: { concepts: ["EarningsPerShareDiluted"], unit: "USD/shares" },
  longTermDebt: { concepts: ["LongTermDebtNoncurrent", "LongTermDebt"], unit: "USD", instant: true },
  cash: { concepts: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"], unit: "USD", instant: true },
  equity: { concepts: ["StockholdersEquity"], unit: "USD", instant: true },
  sharesOutstanding: { concepts: ["EntityCommonStockSharesOutstanding"], unit: "shares", taxonomy: "dei", instant: true },
};

export const SCREEN_FRAMES = {
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues"],
  operatingIncome: ["OperatingIncomeLoss"],
  operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities"],
};

export interface SecOptions {
  userAgent: string;
  fetchImpl?: typeof fetch;
  cacheDir?: string | null;
  cacheTtlMs?: number;
  minIntervalMs?: number;
}

export function padCik(cik: string | number): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

function durationDays(start: string | null, end: string): number | null {
  if (!start) return null;
  return (Date.parse(end) - Date.parse(start)) / 86_400_000;
}

/** Pure parser: extracts annual (10-K, full-year) values from a companyfacts payload. */
export function parseAnnualFacts(json: unknown, cik: string): FactRecord[] {
  const facts = (json as { facts?: Record<string, Record<string, { units?: Record<string, unknown[]> }>> })?.facts ?? {};
  const out: FactRecord[] = [];
  for (const [key, def] of Object.entries(CONCEPTS)) {
    const tax = facts[def.taxonomy ?? "us-gaap"] ?? {};
    const byYear = new Map<number, FactRecord>();
    for (const concept of def.concepts) {
      const units = tax[concept]?.units?.[def.unit] as
        | { val: number; end: string; start?: string; form: string; fp?: string; filed: string; accn: string }[]
        | undefined;
      if (!units) continue;
      for (const u of units) {
        if (!u || typeof u.val !== "number" || !u.end) continue;
        const isAnnualForm = u.form === "10-K" || u.form === "10-K/A";
        if (!isAnnualForm && key !== "sharesOutstanding") continue;
        if (!def.instant) {
          const d = durationDays(u.start ?? null, u.end);
          if (d === null || d < 340 || d > 380) continue; // full fiscal year only, never quarters
        } else if (key !== "sharesOutstanding" && u.fp && u.fp !== "FY") {
          continue;
        }
        const fy = new Date(u.end).getUTCFullYear();
        const prev = byYear.get(fy);
        // Concept priority: keep the first concept that covers a year; within a concept, the latest filing (restated values).
        if (prev && prev.concept !== concept) continue;
        if (prev && prev.filed >= u.filed) continue;
        byYear.set(fy, {
          key,
          concept,
          value: u.val,
          unit: def.unit,
          fiscalYear: fy,
          periodEnd: u.end,
          periodStart: u.start ?? null,
          form: u.form,
          filed: u.filed,
          accession: u.accn,
          url: SEC_URLS.filingIndex(cik, u.accn),
        });
      }
    }
    out.push(...byYear.values());
  }
  return out;
}

export function parseTickers(json: unknown): CompanyRef[] {
  const j = json as { fields?: string[]; data?: unknown[][] };
  if (!j?.fields || !j.data) throw new ProviderError("sec", "Formato inesperado de company_tickers_exchange.json");
  const fi = (n: string) => j.fields!.indexOf(n);
  const [ci, ni, ti, ei] = [fi("cik"), fi("name"), fi("ticker"), fi("exchange")];
  return j.data
    .filter((r) => r[ti])
    .map((r) => ({ cik: padCik(r[ci] as number), name: String(r[ni]), ticker: String(r[ti]).toUpperCase(), exchange: (r[ei] as string) ?? null }));
}

export function parseFrame(json: unknown): FrameRow[] {
  const j = json as { data?: { cik: number; entityName: string; val: number; end: string; accn: string }[] };
  return (j?.data ?? []).filter((d) => typeof d.val === "number").map((d) => ({ cik: padCik(d.cik), entityName: d.entityName, value: d.val, periodEnd: d.end, accession: d.accn }));
}

export function parseSubmissions(json: unknown, cik: string): CompanyProfile {
  const j = json as {
    name?: string; tickers?: string[]; exchanges?: string[]; sic?: string; sicDescription?: string; fiscalYearEnd?: string;
    filings?: { recent?: { form: string[]; filingDate: string[]; reportDate: string[]; accessionNumber: string[]; primaryDocDescription?: string[] } };
  };
  const r = j.filings?.recent;
  const recent = r
    ? r.form.map((form, i) => ({ form, filingDate: r.filingDate[i], reportDate: r.reportDate[i] || null, accession: r.accessionNumber[i], url: SEC_URLS.filingIndex(cik, r.accessionNumber[i]), description: r.primaryDocDescription?.[i] ?? null }))
        .filter((f) => ["10-K", "10-Q", "8-K", "10-K/A", "DEF 14A", "S-1", "S-3"].includes(f.form))
        .slice(0, 25)
    : [];
  return {
    cik,
    name: j.name ?? "",
    tickers: j.tickers ?? [],
    exchanges: j.exchanges ?? [],
    sic: j.sic || null,
    sicDescription: j.sicDescription || null,
    fiscalYearEnd: j.fiscalYearEnd || null,
    recentFilings: recent,
  };
}

export class SecEdgarProvider implements ReferenceDataProvider, FundamentalsProvider {
  id = "sec-edgar";
  private last = 0;
  private mem = new Map<string, { at: number; body: unknown }>();
  constructor(private opts: SecOptions) {}

  private async getJson(url: string): Promise<{ body: unknown; retrievedAt: string }> {
    if (!this.opts.userAgent) {
      throw new ProviderError("sec", "SEC_USER_AGENT no configurado. La SEC exige un User-Agent con e-mail de contacto (ver .env.example).");
    }
    const ttl = this.opts.cacheTtlMs ?? 12 * 3600_000;
    const m = this.mem.get(url);
    if (m && Date.now() - m.at < ttl) return { body: m.body, retrievedAt: new Date(m.at).toISOString() };
    const cacheFile = this.opts.cacheDir ? path.join(this.opts.cacheDir, createHash("sha1").update(url).digest("hex") + ".json") : null;
    if (cacheFile && fs.existsSync(cacheFile)) {
      const st = fs.statSync(cacheFile);
      if (Date.now() - st.mtimeMs < ttl) {
        const body = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        this.mem.set(url, { at: st.mtimeMs, body });
        return { body, retrievedAt: new Date(st.mtimeMs).toISOString() };
      }
    }
    const wait = this.last + (this.opts.minIntervalMs ?? 150) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
    const f = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await f(url, { headers: { "User-Agent": this.opts.userAgent, Accept: "application/json" } });
    } catch (e) {
      throw new ProviderError("sec", `No se pudo conectar con ${url}: ${e instanceof Error ? e.message : e}`);
    }
    if (res.status === 404) throw new ProviderError("sec", `No encontrado: ${url}`);
    if (!res.ok) throw new ProviderError("sec", `HTTP ${res.status} en ${url}`);
    const body = await res.json();
    const now = Date.now();
    this.mem.set(url, { at: now, body });
    if (cacheFile) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(body));
    }
    return { body, retrievedAt: new Date(now).toISOString() };
  }

  async listCompanies(): Promise<Sourced<CompanyRef[]>> {
    const { body, retrievedAt } = await this.getJson(SEC_URLS.tickers);
    return { data: parseTickers(body), source: "SEC EDGAR company_tickers_exchange.json", url: SEC_URLS.tickers, retrievedAt };
  }

  async profile(cik: string): Promise<Sourced<CompanyProfile>> {
    const c = padCik(cik);
    const url = SEC_URLS.submissions(c);
    const { body, retrievedAt } = await this.getJson(url);
    return { data: parseSubmissions(body, c), source: "SEC EDGAR submissions API", url, retrievedAt };
  }

  async annualFacts(cik: string): Promise<Sourced<FactRecord[]>> {
    const c = padCik(cik);
    const url = SEC_URLS.companyFacts(c);
    const { body, retrievedAt } = await this.getJson(url);
    return { data: parseAnnualFacts(body, c), source: "SEC EDGAR XBRL companyfacts API (10-K)", url, retrievedAt };
  }

  async frame(concept: string, unit: string, period: string): Promise<Sourced<FrameRow[]>> {
    const url = SEC_URLS.frame("us-gaap", concept, unit, period);
    const { body, retrievedAt } = await this.getJson(url);
    return { data: parseFrame(body), source: `SEC EDGAR XBRL frames ${concept} ${period}`, url, retrievedAt };
  }

  async fullTextSearch(query: string, opts: { forms?: string[]; cik?: string } = {}) {
    const url = SEC_URLS.fullText(query, opts.forms, opts.cik);
    const { body, retrievedAt } = await this.getJson(url);
    const hits = ((body as { hits?: { hits?: { _id: string; _source: { display_names?: string[]; form?: string; file_date?: string; ciks?: string[]; adsh?: string } }[] } })?.hits?.hits ?? []).slice(0, 15);
    const data = hits.map((h) => {
      const cik = h._source.ciks?.[0] ?? "";
      const adsh = h._source.adsh ?? h._id.split(":")[0];
      const file = h._id.split(":")[1] ?? "";
      return {
        title: h._source.display_names?.[0] ?? "",
        form: h._source.form ?? "",
        filed: h._source.file_date ?? "",
        cik,
        url: cik && adsh ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${adsh.replace(/-/g, "")}/${file}` : "",
      };
    });
    return { data, source: "SEC EDGAR full-text search", url: url.replace("/LATEST/search-index", "/LATEST/search-index"), retrievedAt };
  }
}
