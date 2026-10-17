import { screeningCriteria, ScreeningCriteriaSchema, type InvestmentConfig, type ScreeningCriteria } from "../config";
import type { CandidateRow, CoverageInfo } from "../db/repo";
import { classifySic, EXCLUSION_LABELS } from "./index";
import { SCREEN_FRAMES } from "./sec";
import type { CompanyRef, FrameRow, MarketData } from "./types";

/**
 * Candidate discovery (deterministic, no AI):
 *  1. List SEC-registered tickers with their exchange.
 *  2. Pull cross-sectional XBRL "frames" (one request per concept/year) for
 *     revenue, operating income and operating cash flow.
 *  3. Join market capitalisations (market-wide snapshot) to filter by cap
 *     segment and compute valuation yields (FCF yield, EBIT yield).
 *  4. Apply the configurable hard filters and rank by a weighted percentile
 *     composite of quality (margins, growth) and valuation (yields).
 *  5. Fetch SIC codes for the top of the list to apply sector exclusions.
 *  6. Merge user-imported tickers.
 * Coverage is reported honestly: frames only include filers that tagged the
 * concept for that calendar-year frame, so the universe is PARTIAL.
 */
export interface DiscoveryResult {
  candidates: CandidateRow[];
  coverage: CoverageInfo;
  log: string[];
}

export interface ScreenRow {
  cik: string;
  revenue: number | null;
  revenue3yAgo: number | null;
  operatingIncome: number | null;
  operatingCashFlow: number | null;
  capex: number | null;
  opMargin: number | null;
  ocfMargin: number | null;
  revenueCagr3y: number | null;
  /** Market capitalisation (USD) from the market snapshot, when available. */
  marketCap: number | null;
  capSegment: "large" | "mid" | "small" | "micro" | null;
  /** (operating cash flow − capex) / market cap. */
  fcfYield: number | null;
  /** Operating income / market cap (EBIT yield, before net debt). */
  earningsYield: number | null;
  screenScore: number | null;
  /** Why the row did not pass the hard filters (null when it passed). */
  rejectedBy: string | null;
  frameYear: number;
}

/** Market data joined to SEC rows by CIK (primary listing). */
export type CapsByCik = Map<string, { marketCap: number; capSegment: ScreenRow["capSegment"] }>;

function percentileRank(values: number[]): (v: number) => number {
  const sorted = [...values].sort((a, b) => a - b);
  return (v: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return sorted.length > 1 ? lo / (sorted.length - 1) : 1;
  };
}

const METRICS = [
  { key: "opMargin", weight: "operatingMargin" },
  { key: "ocfMargin", weight: "ocfMargin" },
  { key: "revenueCagr3y", weight: "revenueGrowth" },
  { key: "fcfYield", weight: "fcfYield" },
  { key: "earningsYield", weight: "earningsYield" },
] as const;

/**
 * Pure screening function — exported for tests.
 * Hard filters first (size, margins, growth range and, with market caps, a
 * minimum FCF yield); the survivors are ranked by a weighted average of
 * percentile ranks. Missing data is never imputed into the stored metrics;
 * for the ranking only, a metric a row lacks counts as the median.
 */
export function screen(
  frames: { revenue: FrameRow[]; revenueOld: FrameRow[]; operatingIncome: FrameRow[]; operatingCashFlow: FrameRow[]; capex?: FrameRow[] },
  frameYear: number,
  criteria: ScreeningCriteria = ScreeningCriteriaSchema.parse({}),
  caps: CapsByCik | null = null,
): ScreenRow[] {
  const by = (rows: FrameRow[]) => new Map(rows.map((r) => [r.cik, r.value]));
  const rev = by(frames.revenue);
  const old = by(frames.revenueOld);
  const op = by(frames.operatingIncome);
  const ocf = by(frames.operatingCashFlow);
  const capex = by(frames.capex ?? []);
  const rows: ScreenRow[] = [];
  for (const [cik, r] of rev) {
    if (!(r > 0)) continue;
    const o = op.get(cik) ?? null;
    const c = ocf.get(cik) ?? null;
    const k = capex.get(cik) ?? null;
    const r0 = old.get(cik) ?? null;
    const cap = caps?.get(cik) ?? null;
    const mc = cap?.marketCap ?? null;
    const fcf = c !== null && k !== null ? c - Math.abs(k) : null;
    rows.push({
      cik,
      revenue: r,
      revenue3yAgo: r0,
      operatingIncome: o,
      operatingCashFlow: c,
      capex: k,
      opMargin: o !== null ? o / r : null,
      ocfMargin: c !== null ? c / r : null,
      revenueCagr3y: r0 !== null && r0 > 0 ? Math.pow(r / r0, 1 / 3) - 1 : null,
      marketCap: mc,
      capSegment: cap?.capSegment ?? null,
      fcfYield: mc && fcf !== null ? fcf / mc : null,
      earningsYield: mc && o !== null ? o / mc : null,
      screenScore: null,
      rejectedBy: null,
      frameYear,
    });
  }
  const C = criteria;
  for (const x of rows) {
    x.rejectedBy =
      x.revenue! < C.minRevenueUsd ? "ingresos" :
      x.opMargin === null || x.ocfMargin === null || x.revenueCagr3y === null ? "datos incompletos" :
      // A margin above 100 % means the tagged revenue is only part of the total: the data are not comparable.
      x.opMargin > 1 || x.ocfMargin > 1.5 ? "datos incoherentes" :
      x.opMargin < C.minOperatingMargin ? "margen operativo" :
      x.ocfMargin < C.minOcfMargin ? "margen de flujo operativo" :
      x.revenueCagr3y < C.minRevenueCagr3y || x.revenueCagr3y >= C.maxRevenueCagr3y ? "crecimiento de ingresos" :
      caps && x.marketCap === null ? "sin capitalización de mercado" :
      caps && x.fcfYield !== null && x.fcfYield < C.minFcfYield ? "rentabilidad FCF" :
      null;
  }
  const passing = rows.filter((x) => !x.rejectedBy);
  const ranks = Object.fromEntries(
    METRICS.map((m) => [m.key, percentileRank(passing.map((x) => x[m.key]).filter((v): v is number => v !== null))]),
  ) as Record<(typeof METRICS)[number]["key"], (v: number) => number>;
  for (const x of passing) {
    let num = 0;
    let den = 0;
    for (const m of METRICS) {
      const w = C.weights[m.weight];
      if (!w) continue;
      const v = x[m.key];
      // A missing metric counts as the median (neutral): lacking data must not lift a company up the ranking.
      num += w * (v === null ? 0.5 : ranks[m.key](v));
      den += w;
    }
    x.screenScore = den > 0 ? Math.round((num / den) * 1000) / 10 : null;
  }
  return rows.sort((a, b) => (b.screenScore ?? -1) - (a.screenScore ?? -1));
}

/** Market caps for the SEC universe (joined by ticker → CIK) and their capitalisation segment. */
async function marketCaps(md: MarketData, config: InvestmentConfig, byCik: Map<string, CompanyRef>, log: string[], sources: string[], limitations: string[]): Promise<CapsByCik | null> {
  if (!md.snapshot) return null;
  try {
    const snap = await md.snapshot.snapshot();
    const byTicker = new Map(snap.data.map((r) => [r.ticker, r.marketCap]));
    const segment = (mc: number): ScreenRow["capSegment"] =>
      mc >= config.largeCapMinUsd ? "large" : mc >= config.midCapMinUsd ? "mid" : mc >= config.smallCapMinUsd ? "small" : "micro";
    const caps: CapsByCik = new Map();
    for (const [cik, ref] of byCik) {
      const mc = byTicker.get(ref.ticker.toUpperCase());
      if (mc) caps.set(cik, { marketCap: mc, capSegment: segment(mc) });
    }
    sources.push(snap.url);
    log.push(`Capitalizaciones de mercado: ${snap.data.length} valores en el screener; ${caps.size} enlazados con emisores de la SEC`);
    return caps.size ? caps : null;
  } catch (e) {
    log.push(`Screener de mercado no disponible: ${e instanceof Error ? e.message : e}`);
    limitations.push("Capitalizaciones de mercado no disponibles: el cribado no usa valoración ni segmento por capitalización.");
    return null;
  }
}

/**
 * One value per company across alternative XBRL concepts. "first": the first
 * concept a company reports wins (concepts in order of preference). "max": the
 * largest value wins — used for revenue, where some filers tag only a part of
 * their revenue (e.g. contract revenue without rental income) under the
 * preferred concept.
 */
async function firstFrame(md: MarketData, concepts: string[], unit: string, year: number, log: string[], pick: "first" | "max" = "first"): Promise<FrameRow[]> {
  const merged = new Map<string, FrameRow>();
  for (const c of concepts) {
    try {
      const f = await md.fundamentals.frame(c, unit, `CY${year}`);
      for (const r of f.data) {
        const cur = merged.get(r.cik);
        if (!cur || (pick === "max" && r.value > cur.value)) merged.set(r.cik, r);
      }
      log.push(`Frame ${c} CY${year}: ${f.data.length} filas (${f.url})`);
    } catch (e) {
      log.push(`Frame ${c} CY${year} no disponible: ${e instanceof Error ? e.message : e}`);
    }
  }
  return [...merged.values()];
}

export async function discoverCandidates(md: MarketData, config: InvestmentConfig, now = new Date()): Promise<DiscoveryResult> {
  const log: string[] = [];
  const limitations: string[] = [];
  const sources: string[] = [];
  let companies: CompanyRef[] = [];
  try {
    const list = await md.reference.listCompanies();
    companies = list.data;
    sources.push(list.url);
    log.push(`Tickers registrados en la SEC: ${companies.length}`);
  } catch (e) {
    log.push(`No se pudo obtener la lista de tickers: ${e instanceof Error ? e.message : e}`);
    limitations.push(`Lista de tickers de la SEC no disponible: ${e instanceof Error ? e.message : e}`);
  }
  const exchanges = new Set(config.exchanges.map((x) => x.toUpperCase()));
  const allowed = md.synthetic ? companies : companies.filter((c) => c.exchange && exchanges.has(c.exchange.toUpperCase()));
  const byCik = new Map<string, CompanyRef>();
  for (const c of allowed) if (!byCik.has(c.cik)) byCik.set(c.cik, c); // first ticker = primary share class
  const byTicker = new Map(companies.map((c) => [c.ticker, c]));

  const criteria = screeningCriteria(config);
  let screened: ScreenRow[] = [];
  let frameYear = now.getUTCFullYear() - 1;
  let caps: CapsByCik | null = null;
  // Point-in-time mode: XBRL frames include later restatements, so automatic screening would leak future data.
  const pit = Boolean(config.asOfDate) && !md.synthetic;
  if (pit) limitations.push(`Modo histórico (${config.asOfDate}): sin cribado automático para evitar sesgo de anticipación; solo se analizan los tickers indicados.`);
  if (!config.userTickersOnly && !pit && companies.length) {
    caps = await marketCaps(md, config, byCik, log, sources, limitations);
    for (let attempt = 0; attempt < 2 && !screened.length; attempt++) {
      const fy = now.getUTCFullYear() - 1 - attempt;
      const revenue = await firstFrame(md, SCREEN_FRAMES.revenue, "USD", fy, log, "max");
      if (!revenue.length) continue;
      frameYear = fy;
      const [revenueOld, operatingIncome, operatingCashFlow, capex] = [
        await firstFrame(md, SCREEN_FRAMES.revenue, "USD", fy - 3, log, "max"),
        await firstFrame(md, SCREEN_FRAMES.operatingIncome, "USD", fy, log),
        await firstFrame(md, SCREEN_FRAMES.operatingCashFlow, "USD", fy, log),
        await firstFrame(md, SCREEN_FRAMES.capex, "USD", fy, log),
      ];
      screened = screen({ revenue, revenueOld, operatingIncome, operatingCashFlow, capex }, fy, criteria, caps).filter((r) => byCik.has(r.cik));
      // Capitalisation segment: only the segments chosen in the configuration.
      if (caps) {
        const segs = new Set<string>(config.capSegments);
        for (const r of screened) if (!r.rejectedBy && r.capSegment && !segs.has(r.capSegment)) {
          r.rejectedBy = `segmento ${r.capSegment}`;
          r.screenScore = null;
        }
        screened.sort((a, b) => (b.screenScore ?? -1) - (a.screenScore ?? -1));
      }
      const reasons = new Map<string, number>();
      for (const r of screened) if (r.rejectedBy) reasons.set(r.rejectedBy, (reasons.get(r.rejectedBy) ?? 0) + 1);
      log.push(`Cribado CY${fy}: ${screened.length} empresas con datos; descartadas por ${[...reasons].map(([k, n]) => `${k} (${n})`).join(", ") || "—"}`);
    }
    if (screened.length) sources.push(`SEC XBRL frames CY${frameYear} / CY${frameYear - 3}`);
  }

  const candidates: CandidateRow[] = [];
  const excludedSet = new Set(config.excludedSectors);
  const ranked = screened.filter((s) => s.screenScore !== null);
  const pool = ranked.slice(0, config.maxCandidates * 3);
  const userSet = new Set(config.userTickers.map((t) => t.toUpperCase()));

  const addCandidate = async (ref: CompanyRef, source: CandidateRow["source"], s: ScreenRow | null) => {
    let sic: string | null = null;
    let sector: string | null = null;
    try {
      const p = await md.reference.profile(ref.cik);
      sic = p.data.sic;
      sector = p.data.sicDescription;
    } catch (e) {
      log.push(`Perfil SEC no disponible para ${ref.ticker}: ${e instanceof Error ? e.message : e}`);
    }
    const cls = classifySic(sic);
    const excluded = cls && excludedSet.has(cls) ? `Sector excluido: ${EXCLUSION_LABELS[cls]} (SIC ${sic})` : null;
    candidates.push({
      ticker: ref.ticker,
      cik: ref.cik,
      name: ref.name,
      exchange: ref.exchange,
      sic,
      sector,
      source,
      included: !excluded,
      exclusionReason: excluded,
      screen: s ? { ...s } : null,
      synthetic: md.synthetic,
    });
  };

  let includedCount = 0;
  for (const s of pool) {
    if (includedCount >= config.maxCandidates) break;
    const ref = byCik.get(s.cik)!;
    await addCandidate(ref, userSet.has(ref.ticker) ? "BOTH" : "DISCOVERY", s);
    if (candidates[candidates.length - 1].included) includedCount++;
  }
  for (const t of userSet) {
    if (candidates.some((c) => c.ticker === t)) continue;
    const ref = byTicker.get(t);
    if (!ref) {
      candidates.push({ ticker: t, cik: null, name: null, exchange: null, sic: null, sector: null, source: "USER_CSV", included: false, exclusionReason: "Ticker no encontrado en la lista de la SEC", screen: null, synthetic: md.synthetic });
      continue;
    }
    const s = screened.find((x) => x.cik === ref.cik) ?? null;
    await addCandidate(ref, "USER_CSV", s);
  }

  let level: CoverageInfo["level"];
  if (md.synthetic) {
    level = "CANDIDATE_LIST";
    limitations.push("Modo demostración: universo SINTÉTICO de empresas ficticias");
  } else if (screened.length) {
    level = "PARTIAL_UNIVERSE";
    limitations.push(
      `El cribado solo cubre empresas con datos XBRL estándar en los frames CY${frameYear} (ingresos, resultado operativo, flujo operativo, capex); quedan fuera emisores sin esas etiquetas o con ejercicios no alineados.`,
      "Las bolsas se filtran con el campo 'exchange' de la SEC; no se ha demostrado cobertura exhaustiva del mercado.",
      caps
        ? "Las rentabilidades de valoración del cribado usan la capitalización del screener de Nasdaq.com (no oficial) y no restan la deuda neta: son orientativas; la valoración rigurosa la hacen los agentes."
        : "Sin capitalizaciones de mercado: el cribado solo usa calidad (márgenes y crecimiento), no valoración ni segmento.",
    );
  } else if (candidates.length) {
    level = "CANDIDATE_LIST";
    limitations.push("Sin cribado automático: solo se analizan los tickers importados por el usuario");
  } else {
    level = "UNVERIFIED_UNIVERSE";
    limitations.push("No se pudo verificar ningún universo de empresas con las fuentes disponibles");
  }

  return {
    candidates,
    coverage: {
      level,
      description: md.synthetic
        ? `${candidates.length} empresas sintéticas de demostración`
        : `${companies.length} tickers SEC; ${screened.length} con datos de cribado; ${ranked.length} superan el filtro; ${candidates.filter((c) => c.included).length} candidatas`,
      universeSize: companies.length || null,
      screened: screened.length,
      sources,
      limitations,
    },
    log,
  };
}
