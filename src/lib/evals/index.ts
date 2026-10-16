import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppSettings } from "../config";
import { getDb, nowIso } from "../db/index";
import { createSession, getSession, listVerdicts, type SessionRow } from "../db/repo";
import { cagr, isNum } from "../finance/returns";
import { planEstimate } from "../llm/cost";
import type { ScenarioSetResult } from "../finance/valuation";
import { pointOnOrBefore, type MarketData, type PriceHistory } from "../market-data/types";
import { runSession, type RunnerDeps } from "../orchestrator/runner";
import type { Verdict } from "../types";

/**
 * Evaluation harness. Each case re-runs the committee "as of" a past date
 * (point-in-time mode: only filings and prices available then) and compares
 * its verdicts and scenario CAGRs with what the stock actually did afterwards.
 *
 * Known biases, always printed with the results:
 *  - look-ahead: the language model may remember what happened after the date;
 *  - selection/survivorship: the case tickers are chosen by the user, today;
 *  - price-only returns when the price source has no dividend-adjusted series;
 *  - very small samples: treat metrics as diagnostics, not statistical proof.
 */
export const EvalCaseSchema = z.object({
  name: z.string().min(1),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tickers: z.array(z.string().min(1).max(12).transform((s) => s.toUpperCase())).min(1).max(15),
  horizonYears: z.number().int().min(1).max(10).optional(),
  notes: z.string().optional(),
});
export const EvalFileSchema = z.object({ name: z.string().default("evaluación"), cases: z.array(EvalCaseSchema).min(1).max(20) });
export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalFile = z.infer<typeof EvalFileSchema>;

export const EVAL_CAVEATS = [
  "Sesgo de anticipación: el modelo puede recordar hechos posteriores a la fecha de análisis aunque las herramientas no los devuelvan.",
  "Sesgo de selección/supervivencia: los tickers de cada caso se eligen hoy.",
  "Si la fuente de precios no ofrece serie ajustada por dividendos, la rentabilidad realizada es solo de precio.",
  "Muestras pequeñas: las métricas son diagnósticos, no prueba estadística.",
];

export interface TickerOutcome {
  ticker: string;
  verdict: Verdict | null;
  rank: number | null;
  finalScore: number | null;
  predicted: { bear: number | null; base: number | null; bull: number | null };
  entryPrice: number | null;
  priceAtAsOf: number | null;
  priceAtEnd: number | null;
  endDate: string | null;
  yearsElapsed: number | null;
  realizedCagr: number | null;
  realizedBasis: "total_return" | "price_only" | null;
  complete: boolean;
  note: string | null;
}

export interface CaseResult {
  case: EvalCase;
  sessionId: string;
  status: string;
  convergence: string | null;
  outcomes: TickerOutcome[];
}

function addYears(date: string, years: number) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}

async function historyFor(md: MarketData, ticker: string): Promise<PriceHistory | null> {
  for (const p of md.history) {
    const h = await p.history(ticker).catch(() => null);
    if (h?.points.length) return h;
  }
  return null;
}

/** Realized outcome after the analysis date, from public price history (deterministic, no AI). */
export async function realizedOutcome(md: MarketData, ticker: string, asOf: string, years: number, today = new Date().toISOString().slice(0, 10)): Promise<Pick<TickerOutcome, "priceAtAsOf" | "priceAtEnd" | "endDate" | "yearsElapsed" | "realizedCagr" | "realizedBasis" | "complete" | "note">> {
  const empty = { priceAtAsOf: null, priceAtEnd: null, endDate: null, yearsElapsed: null, realizedCagr: null, realizedBasis: null, complete: false };
  const h = await historyFor(md, ticker);
  if (!h) return { ...empty, note: "Sin histórico de precios" };
  const gap = h.frequency === "monthly" ? 35 : 10;
  const p0 = pointOnOrBefore(h, asOf, gap);
  if (!p0) return { ...empty, note: "Sin precio a la fecha de análisis" };
  const target = addYears(asOf, years);
  const complete = target <= today;
  const p1 = pointOnOrBefore(h, complete ? target : today, complete ? gap : 3650);
  if (!p1 || p1.date <= p0.date) return { ...empty, priceAtAsOf: p0.close, note: "Sin precio final" };
  const elapsed = (Date.parse(p1.date) - Date.parse(p0.date)) / (365.25 * 86_400_000);
  const tr = isNum(p0.totalReturnClose) && isNum(p1.totalReturnClose);
  const realized = tr ? cagr(p1.totalReturnClose!, p0.totalReturnClose!, elapsed) : cagr(p1.close, p0.close, elapsed);
  return {
    priceAtAsOf: p0.close,
    priceAtEnd: p1.close,
    endDate: p1.date,
    yearsElapsed: Math.round(elapsed * 100) / 100,
    realizedCagr: realized,
    realizedBasis: tr ? "total_return" : "price_only",
    complete,
    note: complete ? null : `Horizonte no cumplido: se usa el último precio (${p1.date})`,
  };
}

function spearman(xs: number[], ys: number[]): number | null {
  if (xs.length < 3) return null;
  const rank = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array(v.length);
    idx.forEach(([, i], k) => (r[i] = k + 1));
    return r as number[];
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const d2 = rx.reduce((a, r, i) => a + (r - ry[i]) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

export function computeMetrics(results: CaseResult[], target: number) {
  const all = results.flatMap((r) => r.outcomes).filter((o) => o.verdict && isNum(o.realizedCagr));
  const by = (v: Verdict) => all.filter((o) => o.verdict === v);
  const buys = by("POTENTIAL_BUY");
  const scored = all.filter((o) => isNum(o.finalScore));
  const withBase = all.filter((o) => isNum(o.predicted.base));
  const withRange = all.filter((o) => isNum(o.predicted.bear) && isNum(o.predicted.bull));
  return {
    evaluatedCompanies: all.length,
    completeHorizon: all.filter((o) => o.complete).length,
    buys: {
      count: buys.length,
      meanRealizedCagr: mean(buys.map((o) => o.realizedCagr!)),
      hitRate: buys.length ? buys.filter((o) => o.realizedCagr! >= target).length / buys.length : null,
    },
    meanRealizedByVerdict: Object.fromEntries((["POTENTIAL_BUY", "EXCELLENT_TOO_EXPENSIVE", "WATCHLIST", "EXCLUDE", "PENDING_VERIFICATION"] as Verdict[]).map((v) => [v, { n: by(v).length, mean: mean(by(v).map((o) => o.realizedCagr!)) }])),
    spearmanScoreVsRealized: spearman(scored.map((o) => o.finalScore!), scored.map((o) => o.realizedCagr!)),
    baseCagrMeanAbsError: mean(withBase.map((o) => Math.abs(o.predicted.base! - o.realizedCagr!))),
    bearBreachRate: withRange.length ? withRange.filter((o) => o.realizedCagr! < o.predicted.bear!).length / withRange.length : null,
    withinBearBullRate: withRange.length ? withRange.filter((o) => o.realizedCagr! >= o.predicted.bear! && o.realizedCagr! <= o.predicted.bull!).length / withRange.length : null,
    target,
    caveats: EVAL_CAVEATS,
  };
}
export type EvalMetrics = ReturnType<typeof computeMetrics>;

export function caseSettings(base: AppSettings, c: EvalCase): AppSettings {
  const s = structuredClone(base);
  s.investment = { ...s.investment, asOfDate: c.asOf, userTickers: c.tickers, userTickersOnly: true, horizonYears: c.horizonYears ?? s.investment.horizonYears, maxCandidates: Math.max(c.tickers.length, 1), maxDebateCompanies: Math.min(s.investment.maxDebateCompanies, c.tickers.length) };
  return s;
}

export function estimateEval(base: AppSettings, file: EvalFile) {
  const perCase = file.cases.map((c) => ({ name: c.name, estimate: planEstimate(caseSettings(base, c), c.tickers.length) }));
  const cost = perCase.every((p) => p.estimate.estCostUsd !== null) ? perCase.reduce((a, p) => a + (p.estimate.estCostUsd ?? 0), 0) : null;
  return { perCase, totalCalls: perCase.reduce((a, p) => a + p.estimate.totalCalls, 0), estCostUsd: cost, maxBudgetUsd: base.limits.maxBudgetUsd * file.cases.length };
}

/** Runs one case end-to-end with the given dependency factory and returns its outcomes. */
export async function runEvalCase(c: EvalCase, mode: "demo" | "live", base: AppSettings, makeDeps: (s: SessionRow) => RunnerDeps, today?: string): Promise<CaseResult> {
  const settings = caseSettings(base, c);
  const s = createSession({ mode, settings });
  const deps = makeDeps(getSession(s.id)!);
  const out = await runSession(s.id, deps);
  const years = settings.investment.horizonYears;
  const verdicts = listVerdicts(s.id);
  const outcomes: TickerOutcome[] = [];
  for (const t of c.tickers) {
    const v = verdicts.find((x) => x.ticker === t) ?? null;
    const sc = (v?.content as { scenarios?: ScenarioSetResult | null } | undefined)?.scenarios ?? null;
    const real = await realizedOutcome(deps.md, t, c.asOf, years, today);
    outcomes.push({
      ticker: t,
      verdict: v?.verdict ?? null,
      rank: v?.rank ?? null,
      finalScore: v?.finalScore ?? null,
      predicted: { bear: sc?.scenarios.bear.totalCagr ?? null, base: sc?.scenarios.base.totalCagr ?? null, bull: sc?.scenarios.bull.totalCagr ?? null },
      entryPrice: sc?.proposedEntryPrice ?? null,
      ...real,
      note: v ? real.note : [real.note, "Sin veredicto (no debatida o sesión incompleta)"].filter(Boolean).join(" · "),
    });
  }
  return { case: c, sessionId: s.id, status: out.status, convergence: out.convergence, outcomes };
}

export interface EvalRunRow {
  id: string;
  createdAt: string;
  name: string;
  mode: string;
  status: string;
  cases: EvalCase[];
  results: CaseResult[] | null;
  metrics: EvalMetrics | null;
  error: string | null;
}

export function saveEvalRun(r: EvalRunRow) {
  getDb()
    .prepare("INSERT INTO evals (id, created_at, name, mode, status, cases_json, results_json, metrics_json, error) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, results_json = excluded.results_json, metrics_json = excluded.metrics_json, error = excluded.error")
    .run(r.id, r.createdAt, r.name, r.mode, r.status, JSON.stringify(r.cases), JSON.stringify(r.results), JSON.stringify(r.metrics), r.error);
}

export function listEvalRuns(limit = 20): EvalRunRow[] {
  return (getDb().prepare("SELECT * FROM evals ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    createdAt: r.created_at as string,
    name: r.name as string,
    mode: r.mode as string,
    status: r.status as string,
    cases: JSON.parse(r.cases_json as string),
    results: r.results_json ? JSON.parse(r.results_json as string) : null,
    metrics: r.metrics_json ? JSON.parse(r.metrics_json as string) : null,
    error: (r.error as string) ?? null,
  }));
}

export async function runEval(file: EvalFile, mode: "demo" | "live", base: AppSettings, makeDeps: (s: SessionRow) => RunnerDeps, opts: { today?: string; onCase?: (r: CaseResult) => void } = {}): Promise<EvalRunRow> {
  const row: EvalRunRow = { id: randomUUID(), createdAt: nowIso(), name: file.name, mode, status: "RUNNING", cases: file.cases, results: [], metrics: null, error: null };
  saveEvalRun(row);
  try {
    for (const c of file.cases) {
      const r = await runEvalCase(c, mode, base, makeDeps, opts.today);
      row.results!.push(r);
      opts.onCase?.(r);
      saveEvalRun(row);
    }
    row.metrics = computeMetrics(row.results!, base.investment.targetAnnualReturn);
    row.status = "COMPLETED";
  } catch (e) {
    row.status = "FAILED";
    row.error = e instanceof Error ? e.message : String(e);
  }
  saveEvalRun(row);
  return row;
}

const p = (x: number | null | undefined) => (isNum(x) ? `${(x * 100).toFixed(1)}%` : "n/d");

export function evalMarkdown(r: EvalRunRow): string {
  const m = r.metrics;
  const lines = [
    `# Evaluación ATLAS — ${r.name}`,
    `> Modo: ${r.mode === "demo" ? "DEMOSTRACIÓN (datos y agentes SINTÉTICOS)" : "real"} · ${r.createdAt} · estado ${r.status}`,
    "",
    "## Métricas",
    m
      ? [
          `- Empresas evaluadas: ${m.evaluatedCompanies} (horizonte completo: ${m.completeHorizon})`,
          `- Compras potenciales: ${m.buys.count} · CAGR realizado medio ${p(m.buys.meanRealizedCagr)} · tasa de acierto (≥ objetivo ${p(m.target)}): ${p(m.buys.hitRate)}`,
          `- Correlación de Spearman puntuación ↔ CAGR realizado: ${m.spearmanScoreVsRealized?.toFixed(2) ?? "n/d"}`,
          `- Error absoluto medio del CAGR base: ${p(m.baseCagrMeanAbsError)}`,
          `- Realizado por debajo del escenario bajista: ${p(m.bearBreachRate)} · dentro del rango bajista–alcista: ${p(m.withinBearBullRate)}`,
          ...Object.entries(m.meanRealizedByVerdict).map(([v, x]) => `- ${v}: n=${x.n}, CAGR realizado medio ${p(x.mean)}`),
        ].join("\n")
      : "_Sin métricas_",
    "",
    "## Casos",
  ];
  for (const c of r.results ?? []) {
    lines.push(`### ${c.case.name} — a fecha ${c.case.asOf} (sesión ${c.sessionId.slice(0, 8)}, ${c.status}, ${c.convergence ?? "n/d"})`, "", "| Ticker | Veredicto | Puntuación | CAGR previsto bajista/base/alcista | CAGR realizado | Base | Nota |", "|---|---|---|---|---|---|---|");
    for (const o of c.outcomes) lines.push(`| ${o.ticker} | ${o.verdict ?? "—"} | ${o.finalScore?.toFixed(1) ?? "n/d"} | ${p(o.predicted.bear)} / ${p(o.predicted.base)} / ${p(o.predicted.bull)} | ${p(o.realizedCagr)} | ${o.realizedBasis ?? "—"} | ${o.note ?? ""} |`);
    lines.push("");
  }
  lines.push("## Advertencias", ...EVAL_CAVEATS.map((x) => `- ${x}`), "", "Los resultados pasados no garantizan resultados futuros.");
  return lines.join("\n");
}

export function writeEvalReport(r: EvalRunRow, dir = path.join(process.cwd(), "data", "evals")): string {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `eval-${r.createdAt.slice(0, 10)}-${r.id.slice(0, 8)}.md`);
  fs.writeFileSync(f, evalMarkdown(r));
  return f;
}

export const DEMO_EVAL: EvalFile = {
  name: "Demostración (sintética)",
  cases: [{ name: "Universo DEMO a mediados de 2021", asOf: "2021-06-30", tickers: ["DEMO-A", "DEMO-B", "DEMO-C", "DEMO-E", "DEMO-F"], horizonYears: 3, notes: "Datos sintéticos: valida el arnés, no el criterio del comité." }],
};
