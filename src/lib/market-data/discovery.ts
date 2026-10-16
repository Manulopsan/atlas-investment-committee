import type { InvestmentConfig } from "../config";
import type { CandidateRow, CoverageInfo } from "../db/repo";
import { classifySic, EXCLUSION_LABELS } from "./index";
import { SCREEN_FRAMES } from "./sec";
import type { CompanyRef, FrameRow, MarketData } from "./types";

/**
 * Candidate discovery (deterministic, no AI):
 *  1. List SEC-registered tickers with their exchange.
 *  2. Pull cross-sectional XBRL "frames" (one request per concept/year) for
 *     revenue, operating income and operating cash flow.
 *  3. Rank by a transparent quality screen (margins + 3-year revenue growth).
 *  4. Fetch SIC codes for the top of the list to apply sector exclusions.
 *  5. Merge user-imported tickers.
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
  opMargin: number | null;
  ocfMargin: number | null;
  revenueCagr3y: number | null;
  screenScore: number | null;
  frameYear: number;
}

function percentileRank(values: number[]): (v: number) => number {
  const sorted = [...values].sort((a, b) => a - b);
  return (v) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return sorted.length ? lo / sorted.length : 0;
  };
}

/** Pure screening function — exported for tests. */
export function screen(frames: { revenue: FrameRow[]; revenueOld: FrameRow[]; operatingIncome: FrameRow[]; operatingCashFlow: FrameRow[] }, frameYear: number, minRevenue = 100e6): ScreenRow[] {
  const by = (rows: FrameRow[]) => new Map(rows.map((r) => [r.cik, r.value]));
  const rev = by(frames.revenue);
  const old = by(frames.revenueOld);
  const op = by(frames.operatingIncome);
  const ocf = by(frames.operatingCashFlow);
  const rows: ScreenRow[] = [];
  for (const [cik, r] of rev) {
    if (!(r >= minRevenue)) continue;
    const o = op.get(cik) ?? null;
    const c = ocf.get(cik) ?? null;
    const r0 = old.get(cik) ?? null;
    rows.push({
      cik,
      revenue: r,
      revenue3yAgo: r0,
      operatingIncome: o,
      operatingCashFlow: c,
      opMargin: o !== null ? o / r : null,
      ocfMargin: c !== null ? c / r : null,
      revenueCagr3y: r0 !== null && r0 > 0 ? Math.pow(r / r0, 1 / 3) - 1 : null,
      screenScore: null,
      frameYear,
    });
  }
  // Only rows with all three screen metrics are ranked; missing data is never imputed.
  const complete = rows.filter((x) => x.opMargin !== null && x.ocfMargin !== null && x.revenueCagr3y !== null);
  const pm = percentileRank(complete.map((x) => x.opMargin!));
  const pc = percentileRank(complete.map((x) => x.ocfMargin!));
  const pg = percentileRank(complete.map((x) => x.revenueCagr3y!));
  for (const x of complete) {
    const passes = x.opMargin! > 0.08 && x.ocfMargin! > 0.08 && x.revenueCagr3y! > 0.02 && x.revenueCagr3y! < 0.6;
    x.screenScore = passes ? Math.round(((pm(x.opMargin!) + pc(x.ocfMargin!) + pg(x.revenueCagr3y!)) / 3) * 1000) / 10 : null;
  }
  return rows.sort((a, b) => (b.screenScore ?? -1) - (a.screenScore ?? -1));
}

async function firstFrame(md: MarketData, concepts: string[], unit: string, year: number, log: string[]): Promise<FrameRow[]> {
  const merged = new Map<string, FrameRow>();
  for (const c of concepts) {
    try {
      const f = await md.fundamentals.frame(c, unit, `CY${year}`);
      for (const r of f.data) if (!merged.has(r.cik)) merged.set(r.cik, r);
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

  let screened: ScreenRow[] = [];
  let frameYear = now.getUTCFullYear() - 1;
  if (!config.userTickersOnly && companies.length) {
    for (let attempt = 0; attempt < 2 && !screened.length; attempt++) {
      const fy = now.getUTCFullYear() - 1 - attempt;
      const revenue = await firstFrame(md, SCREEN_FRAMES.revenue, "USD", fy, log);
      if (!revenue.length) continue;
      frameYear = fy;
      const [revenueOld, operatingIncome, operatingCashFlow] = [
        await firstFrame(md, SCREEN_FRAMES.revenue, "USD", fy - 3, log),
        await firstFrame(md, SCREEN_FRAMES.operatingIncome, "USD", fy, log),
        await firstFrame(md, SCREEN_FRAMES.operatingCashFlow, "USD", fy, log),
      ];
      screened = screen({ revenue, revenueOld, operatingIncome, operatingCashFlow }, fy).filter((r) => byCik.has(r.cik));
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
      `El cribado solo cubre empresas con datos XBRL estándar en los frames CY${frameYear} (ingresos, resultado operativo, flujo operativo); quedan fuera emisores sin esas etiquetas o con ejercicios no alineados.`,
      "Las bolsas se filtran con el campo 'exchange' de la SEC; no se ha demostrado cobertura exhaustiva del mercado.",
      "El segmento por capitalización no se criba en esta fase: requiere precio por empresa y se evalúa en el análisis.",
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
