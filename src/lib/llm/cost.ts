import type { AppSettings, ModelPrice } from "../config";
import { listUsage, usageTotals } from "../db/repo";
import type { ModelUsage } from "./adapter";

export const COST_BASIS = "ESTIMADO: tokens reportados por la API × tabla de precios configurada (la facturación real puede diferir)";

/** A zero price is treated as "not configured": otherwise the budget could never be enforced. */
export function priceFor(settings: AppSettings, model: string): ModelPrice | null {
  const p = settings.pricing[model];
  if (!p || (p.inputPerMTok <= 0 && p.outputPerMTok <= 0)) return null;
  return p;
}

export function costOf(u: ModelUsage, p: ModelPrice | null): number | null {
  if (!p) return null;
  return (
    (u.input_tokens * p.inputPerMTok +
      u.output_tokens * p.outputPerMTok +
      u.cache_read_input_tokens * p.cacheReadPerMTok +
      u.cache_creation_input_tokens * p.cacheWritePerMTok) /
    1e6
  );
}

/** Conservative token estimate (~3 characters per token for Spanish text + JSON). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export class BudgetExceededError extends Error {
  constructor(public reason: string) {
    super(`Presupuesto agotado: ${reason}`);
    this.name = "BudgetExceededError";
  }
}

export class StopRequestedError extends Error {
  constructor() {
    super("Proceso detenido por el usuario");
    this.name = "StopRequestedError";
  }
}

/**
 * Pre-call budget guard. Before every model call it checks the worst case
 * (estimated input + max output tokens) against the remaining budget and the
 * call limit. Non-final phases may only use (1 − reserve) of the budget, so
 * the CIO can always document the outcome after a controlled stop.
 */
export function checkBudget(sessionId: string, settings: AppSettings, req: { model: string; estInputTokens: number; maxOutputTokens: number; isFinal: boolean }) {
  const L = settings.limits;
  const totals = usageTotals(sessionId);
  const reserveCalls = req.isFinal ? 0 : 2;
  if (totals.calls + 1 > L.maxCallsPerSession - reserveCalls) {
    throw new BudgetExceededError(`límite de llamadas (${totals.calls}/${L.maxCallsPerSession}${reserveCalls ? `, ${reserveCalls} reservadas para el veredicto` : ""})`);
  }
  if (req.estInputTokens > L.maxInputTokensPerCall) {
    throw new BudgetExceededError(`la llamada excedería el límite de tokens de entrada (${req.estInputTokens} > ${L.maxInputTokensPerCall})`);
  }
  const p = priceFor(settings, req.model);
  if (!p) throw new BudgetExceededError(`no hay precio configurado para el modelo ${req.model}; configure la tabla de precios`);
  const worst = costOf({ input_tokens: req.estInputTokens, output_tokens: req.maxOutputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, p)!;
  const available = req.isFinal ? L.maxBudgetUsd : L.maxBudgetUsd * (1 - L.finalReserveFraction);
  if (totals.estCostUsd + worst > available) {
    throw new BudgetExceededError(
      `gasto estimado ${totals.estCostUsd.toFixed(3)} USD + peor caso de la siguiente llamada ${worst.toFixed(3)} USD > disponible ${available.toFixed(2)} USD${req.isFinal ? "" : " (reserva para el veredicto excluida)"}`,
    );
  }
}

export function usageBreakdown(sessionId: string) {
  const rows = listUsage(sessionId);
  const by = (key: (r: (typeof rows)[number]) => string) => {
    const m = new Map<string, { calls: number; inputTokens: number; outputTokens: number; estCostUsd: number }>();
    for (const r of rows) {
      const k = key(r);
      const cur = m.get(k) ?? { calls: 0, inputTokens: 0, outputTokens: 0, estCostUsd: 0 };
      cur.calls++;
      cur.inputTokens += r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens;
      cur.outputTokens += r.outputTokens;
      cur.estCostUsd += r.estCostUsd ?? 0;
      m.set(k, cur);
    }
    return Object.fromEntries(m);
  };
  return {
    totals: usageTotals(sessionId),
    byAgent: by((r) => r.agentRole ?? "—"),
    byPhase: by((r) => r.phase ?? "—"),
    byCompany: by((r) => r.ticker ?? "varias / general"),
    models: Array.from(new Set(rows.map((r) => r.model))),
    basis: COST_BASIS,
  };
}

export interface PlanEstimate {
  model: string;
  debateModel: string;
  agents: number;
  rounds: string[];
  phases: { phase: string; calls: number; inputTokens: number; outputTokens: number; estCostUsd: number | null }[];
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estCostUsd: number | null;
  budgetUsd: number;
  maxCalls: number;
  withinBudget: boolean | null;
  warnings: string[];
}

/** Pre-session estimate. Heuristic, labelled as such; real cost depends on tokens and tool use. */
export function planEstimate(settings: AppSettings, nCandidates: number): PlanEstimate {
  const L = settings.limits;
  const inv = settings.investment;
  const nC = Math.max(1, Math.min(nCandidates, inv.maxCandidates));
  const nD = Math.min(nC, inv.maxDebateCompanies);
  const iters = Math.min(L.maxToolIterations, 6);
  const toolCtx = 2500 * nC;
  // Round 1: each iteration resends the growing transcript.
  const r1In = Array.from({ length: iters }, (_, i) => 5000 + toolCtx * 0.3 + i * 3500).reduce((a, b) => a + b, 0);
  const reportTok = 900 * nC + 1200;
  const phases: { phase: string; calls: number; inputTokens: number; outputTokens: number; model: string }[] = [
    { phase: "ROUND_1", calls: 4 * iters, inputTokens: 4 * r1In, outputTokens: 4 * (iters * 600 + reportTok), model: settings.model },
    { phase: "CROSS_REVIEW", calls: 4, inputTokens: 4 * (4 * reportTok + 6000), outputTokens: 4 * 3000, model: settings.debateModel },
    { phase: "DEBATE", calls: nD * 6, inputTokens: nD * 6 * (4 * 900 + 6000), outputTokens: nD * 6 * 1500, model: settings.debateModel },
    { phase: "VERIFICATION", calls: nD * L.maxVerificationsPerCompany * 3, inputTokens: nD * L.maxVerificationsPerCompany * 3 * 9000, outputTokens: nD * L.maxVerificationsPerCompany * 3 * 800, model: settings.debateModel },
    { phase: "REVISION", calls: 4, inputTokens: 4 * (4 * reportTok + 12000), outputTokens: 4 * reportTok, model: settings.model },
  ];
  if (L.maxDebateRounds >= 2) {
    phases.push({ phase: "SELECTIVE_DEBATE", calls: 1 + 3, inputTokens: 4 * (4 * reportTok + 10000), outputTokens: 4 * 2500, model: settings.debateModel });
  }
  phases.push({ phase: "FINAL_DECISION", calls: 1, inputTokens: 4 * reportTok + 20000, outputTokens: 6000, model: settings.model });
  const out = phases.map((p) => {
    const price = priceFor(settings, p.model);
    // Assume roughly half of the input of multi-iteration tasks is served from the prompt cache.
    const c = price ? costOf({ input_tokens: p.inputTokens * 0.6, output_tokens: p.outputTokens, cache_read_input_tokens: p.inputTokens * 0.4, cache_creation_input_tokens: 0 }, price) : null;
    return { phase: p.phase, calls: p.calls, inputTokens: Math.round(p.inputTokens), outputTokens: Math.round(p.outputTokens), estCostUsd: c };
  });
  const totalCalls = out.reduce((a, b) => a + b.calls, 0);
  const cost = out.every((p) => p.estCostUsd !== null) ? out.reduce((a, b) => a + (b.estCostUsd ?? 0), 0) : null;
  const warnings = [
    "Estimación aproximada: el coste real depende de los tokens efectivamente usados, del número de llamadas a herramientas y de la caché.",
    "La aplicación detiene nuevas llamadas antes de superar el presupuesto o el límite de llamadas.",
  ];
  if (!priceFor(settings, settings.model) || !priceFor(settings, settings.debateModel)) warnings.push("Falta el precio de algún modelo seleccionado en la tabla de precios: no se puede estimar el coste.");
  if (totalCalls > L.maxCallsPerSession) warnings.push(`Las llamadas previstas (${totalCalls}) superan el límite (${L.maxCallsPerSession}): el debate se detendrá de forma controlada.`);
  if (cost !== null && cost > L.maxBudgetUsd) warnings.push(`El coste estimado supera el presupuesto: el debate se detendrá de forma controlada al llegar al límite.`);
  return {
    model: settings.model,
    debateModel: settings.debateModel,
    agents: 4,
    rounds: ["Ronda 1 independiente", "Ronda 2 lectura cruzada + debate + verificación", "Ronda 3 revisión", ...(L.maxDebateRounds >= 2 ? ["Ronda 4 debate selectivo"] : []), "Decisión final del CIO"],
    phases: out,
    totalCalls,
    totalInputTokens: out.reduce((a, b) => a + b.inputTokens, 0),
    totalOutputTokens: out.reduce((a, b) => a + b.outputTokens, 0),
    estCostUsd: cost,
    budgetUsd: L.maxBudgetUsd,
    maxCalls: L.maxCallsPerSession,
    withinBudget: cost === null ? null : cost <= L.maxBudgetUsd && totalCalls <= L.maxCallsPerSession,
    warnings,
  };
}
