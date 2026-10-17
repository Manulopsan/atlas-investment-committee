import type { InvestmentConfig } from "../config";
import type { CandidateRow, IssueRow, MessageRow } from "../db/repo";
import { evidenceDigest } from "../evidence/registry";
import { PROFILES } from "../agents/profiles";
import type { StoredReport, StoredRevision } from "../agents/schemas";
import { ROLE_LABELS, type AgentRole } from "../types";

export function objectiveBlock(c: InvestmentConfig): string {
  return [
    "OBJETIVO DE INVERSIÓN (configuración de la sesión):",
    `- Mercado: Estados Unidos (${c.exchanges.join(", ")}); segmentos: ${c.capSegments.join(", ")}.`,
    `- Horizonte: ${c.horizonYears} años. Estrategia: ${c.strategy}.`,
    `- Objetivo de rentabilidad anualizada: ${(c.targetAnnualReturn * 100).toFixed(1)}% (objetivo de selección, no promesa).`,
    `- Moneda: USD (alternativa EUR, con riesgo de divisa). Margen de seguridad requerido: ${(c.requiredMarginOfSafety * 100).toFixed(0)}%. Tasa de descuento de referencia: ${(c.discountRate * 100).toFixed(1)}%.`,
    `- Riesgo: tolerancia ${c.riskTolerance}, priorizando evitar pérdidas permanentes de capital.`,
    `- Sectores excluidos: ${c.excludedSectors.join(", ") || "ninguno"}. Máximo de finalistas: ${c.maxFinalists} (puede ser cero).`,
    ...(c.asOfDate
      ? [`- MODO HISTÓRICO: la fecha de análisis es ${c.asOfDate}. Las herramientas solo devuelven información disponible en esa fecha. Razona como si fuera ${c.asOfDate}: NO uses conocimiento posterior (resultados, precios o hechos que conozcas de después), aunque lo recuerdes.`]
      : []),
  ].join("\n");
}

function pctOrNd(v: unknown) {
  return typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "n/d";
}

/** Reference price registered by the system right after discovery (so every agent starts from the same verified quote). */
export interface CandidatePrice {
  value: number;
  asOf: string | null;
  source: string;
  evidenceId: string;
  confidence: string;
}

const bigUsd = (v: unknown) => (typeof v === "number" ? (v >= 1e9 ? `${(v / 1e9).toFixed(1)} B$` : `${(v / 1e6).toFixed(0)} M$`) : "n/d");

export function candidatesBlock(cands: CandidateRow[], prices: Record<string, CandidatePrice | null> = {}): string {
  if (!cands.length) return "No hay candidatas.";
  return [
    "CANDIDATAS (cribado determinista con datos XBRL de la SEC y capitalizaciones de mercado; las métricas de cribado son orientativas — confírmalas con get_company_financials):",
    ...cands.map((c) => {
      const s = (c.screen ?? {}) as Record<string, unknown>;
      const p = prices[c.ticker];
      const screen = c.screen
        ? ` | margen op. ${pctOrNd(s.opMargin)}, margen FCO ${pctOrNd(s.ocfMargin)}, CAGR ingresos 3a ${pctOrNd(s.revenueCagr3y)}` +
          (s.marketCap ? `, capitalización ${bigUsd(s.marketCap)} (${s.capSegment ?? "n/d"}), rentabilidad FCF ${pctOrNd(s.fcfYield)}, rentabilidad EBIT ${pctOrNd(s.earningsYield)}` : "") +
          `, puntuación cribado ${s.screenScore ?? "n/d"}`
        : "";
      const price = p ? ` | precio de referencia ${p.value} USD (${p.asOf ?? "s/f"}, ${p.source}, confianza ${p.confidence}) [${p.evidenceId}]` : " | precio de referencia: no disponible — intenta get_price";
      return `- ${c.ticker} | ${c.name ?? ""} | ${c.exchange ?? ""} | SIC ${c.sic ?? "n/d"} ${c.sector ?? ""} | origen ${c.source}${screen}${price}`;
    }),
  ].join("\n");
}

export function round1Prompt(role: AgentRole, config: InvestmentConfig, cands: CandidateRow[], notes: string[], prices: Record<string, CandidatePrice | null> = {}): string {
  const p = PROFILES[role];
  const task =
    role === "CIO"
      ? "Realiza tu ANÁLISIS PRELIMINAR INDEPENDIENTE de las candidatas: puntúa cada componente (0–100) y define las cuestiones críticas que el comité debe resolver."
      : `Realiza tu ANÁLISIS INICIAL INDEPENDIENTE como ${p.name}. Puntúa cada empresa analizada según tus criterios.`;
  return [
    "FASE: RONDA 1 — ANÁLISIS INDEPENDIENTE.",
    "Trabajas de forma independiente: no tienes acceso (ni debes intentar acceder) a las conclusiones de los otros tres agentes.",
    objectiveBlock(config),
    candidatesBlock(cands, prices),
    notes.length ? `TUS NOTAS DE TRABAJO PRIVADAS:\n${notes.map((n) => `- ${n}`).join("\n")}` : "",
    task,
    "Usa las herramientas para obtener datos: get_company_financials, get_price, get_company_profile, read_filing_section (texto literal del 10-K: risk_factors, mda, business, legal_proceedings…), get_historical_valuation (múltiplos históricos propios), get_peer_comparables (comparables con los competidores que elijas), search_sec_filings, verify_source, compute_valuation y compute_dcf. Prioriza calidad sobre cantidad: analiza a fondo las candidatas más relevantes; puedes descartar candidatas indicando el motivo en las conclusiones.",
    role === "RISK" ? "Lee los factores de riesgo y los procedimientos legales con read_filing_section y cita los pasajes (EV-n)." : "",
    role === "VALUATION" ? "Contrasta la valoración con get_historical_valuation y con comparables (get_peer_comparables)." : "",
    role === "QUALITY" ? "Usa el MD&A y la descripción del negocio (read_filing_section) para justificar ventajas competitivas y asignación de capital." : "",
    "Cada cifra de 'metrics' debe llevar su evidence_id (EV-n) o null si no está verificada. Indica siempre el periodo fiscal.",
    role === "VALUATION" ? "Para cada empresa incluye el bloque 'valuation' con hipótesis bear/base/bull (o null si no hay datos suficientes) y comprueba los resultados con compute_valuation." : "",
    role === "RISK" ? "Incluye 'vetoes' solo con evidencia suficiente (motivo, evidencia, fuente, EV-n y gravedad)." : "",
    "Cuando termines, entrega el informe con submit_initial_report.",
  ].filter(Boolean).join("\n\n");
}

export function reportDigest(r: StoredReport | null, opts: { tickers?: string[]; heading?: string } = {}): string {
  if (!r) return "(sin informe)";
  const lines: string[] = [`=== ${opts.heading ?? ROLE_LABELS[r.role]} — ${r.generated_at} ===`, `Resumen: ${r.executive_summary}`];
  for (const c of r.companies.filter((x) => !opts.tickers || opts.tickers.includes(x.ticker))) {
    lines.push(`--- ${c.ticker} — puntuación ${r.totals[c.ticker]?.toFixed(1) ?? "n/d"} (${Object.entries(c.scores).map(([k, v]) => `${k}=${v}`).join(", ")})`);
    lines.push(`Tesis: ${c.thesis}`);
    if (c.metrics.length) lines.push(`Métricas: ${c.metrics.map((m) => `${m.name}=${m.value ?? "n/d"} ${m.unit} ${m.period} [${m.evidence_id ?? "SIN EVIDENCIA"}]`).join("; ")}`);
    if (c.valuation) {
      const v = c.valuation;
      lines.push(`Valoración: tasa ${v.discount_rate}, vista ${v.valuation_view}, precio ref. ${v.reference_price_evidence_id ?? "n/d"}; ` +
        (["bear", "base", "bull"] as const).map((k) => `${k}: ${v.scenarios[k].metric} ${v.scenarios[k].metric_year_n ?? "n/d"} × ${v.scenarios[k].exit_multiple ?? "n/d"} + div ${v.scenarios[k].cumulative_dividends_per_share ?? "n/d"} (${v.scenarios[k].rationale})`).join(" | "));
    }
    if (c.key_points.length) lines.push(`Puntos clave: ${c.key_points.join(" / ")}`);
    if (c.uncertainties.length) lines.push(`Incertidumbres: ${c.uncertainties.join(" / ")}`);
    lines.push(`Conclusión provisional: ${c.provisional_conclusion}`);
  }
  if (r.vetoes?.length) lines.push(`VETOS: ${r.vetoes.filter((v) => !opts.tickers || opts.tickers.includes(v.ticker)).map((v) => `${v.ticker} [${v.severity}, ${v.status}] ${v.reason} — ${v.evidence} (${v.evidence_ids.join(",")})`).join(" | ")}`);
  if (r.critical_questions?.length) lines.push(`Cuestiones críticas del CIO: ${r.critical_questions.join(" / ")}`);
  lines.push(`Conclusiones: ${r.provisional_conclusions}`);
  if (r.uncertainties.length) lines.push(`Incertidumbres generales: ${r.uncertainties.join(" / ")}`);
  return lines.join("\n");
}

export function revisionDigest(r: StoredRevision | null, tickers?: string[]): string {
  if (!r) return "(sin revisión)";
  const lines = [`=== Revisión ronda ${r.round} — ${ROLE_LABELS[r.role]} ===`, r.executive_summary];
  for (const c of r.companies.filter((x) => !tickers || tickers.includes(x.ticker))) {
    lines.push(`--- ${c.ticker}: ${c.original_total?.toFixed(1) ?? "n/d"} → ${c.revised_total.toFixed(1)}. Motivo: ${c.change_reason}. Conclusión revisada: ${c.revised_conclusion}. Sin resolver: ${c.unresolved.join(" / ") || "—"}`);
  }
  if (r.vetoes?.length) lines.push(`VETOS: ${r.vetoes.map((v) => `${v.ticker} [${v.severity}, ${v.status}] ${v.reason}`).join(" | ")}`);
  return lines.join("\n");
}

export function threadBlock(msgs: MessageRow[]): string {
  if (!msgs.length) return "(sin mensajes todavía)";
  return msgs
    .map((m) => `#${m.id} [R${m.round}] ${ROLE_LABELS[m.fromRole]} → ${m.toRole === "ALL" ? "Comité" : ROLE_LABELS[m.toRole]} · ${m.type}${m.inReplyTo ? ` (responde a #${m.inReplyTo})` : ""}\n  Afirmación: ${m.claim}\n  Evidencia: ${m.evidenceText || "—"} ${m.evidenceIds.length ? `[${m.evidenceIds.join(", ")}]` : ""}\n  Pregunta: ${m.question ?? "—"} | Resultado esperado: ${m.expectedOutcome ?? "—"}`)
    .join("\n");
}

export function issuesBlock(issues: IssueRow[]): string {
  if (!issues.length) return "(sin incidencias)";
  return issues
    .map((i) => `Incidencia #${i.id} [${i.kind}${i.critical ? ", CRÍTICA" : ""}, ${i.status}] ${i.ticker ?? ""}: ${i.title}\n  ${i.claims.map((c) => `${c.by}: ${c.statement}`).join(" | ")}${i.resolution ? `\n  Resolución: ${i.resolution}` : ""}`)
    .join("\n");
}

export function evidenceBlock(sessionId: string, tickers?: string[]): string {
  const d = evidenceDigest(sessionId, { tickers, max: 250 });
  return d ? `REGISTRO DE EVIDENCIAS (id | ticker | métrica | valor | periodo | tipo/verificación | fuente):\n${d}` : "REGISTRO DE EVIDENCIAS: vacío";
}
