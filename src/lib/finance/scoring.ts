import type { Verdict } from "../types";
import { isNum } from "./returns";

/** Final weights (CIO). Risk is scored separately and also penalises. */
export const FINAL_WEIGHTS = {
  quality: 0.3,
  valuation: 0.3,
  returnPotential: 0.2,
  riskSolidity: 0.15,
  catalysts: 0.05,
} as const;

export const SCORING_METHOD = [
  "Todas las componentes se normalizan a 0–100.",
  "Calidad (0–100): puntuación del Quality Analyst (7 criterios, suma 100).",
  "Valoración (0–100): puntuación del Valuation Analyst (5 criterios, suma 100).",
  "Rentabilidad potencial a 3 años: CAGR total del escenario base calculado por el motor (no por el modelo). " +
    "≤0% → 0; entre 0% y el objetivo → 0–70 lineal; entre objetivo y 2× objetivo → 70–100; ≥2× objetivo → 100.",
  "Solidez financiera y riesgos = 100 − puntuación de riesgo (en la escala del Risk Analyst una puntuación alta es MÁS riesgo).",
  "Catalizadores verificables (0–100): CIO.",
  "Puntuación = 0,30·Calidad + 0,30·Valoración + 0,20·Rentabilidad + 0,15·Solidez + 0,05·Catalizadores − penalización.",
  "Penalización por riesgo: si riesgo > 50, se restan 0,4 puntos por cada punto por encima de 50 (máx. 20).",
  "Un veto crítico vigente excluye la empresa sin que ninguna otra puntuación lo compense; un veto alto limita el veredicto a 'Mantener en seguimiento'.",
  "Si falta cualquier componente la puntuación final no se calcula (no se rellenan huecos con cero).",
].join("\n");

export function returnPotentialScore(baseCagr: number | null, target: number): number | null {
  if (!isNum(baseCagr) || !isNum(target) || target <= 0) return null;
  if (baseCagr <= 0) return 0;
  if (baseCagr < target) return (70 * baseCagr) / target;
  if (baseCagr < 2 * target) return 70 + (30 * (baseCagr - target)) / target;
  return 100;
}

export function riskPenalty(risk: number | null): number {
  if (!isNum(risk) || risk <= 50) return 0;
  return Math.min(20, (risk - 50) * 0.4);
}

export interface ScoreInput {
  quality: number | null;
  valuation: number | null;
  risk: number | null;
  catalysts: number | null;
  baseCagr: number | null;
  target: number;
}

export interface ScoreBreakdown {
  quality: number | null;
  valuation: number | null;
  returnPotential: number | null;
  riskSolidity: number | null;
  catalysts: number | null;
  penalty: number;
  weighted: number | null;
  final: number | null;
  missing: string[];
}

export function finalScore(i: ScoreInput): ScoreBreakdown {
  const rp = returnPotentialScore(i.baseCagr, i.target);
  const solidity = isNum(i.risk) ? 100 - i.risk : null;
  const comps = { quality: i.quality, valuation: i.valuation, returnPotential: rp, riskSolidity: solidity, catalysts: i.catalysts };
  const missing = Object.entries(comps).filter(([, v]) => !isNum(v)).map(([k]) => k);
  const penalty = riskPenalty(i.risk);
  if (missing.length) {
    return { ...comps, penalty, weighted: null, final: null, missing };
  }
  const weighted =
    FINAL_WEIGHTS.quality * i.quality! +
    FINAL_WEIGHTS.valuation * i.valuation! +
    FINAL_WEIGHTS.returnPotential * rp! +
    FINAL_WEIGHTS.riskSolidity * solidity! +
    FINAL_WEIGHTS.catalysts * i.catalysts!;
  return { ...comps, penalty, weighted, final: Math.max(0, weighted - penalty), missing };
}

export interface VetoState {
  severity: "critical" | "high" | "medium";
  upheld: boolean;
  reason: string;
}

export interface VerdictInput {
  score: ScoreBreakdown;
  baseCagr: number | null;
  bearCagr: number | null;
  target: number;
  vetoes: VetoState[];
  criticalOpenIssues: number;
  /** Fraction (0–1) of critical datapoints that are VERIFIED. */
  dataConfidence: number;
  priceVerified: boolean;
  /** Worst tolerated bear-case CAGR for a moderate profile. */
  bearFloor?: number;
}

export interface VerdictDecision {
  allowed: Verdict;
  reasons: string[];
}

export const VERDICT_FAVORABILITY: Record<Verdict, number> = {
  POTENTIAL_BUY: 4,
  EXCELLENT_TOO_EXPENSIVE: 3,
  WATCHLIST: 2,
  PENDING_VERIFICATION: 1,
  EXCLUDE: 0,
};

/** The most favourable verdict the evidence allows. The CIO may be more conservative, never less. */
export function allowedVerdict(v: VerdictInput): VerdictDecision {
  const reasons: string[] = [];
  const bearFloor = v.bearFloor ?? -0.1;
  const critical = v.vetoes.filter((x) => x.upheld && x.severity === "critical");
  if (critical.length) {
    return { allowed: "EXCLUDE", reasons: critical.map((c) => `Veto crítico vigente: ${c.reason}`) };
  }
  const q = v.score.quality;
  const r = v.score.riskSolidity === null ? null : 100 - v.score.riskSolidity;
  if (isNum(q) && q < 50) return { allowed: "EXCLUDE", reasons: [`Calidad insuficiente (${q.toFixed(0)}/100 < 50)`] };
  if (isNum(r) && r >= 75) return { allowed: "EXCLUDE", reasons: [`Riesgo inaceptable (${r.toFixed(0)}/100 ≥ 75)`] };

  if (v.score.final === null) reasons.push(`Faltan componentes de la puntuación: ${v.score.missing.join(", ")}`);
  if (!v.priceVerified) reasons.push("Precio de referencia no verificado");
  if (!isNum(v.baseCagr)) reasons.push("Escenario base sin datos suficientes");
  if (v.dataConfidence < 0.5) reasons.push(`Confianza en datos baja (${Math.round(v.dataConfidence * 100)}% verificado)`);
  if (v.criticalOpenIssues > 0) reasons.push(`${v.criticalOpenIssues} incidencia(s) crítica(s) sin resolver`);
  if (reasons.length) return { allowed: "PENDING_VERIFICATION", reasons };

  const highVeto = v.vetoes.filter((x) => x.upheld && x.severity === "high");
  const meets = v.baseCagr! >= v.target;
  if (highVeto.length) {
    return { allowed: "WATCHLIST", reasons: highVeto.map((h) => `Veto de gravedad alta: ${h.reason}`) };
  }
  if (meets && isNum(q) && q >= 60 && isNum(r) && r < 60 && v.score.final! >= 60 && (!isNum(v.bearCagr) || v.bearCagr >= bearFloor)) {
    return { allowed: "POTENTIAL_BUY", reasons: [`CAGR base ${(v.baseCagr! * 100).toFixed(1)}% ≥ objetivo; calidad, riesgo y escenario bajista dentro de límites`] };
  }
  if (isNum(q) && q >= 75 && !meets) {
    return { allowed: "EXCELLENT_TOO_EXPENSIVE", reasons: [`Calidad ${q.toFixed(0)} ≥ 75 pero CAGR base ${(v.baseCagr! * 100).toFixed(1)}% < objetivo`] };
  }
  const why: string[] = [];
  if (!meets) why.push("CAGR base por debajo del objetivo");
  if (isNum(v.bearCagr) && v.bearCagr < bearFloor) why.push(`escenario bajista ${(v.bearCagr * 100).toFixed(1)}%/año por debajo de ${(bearFloor * 100).toFixed(0)}%`);
  if (isNum(r) && r >= 60) why.push("riesgo elevado");
  if (v.score.final! < 60) why.push("puntuación final < 60");
  return { allowed: "WATCHLIST", reasons: why.length ? why : ["No cumple todos los requisitos de compra"] };
}

/** Combine CIO proposal with the engine's allowed verdict: the more conservative wins. */
export function reconcileVerdict(allowed: Verdict, cioProposed: Verdict | null): { verdict: Verdict; overridden: boolean } {
  if (!cioProposed) return { verdict: allowed, overridden: false };
  if (allowed === "EXCLUDE" || allowed === "PENDING_VERIFICATION") {
    if (cioProposed === "EXCLUDE") return { verdict: "EXCLUDE", overridden: false };
    return { verdict: allowed, overridden: cioProposed !== allowed };
  }
  if (VERDICT_FAVORABILITY[cioProposed] <= VERDICT_FAVORABILITY[allowed]) return { verdict: cioProposed, overridden: false };
  return { verdict: allowed, overridden: true };
}

export interface RankableCompany {
  ticker: string;
  verdict: Verdict;
  finalScore: number | null;
}

const RANKABLE: Verdict[] = ["POTENTIAL_BUY", "EXCELLENT_TOO_EXPENSIVE", "WATCHLIST"];

/** Ranking of 0..maxFinalists companies. Never padded to reach the maximum. */
export function rankFinalists<T extends RankableCompany>(companies: T[], maxFinalists: number): T[] {
  return companies
    .filter((c) => RANKABLE.includes(c.verdict) && isNum(c.finalScore))
    .sort((a, b) => VERDICT_FAVORABILITY[b.verdict] - VERDICT_FAVORABILITY[a.verdict] || b.finalScore! - a.finalScore!)
    .slice(0, Math.max(0, maxFinalists));
}
