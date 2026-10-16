import { getFinalReport, getSession, listIssues, listMessages, listReports, listVerdicts, type SessionRow } from "../db/repo";
import { listEvidence, shortId } from "../evidence/registry";
import { pct } from "../finance/returns";
import { PROFILES } from "../agents/profiles";
import type { StoredReport, StoredRevision } from "../agents/schemas";
import { usageBreakdown } from "../llm/cost";
import { redactSecrets } from "../security/redact";
import { COVERAGE_LABELS, ROLE_LABELS, VERDICT_LABELS, type AgentRole } from "../types";
import type { ScenarioSetResult } from "../finance/valuation";

export const EXPORT_TYPES = ["final-md", "final-csv", "agents-md", "transcript-md", "evidence-csv", "scores-csv"] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

export const DISCLAIMER =
  "ADVERTENCIA: las estimaciones no son garantías de rentabilidad. El objetivo del 15% anual es un criterio de selección, no una previsión. Este documento no constituye asesoramiento financiero.";

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "number" ? String(Math.round(v * 1e6) / 1e6) : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

function verificationSummary(sessionId: string) {
  const ev = listEvidence(sessionId);
  const by = (st: string) => ev.filter((e) => e.verification === st).length;
  return { total: ev.length, verified: by("VERIFIED"), unverified: by("UNVERIFIED"), conflict: by("CONFLICT"), unreachable: by("UNREACHABLE") };
}

export function exportHeader(s: SessionRow, format: "md" | "csv"): string {
  const usage = usageBreakdown(s.id);
  const v = verificationSummary(s.id);
  const sources = Array.from(new Set(listEvidence(s.id).map((e) => e.source.split(";")[0]))).slice(0, 15);
  const lines = [
    `ATLAS INVESTMENT COMMITTEE — sesión ${s.id}`,
    `Modo: ${s.mode === "demo" ? "DEMOSTRACIÓN (DATOS SINTÉTICOS, NO REALES)" : s.mode === "dry_run" ? "análisis en seco (sin IA)" : "real"}`,
    `Fecha de corte: ${s.cutoffAt ?? s.createdAt}`,
    `Estado: ${s.status}; convergencia: ${s.convergence ?? "n/d"}`,
    `Modelos: ${usage.models.join(", ") || `${s.settings.model} (sin llamadas registradas)`}`,
    `Cobertura: ${s.coverage ? `${COVERAGE_LABELS[s.coverage.level]} — ${s.coverage.description}` : "n/d"}`,
    `Fuentes: ${sources.join(" | ") || "n/d"}`,
    `Verificación de evidencias: ${v.verified}/${v.total} verificadas, ${v.unverified} no verificadas, ${v.conflict} en conflicto, ${v.unreachable} inaccesibles`,
    `Limitaciones: ${(s.coverage?.limitations ?? []).join(" ") || "ver informe"}`,
    `Uso de IA: ${usage.totals.calls} llamadas, ${usage.totals.inputTokens + usage.totals.cacheReadTokens + usage.totals.cacheWriteTokens} tokens de entrada, ${usage.totals.outputTokens} de salida, coste ${usage.totals.estCostUsd.toFixed(4)} USD (${usage.basis})`,
    DISCLAIMER,
  ];
  return format === "md" ? lines.map((l, i) => (i === 0 ? `# ${l}` : `> ${l}`)).join("\n") + "\n\n" : lines.map((l) => `# ${l}`).join("\n") + "\n";
}

const money = (x: unknown) => (typeof x === "number" ? x.toFixed(2) : "n/d");

export function finalMarkdown(sessionId: string): string {
  const s = getSession(sessionId)!;
  const fr = getFinalReport<Record<string, unknown>>(sessionId);
  const verdicts = listVerdicts(sessionId);
  const out: string[] = [exportHeader(s, "md")];
  if (!fr) return out.join("") + "_El informe final todavía no existe._\n";
  out.push(`## Resumen ejecutivo del CIO\n\n${fr.content.executive_summary}\n`);
  out.push(`**Convergencia:** ${fr.content.convergence}. **Compras potenciales:** ${(fr.content.buys as string[]).length ? (fr.content.buys as string[]).join(", ") : "ninguna"}.\n`);
  out.push("## Ranking final\n\n| # | Ticker | Nombre | Sector | Precio (fecha, tipo) | Valor razonable central [rango] | Precio máx. objetivo | Entrada propuesta | CAGR bajista / base / alcista | Puntuación | Riesgo | Confianza datos | Debate | Veredicto |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const v of verdicts) {
    const c = v.content as Record<string, unknown>;
    const sc = c.scenarios as ScenarioSetResult | null;
    const price = c.price as { value: number; asOf: string; kind: string; evidenceId: string } | null;
    const sco = c.scores as Record<string, number | null>;
    const conf = c.dataConfidence as { score: number };
    out.push(
      `| ${v.rank ?? "—"} | ${v.ticker} | ${c.name ?? ""} | ${c.sector ?? ""} | ${price ? `${price.value} USD (${price.asOf}, ${price.kind}, ${price.evidenceId})` : "NO VERIFICADO"} | ${money(sc?.fairValueCentral)} [${money(sc?.fairValueLow)}–${money(sc?.fairValueHigh)}] | ${money(sc?.maxPriceForTarget)} | ${money(sc?.proposedEntryPrice)} | ${pct(sc?.scenarios.bear.totalCagr)} / ${pct(sc?.scenarios.base.totalCagr)} / ${pct(sc?.scenarios.bull.totalCagr)} | ${v.finalScore?.toFixed(1) ?? "n/d"} | ${sco.risk ?? "n/d"} | ${Math.round(conf.score * 100)}% | ${c.debateStatus} | ${VERDICT_LABELS[v.verdict]} |`,
    );
  }
  out.push("\n## Fichas\n");
  for (const v of verdicts) {
    const c = v.content as Record<string, unknown>;
    const cio = c.cio as { rationale?: string; consensus?: string[]; dissent?: string[]; conditions_for_target?: string[] } | null;
    const sc = c.scenarios as ScenarioSetResult | null;
    out.push(`### ${v.ticker} — ${VERDICT_LABELS[v.verdict]}`);
    if (v.overrideReason) out.push(`- Ajuste del motor: ${v.overrideReason}`);
    out.push(`- Justificación del CIO: ${cio?.rationale ?? "n/d"}`);
    out.push(`- Consenso: ${(cio?.consensus ?? []).join("; ") || "—"}`);
    out.push(`- Discrepancias pendientes: ${(cio?.dissent ?? []).join("; ") || "—"}`);
    out.push(`- Hipótesis necesarias para aproximarse al objetivo: ${(cio?.conditions_for_target ?? []).join("; ") || "—"}`);
    if (sc) {
      for (const k of ["bear", "base", "bull"] as const) {
        const x = sc.scenarios[k];
        out.push(`- Escenario ${k}: valor año ${sc.years} ${money(x.valueYearN)} USD + dividendos ${money(x.dividendsPerShare)}; CAGR precio ${pct(x.priceCagr)}, CAGR total ${pct(x.totalCagr)}${x.insufficientData.length ? ` (datos insuficientes: ${x.insufficientData.join(", ")})` : ""}`);
      }
    }
    const eur = c.eur as { baseCagrEurConstantFx: number | null; usdPerEur: number; sensitivity: { eurMove: number; eurCagr: number | null }[] } | null;
    if (eur) out.push(`- EUR (tipo ${eur.usdPerEur} USD/EUR, constante): CAGR base ${pct(eur.baseCagrEurConstantFx)}; con euro −10%/0/+10%: ${eur.sensitivity.map((x) => pct(x.eurCagr)).join(" / ")}`);
    const vetoes = c.vetoes as { severity: string; upheld: boolean; reason: string }[];
    if (vetoes?.length) out.push(`- Vetos: ${vetoes.map((x) => `[${x.severity}${x.upheld ? "" : ", retirado"}] ${x.reason}`).join("; ")}`);
    out.push("");
  }
  out.push("## Incidencias\n");
  for (const i of listIssues(sessionId)) out.push(`- #${i.id} [${i.kind}${i.critical ? ", crítica" : ""}] ${i.status} — ${i.ticker ?? ""} ${i.title}${i.resolution ? ` → ${i.resolution}` : ""}`);
  const m = fr.content.methodology as Record<string, string>;
  out.push(`\n## Metodología\n\n${m.scoring}\n\n${m.scenarios}\n\n${m.totalReturn}\n`);
  out.push(`## Limitaciones\n\n${(fr.content.limitations as string[]).map((l) => `- ${l}`).join("\n")}\n\n${DISCLAIMER}\n`);
  return redactSecrets(out.join("\n"));
}

export function finalCsv(sessionId: string): string {
  const s = getSession(sessionId)!;
  const rows: unknown[][] = [["rank", "ticker", "name", "sector", "price_usd", "price_as_of", "price_kind", "price_evidence", "fair_value_central", "fair_value_low", "fair_value_high", "max_price_for_target", "proposed_entry", "bear_cagr", "base_cagr", "bull_cagr", "base_cagr_eur_constant_fx", "quality", "valuation", "risk", "catalysts", "final_score", "data_confidence", "debate_status", "verdict", "cio_proposed", "engine_override", "synthetic"]];
  for (const v of listVerdicts(sessionId)) {
    const c = v.content as Record<string, unknown>;
    const sc = c.scenarios as ScenarioSetResult | null;
    const p = c.price as { value: number; asOf: string; kind: string; evidenceId: string } | null;
    const sco = c.scores as Record<string, number | null>;
    const eur = c.eur as { baseCagrEurConstantFx: number | null } | null;
    rows.push([v.rank, v.ticker, c.name, c.sector, p?.value, p?.asOf, p?.kind, p?.evidenceId, sc?.fairValueCentral, sc?.fairValueLow, sc?.fairValueHigh, sc?.maxPriceForTarget, sc?.proposedEntryPrice, sc?.scenarios.bear.totalCagr, sc?.scenarios.base.totalCagr, sc?.scenarios.bull.totalCagr, eur?.baseCagrEurConstantFx, sco.quality, sco.valuation, sco.risk, sco.catalysts, v.finalScore, (c.dataConfidence as { score: number }).score, c.debateStatus, v.verdict, v.cioProposedVerdict, v.overrideReason, c.synthetic ? "yes" : "no"]);
  }
  return redactSecrets(exportHeader(s, "csv") + toCsv(rows));
}

export function agentsMarkdown(sessionId: string, role?: AgentRole): string {
  const s = getSession(sessionId)!;
  const out: string[] = [exportHeader(s, "md")];
  for (const r of listReports(sessionId, role)) {
    out.push(`## ${ROLE_LABELS[r.agentRole]} — v${r.version} (${r.kind === "INITIAL" ? "informe inicial, congelado" : "revisión"}) — ${r.createdAt}`);
    if (r.kind === "INITIAL") {
      const c = r.content as StoredReport;
      out.push(`Modelo: ${c.model}\n\n**Resumen ejecutivo:** ${c.executive_summary}\n`);
      for (const co of c.companies) {
        out.push(`### ${co.ticker} — puntuación ${c.totals[co.ticker]} / ${PROFILES[r.agentRole].criteria.reduce((a, x) => a + x.max, 0)}`);
        out.push(`- Tesis: ${co.thesis}`);
        out.push(`- Puntuaciones: ${Object.entries(co.scores).map(([k, v]) => `${k} ${v}`).join(", ")}`);
        out.push(`- Métricas: ${co.metrics.map((m) => `${m.name} ${m.value ?? "n/d"} ${m.unit} ${m.period} [${m.evidence_id ?? "NO VERIFICADO"}]`).join("; ") || "—"}`);
        out.push(`- Incertidumbres: ${co.uncertainties.join("; ") || "—"}`);
        out.push(`- Conclusión provisional: ${co.provisional_conclusion}\n`);
      }
      if (c.vetoes?.length) out.push(`**Vetos:** ${c.vetoes.map((v) => `${v.ticker} [${v.severity}] ${v.reason} — ${v.evidence} (${v.source_url ?? "sin URL"})`).join("; ")}`);
      if (c.critical_questions?.length) out.push(`**Cuestiones críticas:** ${c.critical_questions.join("; ")}`);
      out.push(`**Fuentes:** ${c.sources.map((x) => `${x.title} ${x.url}`).join("; ") || "—"}\n\n**Conclusiones:** ${c.provisional_conclusions}\n`);
    } else {
      const c = r.content as StoredRevision;
      out.push(`Ronda ${c.round} — ${c.executive_summary}\n`);
      for (const co of c.companies) {
        out.push(`### ${co.ticker}: ${co.original_total ?? "n/d"} → ${co.revised_total}`);
        out.push(`- Conclusión original: ${co.original_conclusion ?? "—"}`);
        out.push(`- Conclusión revisada: ${co.revised_conclusion}`);
        out.push(`- Motivo: ${co.change_reason}`);
        out.push(`- Aceptados: ${co.accepted_arguments.map((a) => `${a.message_id ? `#${a.message_id} ` : ""}${a.summary}`).join("; ") || "—"}`);
        out.push(`- Rechazados: ${co.rejected_arguments.map((a) => `${a.message_id ? `#${a.message_id} ` : ""}${a.summary} (${a.reason})`).join("; ") || "—"}`);
        out.push(`- Datos nuevos: ${co.new_data.map((d) => `${d.evidence_id ?? ""} ${d.summary}`).join("; ") || "—"}`);
        out.push(`- Sin resolver: ${co.unresolved.join("; ") || "—"}\n`);
      }
    }
  }
  return redactSecrets(out.join("\n"));
}

export function transcriptMarkdown(sessionId: string): string {
  const s = getSession(sessionId)!;
  const out: string[] = [exportHeader(s, "md"), "## Transcripción del debate\n"];
  for (const m of listMessages(sessionId)) {
    out.push(`**#${m.id} · Ronda ${m.round} · ${m.phase} · ${m.ticker ?? "general"}** — ${ROLE_LABELS[m.fromRole]} → ${m.toRole === "ALL" ? "Comité" : ROLE_LABELS[m.toRole]} · _${m.type}_${m.inReplyTo ? ` (responde a #${m.inReplyTo})` : ""} · ${m.createdAt}`);
    out.push(`- Afirmación: ${m.claim}`);
    out.push(`- Evidencia: ${m.evidenceText ?? "—"} ${m.evidenceIds.length ? `[${m.evidenceIds.join(", ")}]` : ""}`);
    out.push(`- Pregunta: ${m.question ?? "—"} · Resultado esperado: ${m.expectedOutcome ?? "—"}\n`);
  }
  return redactSecrets(out.join("\n"));
}

export function evidenceCsv(sessionId: string): string {
  const s = getSession(sessionId)!;
  const rows: unknown[][] = [["id", "ticker", "company", "metric", "value", "value_text", "unit", "period", "period_type", "fiscal_year", "basis", "published_at", "retrieved_at", "source", "url", "data_type", "verification", "price_kind", "formula", "inputs", "confidence", "confidence_reason", "created_by", "synthetic"]];
  for (const e of listEvidence(sessionId)) {
    rows.push([shortId(e.id), e.ticker, e.company, e.metric, e.value, e.valueText, e.unit, e.period, e.periodType, e.fiscalYear, e.basis, e.publishedAt, e.retrievedAt, e.source, e.url, e.dataType, e.verification, e.priceKind, e.formula, e.inputs.map(shortId).join(" "), e.confidence, e.confidenceReason, e.createdBy, e.synthetic ? "yes" : "no"]);
  }
  return redactSecrets(exportHeader(s, "csv") + toCsv(rows));
}

export function scoresCsv(sessionId: string): string {
  const s = getSession(sessionId)!;
  const rows: unknown[][] = [["agent", "version", "kind", "created_at", "ticker", "total", "criteria", "reason"]];
  for (const r of listReports(sessionId)) {
    if (r.kind === "INITIAL") {
      const c = r.content as StoredReport;
      for (const co of c.companies) rows.push([r.agentRole, r.version, r.kind, r.createdAt, co.ticker, c.totals[co.ticker], JSON.stringify(co.scores), "informe inicial"]);
    } else {
      const c = r.content as StoredRevision;
      for (const co of c.companies) rows.push([r.agentRole, r.version, r.kind, r.createdAt, co.ticker, co.revised_total, JSON.stringify(co.revised_scores), co.change_reason]);
    }
  }
  return redactSecrets(exportHeader(s, "csv") + toCsv(rows));
}

export function buildExport(sessionId: string, type: ExportType, role?: AgentRole): { body: string; filename: string; contentType: string } {
  const base = `atlas-${sessionId.slice(0, 8)}`;
  switch (type) {
    case "final-md":
      return { body: finalMarkdown(sessionId), filename: `${base}-informe-final.md`, contentType: "text/markdown; charset=utf-8" };
    case "final-csv":
      return { body: finalCsv(sessionId), filename: `${base}-ranking.csv`, contentType: "text/csv; charset=utf-8" };
    case "agents-md":
      return { body: agentsMarkdown(sessionId, role), filename: `${base}-informes-${role ?? "agentes"}.md`, contentType: "text/markdown; charset=utf-8" };
    case "transcript-md":
      return { body: transcriptMarkdown(sessionId), filename: `${base}-debate.md`, contentType: "text/markdown; charset=utf-8" };
    case "evidence-csv":
      return { body: evidenceCsv(sessionId), filename: `${base}-evidencias.csv`, contentType: "text/csv; charset=utf-8" };
    case "scores-csv":
      return { body: scoresCsv(sessionId), filename: `${base}-puntuaciones.csv`, contentType: "text/csv; charset=utf-8" };
  }
}
