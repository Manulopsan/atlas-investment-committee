import { getDb, tx } from "../db/index";
import {
  completeTask,
  createIssue,
  ensureTask,
  failTask,
  freezeInitialReports,
  getMessage,
  getSession,
  initialReport,
  insertHypothesis,
  insertMessage,
  insertReport,
  latestReport,
  listCandidates,
  listHypotheses,
  listIssues,
  listMessages,
  listTasks,
  logError,
  markTaskRunning,
  requeueInterruptedTasks,
  saveCandidates,
  saveFinalReport,
  saveVerdicts,
  transitionSession,
  updateIssue,
  updateSession,
  usageTotals,
  type IssueRow,
  type SessionRow,
  type VerdictRow,
} from "../db/repo";
import { addEvidence, citationStatus, listEvidence, shortId } from "../evidence/registry";
import { allowedVerdict, finalScore, rankFinalists, reconcileVerdict, SCORING_METHOD } from "../finance/scoring";
import { computeScenarios, SCENARIO_FORMULA } from "../finance/valuation";
import { eurCagr, fxSensitivity, TOTAL_RETURN_METHOD } from "../finance/returns";
import { discoverCandidates } from "../market-data/discovery";
import { PROFILES, totalScore } from "../agents/profiles";
import { postRound1Context, round1Context } from "../agents/broker";
import {
  CioTurnSchema,
  CrossReviewSchema,
  DebateTurnSchema,
  FinalDecisionSchema,
  initialReportSchema,
  revisionSchema,
  SelectiveAgendaSchema,
  selectiveAnswerSchema,
  VerificationSchema,
  type CioTurnT,
  type CrossReviewT,
  type DebateMessageT,
  type FinalDecisionT,
  type InitialReportT,
  type RevisionCompanyT,
  type SelectiveAgendaT,
  type StoredReport,
  type StoredRevision,
  type VerificationT,
  type VetoT,
} from "../agents/schemas";
import { BudgetExceededError, planEstimate, StopRequestedError } from "../llm/cost";
import { AGENT_ROLES, ROLE_LABELS, VERDICT_LABELS, type AgentRole, type Convergence, type SessionStatus, type Verdict } from "../types";
import { runAgentTask, type OrchestratorDeps } from "./agentTask";
import { companySnapshot, type CompanySnapshot } from "./companyState";
import {
  candidatesBlock,
  evidenceBlock,
  issuesBlock,
  objectiveBlock,
  reportDigest,
  revisionDigest,
  round1Prompt,
  threadBlock,
} from "./prompts";
import { TERMINAL_STATUSES } from "../state";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export type RunnerDeps = Omit<OrchestratorDeps, "isStopRequested">;

export class PhaseFailedError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PhaseFailedError";
  }
}

const DEBATE_TOOLS = ["get_evidence", "verify_source", "get_company_financials", "get_price", "compute_valuation", "compute_dcf", "search_sec_filings", "record_claim", "save_note"];
const VERIFY_TOOLS = ["get_evidence", "verify_source", "get_company_financials", "get_price", "get_company_profile", "search_sec_filings"];
const ROUND1_TOOLS = ["get_company_financials", "get_price", "get_fx_rate", "get_company_profile", "search_sec_filings", "verify_source", "record_claim", "get_evidence", "compute_valuation", "compute_dcf", "save_note"];

/* ----------------------------- utilities ---------------------------- */

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (e) {
        results[i] = { status: "rejected", reason: e };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function isRetryable(e: unknown) {
  if (e instanceof BudgetExceededError || e instanceof StopRequestedError) return false;
  if (e instanceof Anthropic.APIError) return e.status === undefined || e.status === 429 || e.status >= 500;
  return e instanceof Error && (e.name === "AgentOutputError" || e.name === "APIConnectionError");
}

/**
 * Run a task at most once to success. A SUCCEEDED task is never re-executed
 * (resume does not duplicate AI calls). The model call and the side effects
 * are separated: `apply` runs in one transaction together with marking the
 * task as succeeded, so an interruption cannot leave half-applied results.
 */
async function runTask<T>(
  s: SessionRow,
  deps: RunnerDeps,
  key: string,
  meta: { phase: string; agentRole?: AgentRole | null; ticker?: string | null },
  work: () => Promise<T>,
  apply?: (out: T) => unknown,
): Promise<T> {
  const t = ensureTask(s.id, key, meta);
  if (t.status === "SUCCEEDED" || t.status === "SKIPPED") return t.result as T;
  const retries = s.settings.limits.taskRetries;
  for (let attempt = 0; ; attempt++) {
    if (getSession(s.id)?.stopRequested) throw new StopRequestedError();
    markTaskRunning(s.id, key);
    try {
      const out = await work();
      tx(getDb(), () => {
        const stored = apply ? apply(out) : out;
        completeTask(s.id, key, stored ?? out);
      });
      return out;
    } catch (e) {
      if (e instanceof BudgetExceededError || e instanceof StopRequestedError) {
        failTask(s.id, key, e.message, "CANCELLED");
        throw e;
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < retries && isRetryable(e)) {
        logError(s.id, { taskKey: key, phase: meta.phase, message: `Reintento ${attempt + 1}: ${msg}` });
        continue;
      }
      failTask(s.id, key, msg);
      logError(s.id, { taskKey: key, phase: meta.phase, message: msg, details: e instanceof Error ? e.stack?.slice(0, 2000) : null });
      throw e;
    }
  }
}

const iter = (s: SessionRow, n: number) => Math.max(2, Math.min(n, s.settings.limits.maxToolIterations));

function storedReport(role: AgentRole, out: InitialReportT, model: string, sessionId: string): StoredReport {
  const totals: Record<string, number> = {};
  const cites: StoredReport["citation_check"] = {};
  for (const c of out.companies) {
    totals[c.ticker] = Math.round(totalScore(role, c.scores) * 10) / 10;
    cites[c.ticker] = citationStatus(sessionId, c.metrics.map((m) => m.evidence_id).filter((x): x is string => Boolean(x)));
  }
  return { ...out, role, generated_at: new Date().toISOString(), model, totals, citation_check: cites };
}

function validReplyTo(sessionId: string, id: number | null): number | null {
  if (!id) return null;
  const m = getMessage(id);
  return m && m.sessionId === sessionId ? id : null;
}

function writeMessage(s: SessionRow, round: number, phase: string, from: AgentRole, ticker: string | null, m: DebateMessageT, taskKey: string) {
  const row = insertMessage({
    sessionId: s.id,
    round,
    phase,
    ticker,
    fromRole: from,
    toRole: m.to,
    type: m.type,
    claim: m.claim,
    evidenceText: m.evidence || null,
    evidenceIds: m.evidence_ids,
    question: m.question,
    expectedOutcome: m.expected_outcome,
    inReplyTo: validReplyTo(s.id, m.in_reply_to),
    taskKey,
  });
  if (m.factual_dispute && ticker) {
    const d = m.factual_dispute;
    createIssue({
      sessionId: s.id,
      ticker,
      kind: "FACTUAL_DISPUTE",
      critical: m.type === "OBJECTION",
      title: `Discrepancia factual: ${d.metric} ${d.period} (${ticker})`,
      description: m.claim,
      claims: [
        { by: m.to === "ALL" ? "SYSTEM" : m.to, statement: `Valor reportado: ${d.reported_value ?? "n/d"} ${d.unit}`, value: d.reported_value, unit: d.unit },
        { by: from, statement: `Valor alternativo: ${d.alternative_value ?? "n/d"} ${d.unit} — ${m.evidence}`, value: d.alternative_value, unit: d.unit, evidenceIds: m.evidence_ids },
      ],
      evidenceIds: m.evidence_ids,
      createdBy: from,
      sourceMessageId: row.id,
      assignedTo: m.to !== "ALL" && m.to !== from ? (m.to as AgentRole) : null,
    });
  }
  return row;
}

/* ------------------------------- phases ----------------------------- */

async function phaseDiscovery(s: SessionRow, deps: RunnerDeps) {
  if (s.mode === "live" && deps.md.synthetic) throw new Error("Una sesión real no puede usar datos sintéticos");
  if (s.mode === "demo" && !deps.md.synthetic) throw new Error("El modo demostración solo usa datos sintéticos");
  const res = await runTask(s, deps, "discovery", { phase: "DISCOVERY" }, () => discoverCandidates(deps.md, s.config), (r) => {
    saveCandidates(s.id, r.candidates);
    updateSession(s.id, { coverage: r.coverage });
    return { coverage: r.coverage, log: r.log, count: r.candidates.length };
  });
  const included = listCandidates(s.id, true).length;
  if (s.mode === "dry_run") {
    updateSession(s.id, { estimate: planEstimate(s.settings, Math.max(1, included)) });
    transitionSession(s.id, "DRY_RUN_COMPLETE");
    return;
  }
  if (!included) {
    throw new PhaseFailedError(`El descubrimiento no produjo candidatas analizables (${res.coverage?.description ?? ""}). Revise las fuentes, el SEC_USER_AGENT o importe tickers por CSV.`);
  }
  transitionSession(s.id, "ROUND_1_RUNNING");
}

async function phaseRound1(s: SessionRow, deps: RunnerDeps) {
  const settle = await mapLimit([...AGENT_ROLES], s.settings.limits.concurrency, (role) => {
    const ctx = round1Context(s.id, role);
    return runTask(
      s,
      deps,
      `r1:${role}`,
      { phase: "ROUND_1", agentRole: role },
      async () => {
        const r = await runAgentTask(
          {
            sessionId: s.id,
            taskKey: `r1:${role}`,
            phase: "ROUND_1",
            role,
            model: s.settings.model,
            prompt: round1Prompt(role, s.config, ctx.candidates, ctx.ownNotes),
            dataTools: ROUND1_TOOLS,
            submit: { name: "submit_initial_report", description: "Entrega tu informe inicial (ronda 1). Se valida y queda congelado al cerrar la ronda.", schema: initialReportSchema(role) },
            maxIterations: s.settings.limits.maxToolIterations,
            round1: true,
          },
          { ...deps, isStopRequested: () => Boolean(getSession(s.id)?.stopRequested) },
        );
        return storedReport(role, r.output as InitialReportT, r.model, s.id);
      },
      (rep) => {
        insertReport(s.id, role, "INITIAL", "ROUND_1", rep, `r1:${role}`);
        return { reportStored: true, companies: rep.companies.length };
      },
    );
  });
  const control = settle.find((r) => r.status === "rejected" && (r.reason instanceof BudgetExceededError || r.reason instanceof StopRequestedError));
  if (control && control.status === "rejected") throw control.reason;
  const failed = AGENT_ROLES.filter((_, i) => settle[i].status === "rejected");
  if (failed.length) {
    throw new PhaseFailedError(`Ronda 1 incompleta: fallaron ${failed.map((r) => ROLE_LABELS[r]).join(", ")}. Los informes completados se conservan; reintente solo los agentes fallidos.`);
  }
  // All four reports exist: freeze them and close the round atomically.
  tx(getDb(), () => {
    const initial = AGENT_ROLES.map((r) => initialReport(s.id, r));
    if (initial.some((x) => !x)) throw new PhaseFailedError("Faltan informes iniciales");
    freezeInitialReports(s.id);
    transitionSession(s.id, "ROUND_1_COMPLETE");
  });
}

function agendaTickers(s: SessionRow): string[] {
  const t = listTasks(s.id).find((x) => x.taskKey === "agenda" && x.status === "SUCCEEDED");
  const stored = (t?.result as { tickers?: string[] } | undefined)?.tickers;
  return (stored ?? computeAgenda(s).tickers).slice(0, s.config.maxDebateCompanies);
}

async function phaseCrossReview(s: SessionRow, deps: RunnerDeps) {
  const ctx = postRound1Context(s.id, "CIO");
  const fullReports = AGENT_ROLES.map((r) => reportDigest(ctx.reports[r].initial?.content as StoredReport, { heading: `Informe inicial congelado — ${ROLE_LABELS[r]}` })).join("\n\n");
  const settle = await mapLimit([...AGENT_ROLES], s.settings.limits.concurrency, (role) =>
    runTask(
      s,
      deps,
      `r2a:${role}`,
      { phase: "CROSS_REVIEW", agentRole: role },
      async () => {
        const own = postRound1Context(s.id, role);
        const prompt = [
          "FASE: RONDA 2A — LECTURA CRUZADA. La primera ronda está cerrada y los cuatro informes iniciales están congelados.",
          objectiveBlock(s.config),
          "LOS CUATRO INFORMES INICIALES (incluido el tuyo):",
          fullReports,
          evidenceBlock(s.id),
          own.ownNotes.length ? `TUS NOTAS PRIVADAS:\n${own.ownNotes.join("\n")}` : "",
          "Evalúa la evidencia de los demás, no te limites a defender tu rol. Identifica: tres argumentos sólidos de otros participantes; tres objeciones importantes; errores factuales potenciales (con la cifra reportada y la alternativa); hipótesis de valoración discutibles; preguntas que deben resolverse; empresas que deberían entrar o salir de la lista final; y prioridad de debate.",
          "Entrega con submit_cross_review.",
        ].filter(Boolean).join("\n\n");
        const r = await runAgentTask(
          { sessionId: s.id, taskKey: `r2a:${role}`, phase: "CROSS_REVIEW", role, model: s.settings.debateModel, prompt, dataTools: ["get_evidence", "verify_source", "get_company_financials", "get_price"], submit: { name: "submit_cross_review", description: "Entrega tu lectura cruzada.", schema: CrossReviewSchema }, maxIterations: iter(s, 4) },
          { ...deps, isStopRequested: () => Boolean(getSession(s.id)?.stopRequested) },
        );
        return r.output as CrossReviewT;
      },
      (out) => {
        const key = `r2a:${role}`;
        for (const a of out.strong_arguments) {
          insertMessage({ sessionId: s.id, round: 2, phase: "CROSS_REVIEW", ticker: a.ticker, fromRole: role, toRole: a.about_role, type: "ARGUMENT", claim: `Argumento sólido: ${a.summary}`, evidenceText: null, evidenceIds: [], question: null, expectedOutcome: "Reconocer el argumento en la revisión", inReplyTo: null, taskKey: key });
        }
        for (const o of out.objections) {
          writeMessage(s, 2, "CROSS_REVIEW", role, o.ticker, { to: o.target_role, type: "OBJECTION", claim: o.claim, evidence: o.evidence, evidence_ids: o.evidence_ids, question: null, expected_outcome: `Respuesta del ${ROLE_LABELS[o.target_role]} (gravedad ${o.severity})`, in_reply_to: null, factual_dispute: null }, key);
        }
        for (const f of out.potential_factual_errors) {
          writeMessage(s, 2, "CROSS_REVIEW", role, f.ticker, { to: f.target_role, type: "OBJECTION", claim: `Posible error factual: ${f.explanation}`, evidence: f.explanation, evidence_ids: f.evidence_ids, question: `¿Cuál es el valor correcto de ${f.dispute.metric} (${f.dispute.period})?`, expected_outcome: "Comprobación documental", in_reply_to: null, factual_dispute: f.dispute }, key);
        }
        for (const q of out.questionable_assumptions) {
          insertMessage({ sessionId: s.id, round: 2, phase: "CROSS_REVIEW", ticker: q.ticker, fromRole: role, toRole: q.target_role, type: "OBJECTION", claim: `Hipótesis discutible: ${q.assumption}`, evidenceText: q.why, evidenceIds: [], question: "¿Puede justificar esta hipótesis?", expectedOutcome: "Hipótesis explícita o revisada", inReplyTo: null, taskKey: key });
        }
        for (const q of out.open_questions) {
          insertMessage({ sessionId: s.id, round: 2, phase: "CROSS_REVIEW", ticker: q.ticker, fromRole: role, toRole: q.addressed_to, type: "EVIDENCE_REQUEST", claim: q.question, evidenceText: null, evidenceIds: [], question: q.question, expectedOutcome: "Respuesta con evidencia", inReplyTo: null, taskKey: key });
        }
        return out;
      },
    ),
  );
  const control = settle.find((r) => r.status === "rejected" && (r.reason instanceof BudgetExceededError || r.reason instanceof StopRequestedError));
  if (control && control.status === "rejected") throw control.reason;
  const failed = AGENT_ROLES.filter((_, i) => settle[i].status === "rejected");
  if (failed.length) throw new PhaseFailedError(`Lectura cruzada incompleta: fallaron ${failed.map((r) => ROLE_LABELS[r]).join(", ")}`);

  // Deterministic debate agenda (stored as a task so it is stable on resume).
  await runTask(s, deps, "agenda", { phase: "CROSS_REVIEW" }, async () => computeAgenda(s));
}

/** Agenda = mean of initial scores (risk inverted) + priority requested by the agents in the cross-review. */
function computeAgenda(s: SessionRow): { tickers: string[]; method: string } {
  const reviews = AGENT_ROLES.map((r) => listTasks(s.id).find((t) => t.taskKey === `r2a:${r}` && t.status === "SUCCEEDED")?.result as CrossReviewT | undefined);
  const included = new Set(listCandidates(s.id, true).map((c) => c.ticker));
  const score = new Map<string, number>();
  for (const t of included) {
    const v = (role: AgentRole) => (initialReport(s.id, role)?.content as StoredReport | undefined)?.totals?.[t];
    const risk = v("RISK");
    const parts = [v("QUALITY"), v("VALUATION"), v("CIO"), risk !== undefined ? 100 - risk : undefined].filter((x): x is number => typeof x === "number");
    if (parts.length < 2) continue; // analysed by fewer than two agents
    let sc = parts.reduce((a, b) => a + b, 0) / parts.length;
    reviews.forEach((rv, i) => {
      if (rv?.debate_priority.includes(t)) sc += AGENT_ROLES[i] === "CIO" ? 10 : 4;
      if (rv?.list_changes.remove.some((x) => x.ticker === t)) sc -= 3;
      if (rv?.list_changes.add.some((x) => x.ticker === t)) sc += 3;
    });
    score.set(t, sc);
  }
  const tickers = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, s.config.maxDebateCompanies);
  return { tickers, method: "Media de puntuaciones iniciales (riesgo invertido) + prioridad pedida por los agentes en la lectura cruzada (CIO +10, analistas +4); mínimo dos agentes deben haber analizado la empresa." };
}

function tickerContext(s: SessionRow, role: AgentRole, ticker: string) {
  const ctx = postRound1Context(s.id, role);
  const reports = AGENT_ROLES.map((r) => {
    const latest = ctx.reports[r].latest;
    const init = reportDigest(ctx.reports[r].initial?.content as StoredReport, { tickers: [ticker], heading: `Informe inicial — ${ROLE_LABELS[r]}` });
    const rev = latest && latest.kind === "REVISION" ? `\n${revisionDigest(latest.content as StoredRevision, [ticker])}` : "";
    return init + rev;
  }).join("\n\n");
  return { reports, notes: ctx.ownNotes };
}

async function debateTurn(s: SessionRow, deps: RunnerDeps, ticker: string, role: AgentRole, step: string, instruction: string, isCio: boolean) {
  const key = `r2b:${ticker}:${step}:${role}`;
  return runTask(
    s,
    deps,
    key,
    { phase: "DEBATE", agentRole: role, ticker },
    async () => {
      const tc = tickerContext(s, role, ticker);
      const prompt = [
        `FASE: RONDA 2B — DEBATE ESTRUCTURADO sobre ${ticker}. Hablas como ${ROLE_LABELS[role]}.`,
        objectiveBlock(s.config),
        "INFORMES (extracto de la empresa):",
        tc.reports,
        `HILO DEL DEBATE SOBRE ${ticker} (incluye la lectura cruzada):`,
        threadBlock(listMessages(s.id, { ticker })),
        `INCIDENCIAS SOBRE ${ticker}:`,
        issuesBlock(listIssues(s.id, { ticker })),
        evidenceBlock(s.id, [ticker]),
        tc.notes.length ? `TUS NOTAS PRIVADAS:\n${tc.notes.join("\n")}` : "",
        instruction,
        "Cada mensaje debe tener destinatario, tipo (ARGUMENT, OBJECTION, RESPONSE, EVIDENCE_REQUEST o REVISION), afirmación concreta, evidencia disponible (EV-n), pregunta a resolver y resultado esperado. Usa in_reply_to con el #id del mensaje al que respondes. Si discutes una cifra verificable, rellena factual_dispute.",
        `Entrega con ${isCio ? "submit_cio_turn" : "submit_debate_turn"}.`,
      ].filter(Boolean).join("\n\n");
      const r = await runAgentTask(
        {
          sessionId: s.id,
          taskKey: key,
          phase: "DEBATE",
          role,
          model: s.settings.debateModel,
          prompt,
          dataTools: DEBATE_TOOLS,
          submit: isCio
            ? { name: "submit_cio_turn", description: "Mensajes del CIO y controversias abiertas.", schema: CioTurnSchema }
            : { name: "submit_debate_turn", description: "Tus mensajes en este turno del debate.", schema: DebateTurnSchema },
          maxIterations: iter(s, 4),
        },
        { ...deps, isStopRequested: () => Boolean(getSession(s.id)?.stopRequested) },
      );
      return r.output as { messages: DebateMessageT[]; controversies?: CioTurnT["controversies"] };
    },
    (out) => {
      const ids = out.messages.map((m) => writeMessage(s, 2, "DEBATE", role, ticker, m, key).id);
      if (isCio && out.controversies) applyControversies(s, ticker, out.controversies, ids[0] ?? null);
      return { ...out, messageIds: ids };
    },
  );
}

function applyControversies(s: SessionRow, ticker: string, list: CioTurnT["controversies"], sourceMessageId: number | null) {
  const price = listEvidence(s.id, { ticker, metric: "price" }).filter((e) => e.verification === "VERIFIED").sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))[0];
  for (const c of list) {
    const kind = c.kind === "FACTUAL" ? "FACTUAL_DISPUTE" : c.kind;
    const issue = createIssue({
      sessionId: s.id,
      ticker,
      kind,
      critical: c.critical,
      title: `${c.kind === "FACTUAL" ? "Controversia factual" : c.kind === "FORECAST" ? "Discrepancia de previsión" : "Discrepancia de criterio"}: ${c.description.slice(0, 90)}`,
      description: `${c.description} — acción solicitada: ${c.action}`,
      claims: c.dispute
        ? [
            { by: "SYSTEM", statement: `Valor reportado: ${c.dispute.reported_value ?? "n/d"} ${c.dispute.unit}`, value: c.dispute.reported_value, unit: c.dispute.unit },
            { by: "CIO", statement: `Valor alternativo: ${c.dispute.alternative_value ?? "n/d"} ${c.dispute.unit}`, value: c.dispute.alternative_value, unit: c.dispute.unit },
          ]
        : [{ by: "CIO", statement: c.description }],
      createdBy: "CIO",
      sourceMessageId,
      assignedTo: c.assigned_to,
    });
    if (c.kind === "FORECAST") {
      // Forecast disagreements are not "resolved": each hypothesis is recorded with its computed consequence.
      for (const a of c.alternatives) {
        const r = computeScenarios({
          referencePrice: price?.value ?? null,
          years: s.config.horizonYears,
          discountRate: s.config.discountRate,
          target: s.config.targetAnnualReturn,
          requiredMos: s.config.requiredMarginOfSafety,
          scenarios: { base: { metric: "EPS", metricYearN: a.metric_year_n, exitMultiple: a.exit_multiple, cumulativeDividendsPerShare: a.cumulative_dividends_per_share } },
        });
        insertHypothesis({
          sessionId: s.id,
          issueId: issue.id,
          ticker,
          label: a.label,
          proposedBy: a.proposed_by,
          assumptions: a,
          consequence: { valueYearN: r.scenarios.base.valueYearN, totalCagr: r.scenarios.base.totalCagr, maxPriceForTarget: r.maxPriceForTarget, referencePrice: r.referencePrice, priceEvidence: price ? shortId(price.id) : null },
        });
      }
    }
  }
}

async function phaseDebate(s: SessionRow, deps: RunnerDeps) {
  for (const ticker of agendaTickers(s)) {
    await debateTurn(s, deps, ticker, "QUALITY", "1", `Paso 1: expón la tesis empresarial de ${ticker} (ARGUMENT) y responde a las objeciones de la lectura cruzada dirigidas a ti, si las hay.`, false);
    await debateTurn(s, deps, ticker, "VALUATION", "2", `Paso 2: cuestiona el precio y los retornos esperados de ${ticker} (OBJECTION o ARGUMENT). Dirígete al Quality Analyst o al comité.`, false);
    await debateTurn(s, deps, ticker, "RISK", "3", `Paso 3: plantea objeciones concretas a la tesis de ${ticker} (OBJECTION), con evidencia. Puedes dirigirte a cualquier analista.`, false);
    // Step 4: the analysts targeted by objections answer directly (agent-to-agent, not only to the CIO).
    const targeted = new Set(
      listMessages(s.id, { ticker })
        .filter((m) => m.type === "OBJECTION" || m.type === "EVIDENCE_REQUEST")
        .map((m) => m.toRole)
        .filter((r): r is AgentRole => r !== "ALL" && r !== "CIO"),
    );
    for (const role of (["QUALITY", "VALUATION", "RISK"] as AgentRole[]).filter((r) => targeted.has(r))) {
      const pending = listMessages(s.id, { ticker }).filter((m) => m.toRole === role && (m.type === "OBJECTION" || m.type === "EVIDENCE_REQUEST")).map((m) => `#${m.id}`);
      await debateTurn(s, deps, ticker, role, "4", `Paso 4: responde (RESPONSE, con in_reply_to) a las objeciones y peticiones dirigidas a ti: ${pending.join(", ")}. Acepta lo que la evidencia respalde y rebate lo demás. Puedes pedir evidencia a otro analista.`, false);
    }
    await debateTurn(s, deps, ticker, "CIO", "5", `Paso 5: como CIO, determina qué controversias sobre ${ticker} siguen abiertas, clasifícalas (FACTUAL, FORECAST, JUDGEMENT), asigna responsable y acción (VERIFY, RECALCULATE, RESPOND). Para discrepancias de previsión registra las hipótesis alternativas (alternatives). Exige respuestas directas cuando falten.`, true);
  }
}

const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
const METRIC_ALIASES: Record<string, string> = { revenues: "revenue", ingresos: "revenue", sales: "revenue", ventas: "revenue", operatingincomeloss: "operatingIncome", ebit: "operatingIncome", resultadooperativo: "operatingIncome", fco: "operatingCashFlow", ocf: "operatingCashFlow", fcf: "free_cash_flow", freecashflow: "free_cash_flow", capex: "capex", netincome: "netIncome", eps: "epsDiluted", price: "price", precio: "price" };

function deterministicResolution(s: SessionRow, issue: IssueRow): { evidenceId: string; value: number } | null {
  const claim = issue.claims.find((c) => c.value !== undefined && c.value !== null);
  const metricRaw = /:\s*([^()]+?)\s+(FY\d{4}|Q\d)/.exec(issue.title)?.[1] ?? "";
  const periodRaw = /(FY\d{4})/.exec(issue.title)?.[1] ?? null;
  const metric = METRIC_ALIASES[norm(metricRaw)] ?? metricRaw.trim();
  if (!issue.ticker || !metric || !periodRaw || !claim) return null;
  const ev = listEvidence(s.id, { ticker: issue.ticker, metric }).filter((e) => e.period === periodRaw && e.verification === "VERIFIED" && e.createdBy.startsWith("system:") && e.value !== null);
  if (ev.length !== 1) return null; // ambiguous or absent → needs documentary check
  return { evidenceId: ev[0].id, value: ev[0].value! };
}

async function phaseVerification(s: SessionRow, deps: RunnerDeps) {
  const cap = s.settings.limits.maxVerificationsPerCompany;
  const tickers = agendaTickers(s);
  for (const ticker of tickers) {
    const open = listIssues(s.id, { ticker, status: ["OPEN"] }).filter((i) => i.kind === "FACTUAL_DISPUTE" || i.kind === "DATA_CONFLICT");
    let used = listTasks(s.id).filter((t) => t.taskKey.startsWith(`r2c:${ticker}:`) && t.status !== "PENDING").length;
    for (const issue of open) {
      const det = deterministicResolution(s, issue);
      if (det) {
        updateIssue(issue.id, "system:verification", { status: "RESOLVED", resolution: `Resuelta con dato reportado verificado ${shortId(det.evidenceId)} = ${det.value}. Una cifra verificable no se decide por votación.`, resolvedValue: det.value, addEvidenceIds: [det.evidenceId] });
        insertMessage({ sessionId: s.id, round: 2, phase: "VERIFICATION", ticker, fromRole: "CIO", toRole: "ALL", type: "RESPONSE", claim: `Incidencia #${issue.id} resuelta por comprobación documental: ${det.value}`, evidenceText: "Registro de evidencias (dato del 10-K)", evidenceIds: [shortId(det.evidenceId)], question: null, expectedOutcome: "Cifra corregida en las revisiones", inReplyTo: issue.sourceMessageId, taskKey: `r2c:det:${issue.id}` });
        continue;
      }
      if (used >= cap) {
        updateIssue(issue.id, "system:verification", { status: "PENDING", resolution: `Pendiente: se alcanzó el máximo de ${cap} verificaciones para ${ticker}.` });
        continue;
      }
      used++;
      const role: AgentRole = issue.assignedTo && issue.assignedTo !== "CIO" ? issue.assignedTo : "QUALITY";
      updateIssue(issue.id, role, { status: "VERIFYING", incrementAttempts: true });
      const key = `r2c:${ticker}:${issue.id}`;
      await runTask(
        s,
        deps,
        key,
        { phase: "VERIFICATION", agentRole: role, ticker },
        async () => {
          const prompt = [
            `FASE: RONDA 2C — VERIFICACIÓN DOCUMENTAL. Se te asigna la incidencia #${issue.id} sobre ${ticker}.`,
            issuesBlock([issue]),
            evidenceBlock(s.id, [ticker]),
            "Comprueba la cifra con fuentes documentales (get_company_financials para datos 10-K, verify_source para citas literales). Solo puedes marcar RESOLVED si citas al menos una evidencia VERIFICADA que respalde el valor. Si no es posible, marca UNRESOLVABLE y explica qué falta. No se resuelve por opinión ni por votación.",
            "Entrega con submit_verification.",
          ].join("\n\n");
          const r = await runAgentTask(
            { sessionId: s.id, taskKey: key, phase: "VERIFICATION", role, model: s.settings.debateModel, prompt, dataTools: VERIFY_TOOLS, submit: { name: "submit_verification", description: "Resultado de la verificación.", schema: VerificationSchema }, maxIterations: iter(s, 4) },
            { ...deps, isStopRequested: () => Boolean(getSession(s.id)?.stopRequested) },
          );
          return r.output as VerificationT;
        },
        (out) => {
          const cites = citationStatus(s.id, out.evidence_ids);
          const ok = out.outcome === "RESOLVED" && cites.verified.length > 0;
          updateIssue(issue.id, role, {
            status: ok ? "RESOLVED" : "PENDING",
            resolution: ok ? `${out.explanation} (evidencia verificada: ${cites.verified.join(", ")})` : `No resuelta: ${out.explanation}${out.outcome === "RESOLVED" ? " — rechazado: sin evidencia VERIFICADA" : ""}`,
            resolvedValue: ok ? out.corrected_value : null,
            addEvidenceIds: out.evidence_ids,
          });
          insertMessage({ sessionId: s.id, round: 2, phase: "VERIFICATION", ticker, fromRole: role, toRole: "ALL", type: "RESPONSE", claim: `Verificación de la incidencia #${issue.id}: ${ok ? "RESUELTA" : "PENDIENTE"} — ${out.explanation}`, evidenceText: cites.verified.length ? `Verificadas: ${cites.verified.join(", ")}` : "Sin evidencia verificada", evidenceIds: out.evidence_ids, question: null, expectedOutcome: ok ? "Actualizar cifras en la revisión" : "Documentar como pendiente", inReplyTo: issue.sourceMessageId, taskKey: key });
          return { ...out, accepted: ok };
        },
      );
    }
  }
}

function buildRevision(s: SessionRow, role: AgentRole, round: number, companies: RevisionCompanyT[], summary: string, model: string, vetoes?: VetoT[]): StoredRevision {
  const init = initialReport(s.id, role)?.content as StoredReport | undefined;
  const prev = latestReport(s.id, role);
  return {
    role,
    generated_at: new Date().toISOString(),
    model,
    round,
    executive_summary: summary,
    companies: companies.map((c) => {
      const orig = init?.companies.find((x) => x.ticker === c.ticker);
      const prevRev = prev?.kind === "REVISION" ? (prev.content as StoredRevision).companies.find((x) => x.ticker === c.ticker) : null;
      return {
        ...c,
        original_scores: orig?.scores ?? null,
        original_total: orig ? Math.round(totalScore(role, orig.scores) * 10) / 10 : null,
        revised_total: Math.round(totalScore(role, c.revised_scores) * 10) / 10,
        original_conclusion: prevRev?.revised_conclusion ?? orig?.provisional_conclusion ?? null,
      };
    }),
    ...(role === "RISK" ? { vetoes: vetoes ?? [] } : {}),
  };
}

function revisionMessages(s: SessionRow, rev: StoredRevision, round: number, key: string) {
  for (const c of rev.companies) {
    const delta = c.original_total === null ? "nueva" : `${c.original_total} → ${c.revised_total}`;
    insertMessage({
      sessionId: s.id, round, phase: round === 3 ? "REVISION" : "SELECTIVE_DEBATE", ticker: c.ticker, fromRole: rev.role, toRole: "ALL", type: "REVISION",
      claim: `Puntuación ${delta}. ${c.revised_conclusion}`, evidenceText: c.change_reason, evidenceIds: c.new_data.map((d) => d.evidence_id).filter((x): x is string => Boolean(x)),
      question: c.unresolved.length ? c.unresolved.join(" / ") : null, expectedOutcome: c.accepted_arguments.length ? `Acepta: ${c.accepted_arguments.map((a) => a.summary).join("; ")}` : "Mantiene su postura",
      inReplyTo: null, taskKey: key,
    });
  }
}

async function phaseRevision(s: SessionRow, deps: RunnerDeps) {
  const tickers = agendaTickers(s);
  const settle = await mapLimit([...AGENT_ROLES], s.settings.limits.concurrency, (role) => {
    const key = `r3:${role}`;
    return runTask(
      s,
      deps,
      key,
      { phase: "REVISION", agentRole: role },
      async () => {
        const ctx = postRound1Context(s.id, role);
        const prompt = [
          "FASE: RONDA 3 — REVISIÓN DE CONCLUSIONES. Tras el debate, entrega tu revisión de cada empresa debatida.",
          objectiveBlock(s.config),
          `EMPRESAS DEBATIDAS: ${tickers.join(", ")}`,
          "TU INFORME INICIAL (congelado):",
          reportDigest(ctx.reports[role].initial?.content as StoredReport, { tickers }),
          "INFORMES INICIALES DE LOS DEMÁS:",
          AGENT_ROLES.filter((r) => r !== role).map((r) => reportDigest(ctx.reports[r].initial?.content as StoredReport, { tickers })).join("\n\n"),
          "TRANSCRIPCIÓN DEL DEBATE:",
          threadBlock(listMessages(s.id).filter((m) => m.ticker === null || tickers.includes(m.ticker))),
          "INCIDENCIAS Y RESOLUCIONES:",
          issuesBlock(listIssues(s.id)),
          `HIPÓTESIS REGISTRADAS: ${JSON.stringify(listHypotheses(s.id)).slice(0, 6000)}`,
          evidenceBlock(s.id, tickers),
          ctx.ownNotes.length ? `TUS NOTAS PRIVADAS:\n${ctx.ownNotes.join("\n")}` : "",
          "Para cada empresa debatida indica puntuación revisada, conclusión revisada, argumentos aceptados y rechazados (con #id de mensaje), datos nuevos que cambiaron tu evaluación (EV-n), cuestiones sin resolver y el motivo del cambio. No estás obligado a cambiar: mantén tu postura si la evidencia lo justifica.",
          role === "VALUATION" ? "Incluye el bloque 'valuation' revisado (o el mismo si no cambia)." : "",
          role === "RISK" ? "Incluye la lista completa de vetos vigentes o retirados (status upheld/withdrawn)." : "",
          "Entrega con submit_revision.",
        ].filter(Boolean).join("\n\n");
        const r = await runAgentTask(
          { sessionId: s.id, taskKey: key, phase: "REVISION", role, model: s.settings.model, prompt, dataTools: ["get_evidence", "compute_valuation", "compute_dcf", "save_note"], submit: { name: "submit_revision", description: "Tu revisión (se guarda como versión nueva; el informe inicial no se modifica).", schema: revisionSchema(role) }, maxIterations: iter(s, 3) },
          { ...deps, isStopRequested: () => Boolean(getSession(s.id)?.stopRequested) },
        );
        const out = r.output as { executive_summary: string; companies: RevisionCompanyT[]; vetoes?: VetoT[] };
        return buildRevision(s, role, 3, out.companies, out.executive_summary, r.model, out.vetoes);
      },
      (rev) => {
        insertReport(s.id, role, "REVISION", "REVISION", rev, key);
        revisionMessages(s, rev, 3, key);
        return { stored: true };
      },
    );
  });
  const control = settle.find((r) => r.status === "rejected" && (r.reason instanceof BudgetExceededError || r.reason instanceof StopRequestedError));
  if (control && control.status === "rejected") throw control.reason;
  const failed = AGENT_ROLES.filter((_, i) => settle[i].status === "rejected");
  if (failed.length) throw new PhaseFailedError(`Revisión incompleta: fallaron ${failed.map((r) => ROLE_LABELS[r]).join(", ")}`);
}

function selectiveHints(s: SessionRow, snaps: CompanySnapshot[]): string {
  const t = s.config.targetAnnualReturn;
  return snaps
    .map((c) => {
      const h: string[] = [];
      const q = c.views.QUALITY?.total;
      const v = c.views.VALUATION?.total;
      if (q !== undefined && v !== undefined && Math.abs(q - v) >= 30) h.push(`divergencia calidad/valoración (${q} vs ${v})`);
      const base = c.scenarios?.scenarios.base.totalCagr;
      if (typeof base === "number" && Math.abs(base - t) <= 0.03) h.push(`CAGR base ${(base * 100).toFixed(1)}% cerca del objetivo`);
      const pl = c.views.RISK?.scores.permanent_loss;
      if (typeof pl === "number" && pl >= 7) h.push(`riesgo de pérdida permanente ${pl}/10`);
      if (c.confidence.score < 0.7) h.push(`datos críticos no verificados (confianza ${(c.confidence.score * 100).toFixed(0)}%)`);
      if (typeof c.scenarios?.cagrSpread === "number" && c.scenarios.cagrSpread >= 0.2) h.push(`precio de entrada muy sensible (diferencia bull-bear ${(c.scenarios.cagrSpread * 100).toFixed(0)} pp)`);
      if (c.vetoes.some((x) => x.upheld)) h.push(`veto vigente`);
      if (c.issues.open) h.push(`${c.issues.open} incidencia(s) factuales abiertas`);
      return `- ${c.ticker}: ${h.length ? h.join("; ") : "sin señales automáticas"}`;
    })
    .join("\n");
}

async function phaseSelective(s: SessionRow, deps: RunnerDeps) {
  const tickers = agendaTickers(s);
  const snaps = tickers.map((t) => companySnapshot(s.id, t, s.config));
  const agenda = await runTask(
    s,
    deps,
    "r4:agenda",
    { phase: "SELECTIVE_DEBATE", agentRole: "CIO" },
    async () => {
      const prompt = [
        "FASE: RONDA 4 — SEGUNDO DEBATE SELECTIVO. Selecciona SOLO las controversias que todavía pueden cambiar la decisión. No repitas el análisis.",
        "Prioriza: discrepancias relevantes entre calidad y valoración; riesgo de pérdida permanente de capital; retornos cerca del umbral; datos críticos no verificados; precios de entrada muy sensibles a las hipótesis.",
        "SEÑALES CALCULADAS POR EL MOTOR:",
        selectiveHints(s, snaps),
        "REVISIONES DE LA RONDA 3:",
        AGENT_ROLES.map((r) => revisionDigest(latestReport(s.id, r)?.content as StoredRevision, tickers)).join("\n\n"),
        "INCIDENCIAS:",
        issuesBlock(listIssues(s.id).filter((i) => i.status !== "RESOLVED")),
        "Para cada controversia indica empresa, pregunta concreta, destinatarios y por qué puede cambiar la decisión. Si no queda ninguna relevante, envía la lista vacía.",
        "Entrega con submit_selective_agenda.",
      ].join("\n\n");
      const r = await runAgentTask(
        { sessionId: s.id, taskKey: "r4:agenda", phase: "SELECTIVE_DEBATE", role: "CIO", model: s.settings.debateModel, prompt, dataTools: [], submit: { name: "submit_selective_agenda", description: "Controversias pendientes que pueden cambiar la decisión.", schema: SelectiveAgendaSchema }, maxIterations: 2 },
        { ...deps, isStopRequested: () => Boolean(getSession(s.id)?.stopRequested) },
      );
      return r.output as SelectiveAgendaT;
    },
    (out) => {
      out.controversies.forEach((c, i) => {
        for (const to of c.addressed_to) {
          insertMessage({ sessionId: s.id, round: 4, phase: "SELECTIVE_DEBATE", ticker: c.ticker, fromRole: "CIO", toRole: to, type: "EVIDENCE_REQUEST", claim: `[C${i}] ${c.question}`, evidenceText: c.why_decision_relevant, evidenceIds: [], question: c.question, expectedOutcome: `Respuesta directa (${c.category})`, inReplyTo: null, taskKey: "r4:agenda" });
        }
      });
      return out;
    },
  );
  const roles = AGENT_ROLES.filter((r) => r !== "CIO" && agenda.controversies.some((c) => c.addressed_to.includes(r)));
  const allowRevision = s.settings.limits.maxExtraRevisionRounds >= 1;
  for (const role of roles) {
    const key = `r4:answer:${role}`;
    const mine = agenda.controversies.map((c, i) => ({ ...c, i })).filter((c) => c.addressed_to.includes(role));
    await runTask(
      s,
      deps,
      key,
      { phase: "SELECTIVE_DEBATE", agentRole: role },
      async () => {
        const prompt = [
          `FASE: RONDA 4 — RESPONDE SOLO A LAS CUESTIONES PENDIENTES que el CIO te ha dirigido. No repitas tu análisis.`,
          mine.map((c) => `[C${c.i}] ${c.ticker}: ${c.question} (por qué importa: ${c.why_decision_relevant})`).join("\n"),
          "TU ÚLTIMA REVISIÓN:",
          revisionDigest(latestReport(s.id, role)?.content as StoredRevision, tickers),
          evidenceBlock(s.id, Array.from(new Set(mine.map((c) => c.ticker)))),
          allowRevision ? "Si tu posición cambia, incluye la empresa en revised_companies con tus puntuaciones revisadas (ronda adicional de revisión permitida)." : "No se permite una revisión adicional: responde sin cambiar puntuaciones.",
          role === "RISK" ? "Si cambias un veto, devuelve la lista de vetos actualizada para esa empresa." : "",
          "Usa controversy_index con el número de la cuestión. Entrega con submit_selective_answer.",
        ].filter(Boolean).join("\n\n");
        const r = await runAgentTask(
          { sessionId: s.id, taskKey: key, phase: "SELECTIVE_DEBATE", role, model: s.settings.debateModel, prompt, dataTools: ["get_evidence", "verify_source", "compute_valuation", "compute_dcf"], submit: { name: "submit_selective_answer", description: "Respuestas a las cuestiones pendientes.", schema: selectiveAnswerSchema(role) }, maxIterations: iter(s, 3) },
          { ...deps, isStopRequested: () => Boolean(getSession(s.id)?.stopRequested) },
        );
        return { ...(r.output as { answers: { controversy_index: number; answer: string; evidence_ids: string[]; position_changed: boolean }[]; revised_companies: RevisionCompanyT[]; vetoes: VetoT[] }), model: r.model };
      },
      (out) => {
        for (const a of out.answers) {
          const c = agenda.controversies[a.controversy_index];
          insertMessage({ sessionId: s.id, round: 4, phase: "SELECTIVE_DEBATE", ticker: c?.ticker ?? null, fromRole: role, toRole: "CIO", type: "RESPONSE", claim: `[C${a.controversy_index}] ${a.answer}`, evidenceText: a.position_changed ? "Cambia su posición" : "Mantiene su posición", evidenceIds: a.evidence_ids, question: null, expectedOutcome: "Cierre de la controversia", inReplyTo: null, taskKey: key });
        }
        if (allowRevision && out.revised_companies.length) {
          const prev = latestReport(s.id, role)?.content as StoredRevision | undefined;
          const changed = new Set(out.revised_companies.map((c) => c.ticker));
          const carried = (prev?.companies ?? []).filter((c) => !changed.has(c.ticker)).map(({ original_scores: _o, original_total: _t, revised_total: _r, original_conclusion: _c, ...rest }) => rest);
          const vetoes = role === "RISK" ? [...(prev?.vetoes ?? []).filter((v) => !out.vetoes.some((n) => n.ticker === v.ticker)), ...out.vetoes] : undefined;
          const rev = buildRevision(s, role, 4, [...carried, ...out.revised_companies], `Revisión adicional (ronda 4): ${out.revised_companies.map((c) => c.ticker).join(", ")}`, out.model, vetoes);
          insertReport(s.id, role, "REVISION", "SELECTIVE_DEBATE", rev, key);
          revisionMessages(s, { ...rev, companies: rev.companies.filter((c) => changed.has(c.ticker)) }, 4, key);
        }
        return out;
      },
    );
  }
}

export function computeConvergence(s: SessionRow, snaps: { ticker: string; verdict: Verdict; priceVerified: boolean; confidence: number }[]): Convergence {
  const fresh = getSession(s.id)!;
  if (fresh.budgetExhausted) return "STOPPED_BY_BUDGET";
  const issues = listIssues(s.id);
  const unresolvedFactual = issues.filter((i) => ["OPEN", "VERIFYING", "PENDING"].includes(i.status));
  const criticalPending = issues.filter((i) => i.critical && i.status !== "RESOLVED");
  const essentialMissing = snaps.filter((x) => !x.priceVerified || x.confidence < 0.5);
  const revisionsDone = AGENT_ROLES.every((r) => listTasks(s.id).some((t) => t.taskKey === `r3:${r}` && t.status === "SUCCEEDED"));
  if (criticalPending.length && essentialMissing.length) return "UNRESOLVED";
  if (snaps.length && essentialMissing.length === snaps.length) return "UNRESOLVED";
  if (criticalPending.length || unresolvedFactual.length || essentialMissing.length || !revisionsDone) return "PARTIAL";
  return "RESOLVED";
}

async function phaseFinal(s: SessionRow, deps: RunnerDeps) {
  const tickers = agendaTickers(s);
  // Forecast and judgement disagreements are documented, never "voted" away.
  for (const i of listIssues(s.id)) {
    if ((i.kind === "FORECAST" || i.kind === "JUDGEMENT") && i.status === "OPEN") updateIssue(i.id, "system:final", { status: "DOCUMENTED", resolution: "Discrepancia documentada en el informe final (hipótesis alternativas registradas)." });
    if ((i.kind === "FACTUAL_DISPUTE" || i.kind === "DATA_CONFLICT") && (i.status === "OPEN" || i.status === "VERIFYING")) updateIssue(i.id, "system:final", { status: "PENDING", resolution: i.resolution ?? "Sin verificar al cierre de la sesión." });
  }
  // FX (deterministic, no AI) for EUR presentation.
  let fx = listEvidence(s.id, { metric: "fx_usd_per_eur" }).filter((e) => e.verification === "VERIFIED").pop() ?? null;
  if (!fx && deps.md.fx) {
    const r = await deps.md.fx.usdPerEur().catch(() => null);
    if (r) fx = addEvidence(s.id, { ticker: null, metric: "fx_usd_per_eur", value: r.usdPerEur, unit: "USD/EUR", period: r.date, periodType: "POINT", publishedAt: r.date, retrievedAt: r.retrievedAt, source: r.source, url: r.url, dataType: "REPORTED", verification: "VERIFIED", confidence: "HIGH", confidenceReason: "Tipo de referencia oficial", createdBy: `system:${deps.md.fx.id}`, synthetic: deps.md.synthetic });
  }
  const snaps = tickers.map((t) => companySnapshot(s.id, t, s.config));

  let cio: FinalDecisionT | null = null;
  let cioError: string | null = null;
  try {
    cio = await runTask(s, deps, "final:cio", { phase: "FINAL_DECISION", agentRole: "CIO" }, async () => {
      const table = snaps.map((c) => ({
        ticker: c.ticker,
        quality: c.views.QUALITY?.total ?? null,
        valuation: c.views.VALUATION?.total ?? null,
        risk: c.views.RISK?.total ?? null,
        price: c.price,
        scenarios: c.scenarios ? { fairValueCentral: c.scenarios.fairValueCentral, maxPrice: c.scenarios.maxPriceForTarget, entry: c.scenarios.proposedEntryPrice, bear: c.scenarios.scenarios.bear.totalCagr, base: c.scenarios.scenarios.base.totalCagr, bull: c.scenarios.scenarios.bull.totalCagr } : null,
        vetoes: c.vetoes.map((v) => ({ severity: v.severity, upheld: v.upheld, reason: v.reason })),
        dataConfidence: Math.round(c.confidence.score * 100) / 100,
        issues: c.issues,
      }));
      const prompt = [
        "FASE: DECISIÓN FINAL DEL CIO.",
        objectiveBlock(s.config),
        "DATOS CALCULADOS POR EL MOTOR (no los recalcules: el motor fija la puntuación final y limita el veredicto máximo permitido):",
        JSON.stringify(table, null, 1),
        "MÉTODO DE PUNTUACIÓN:",
        SCORING_METHOD,
        "REVISIONES MÁS RECIENTES:",
        AGENT_ROLES.map((r) => {
          const l = latestReport(s.id, r);
          return l?.kind === "REVISION" ? revisionDigest(l.content as StoredRevision, tickers) : reportDigest(l?.content as StoredReport, { tickers });
        }).join("\n\n"),
        "INCIDENCIAS:",
        issuesBlock(listIssues(s.id)),
        "RONDA 4 (respuestas):",
        threadBlock(listMessages(s.id, { round: 4 })),
        "Para cada empresa debatida: puntúa los catalizadores verificables (0–100, con evidencia), propone un veredicto (POTENTIAL_BUY, EXCELLENT_TOO_EXPENSIVE, WATCHLIST, EXCLUDE, PENDING_VERIFICATION), justifica, documenta consenso y discrepancias, y enumera las hipótesis que deben cumplirse para aproximarse al objetivo. Puedes ser más prudente que el motor, nunca menos. Cero compras es un resultado válido.",
        "Entrega con submit_final_decision.",
      ].join("\n\n");
      const r = await runAgentTask(
        { sessionId: s.id, taskKey: "final:cio", phase: "FINAL_DECISION", role: "CIO", model: s.settings.model, prompt, dataTools: ["get_evidence"], submit: { name: "submit_final_decision", description: "Decisión final del comité.", schema: FinalDecisionSchema }, maxIterations: 2, isFinal: true },
        { ...deps, isStopRequested: () => Boolean(getSession(s.id)?.stopRequested) },
      );
      return r.output as FinalDecisionT;
    });
  } catch (e) {
    if (e instanceof StopRequestedError) throw e;
    if (!(e instanceof BudgetExceededError)) throw e;
    cioError = e.message;
    updateSession(s.id, { budgetExhausted: true });
  }

  const verdictRows: (VerdictRow & { priceVerified: boolean; confidence: number })[] = [];
  for (const c of snaps) {
    const cioC = cio?.companies.find((x) => x.ticker === c.ticker) ?? null;
    const base = c.scenarios?.scenarios.base.totalCagr ?? null;
    const bear = c.scenarios?.scenarios.bear.totalCagr ?? null;
    const score = finalScore({ quality: c.views.QUALITY?.total ?? null, valuation: c.views.VALUATION?.total ?? null, risk: c.views.RISK?.total ?? null, catalysts: cioC?.catalysts_score ?? null, baseCagr: base, target: s.config.targetAnnualReturn });
    const decision = allowedVerdict({ score, baseCagr: base, bearCagr: bear, target: s.config.targetAnnualReturn, vetoes: c.vetoes, criticalOpenIssues: c.issues.criticalOpen, dataConfidence: c.confidence.score, priceVerified: Boolean(c.price) });
    const rec = reconcileVerdict(decision.allowed, (cioC?.proposed_verdict as Verdict) ?? null);
    const fxRate = fx?.value ?? null;
    const scen = c.scenarios;
    verdictRows.push({
      ticker: c.ticker,
      rank: null,
      verdict: rec.verdict,
      cioProposedVerdict: (cioC?.proposed_verdict as Verdict) ?? null,
      overrideReason: rec.overridden ? `El motor limita el veredicto a "${VERDICT_LABELS[decision.allowed]}": ${decision.reasons.join("; ")}` : null,
      finalScore: score.final,
      priceVerified: Boolean(c.price),
      confidence: c.confidence.score,
      content: {
        name: c.name,
        sector: c.sector,
        synthetic: c.synthetic,
        price: c.price,
        scores: { quality: c.views.QUALITY?.total ?? null, valuation: c.views.VALUATION?.total ?? null, risk: c.views.RISK?.total ?? null, catalysts: cioC?.catalysts_score ?? null },
        breakdown: score,
        engineVerdict: decision,
        scenarios: scen,
        eur: fxRate && scen
          ? {
              fxEvidence: fx ? shortId(fx.id) : null,
              usdPerEur: fxRate,
              assumption: "Tipo de cambio constante (sin previsión de divisa); se muestran sensibilidades ±10%.",
              baseCagrEurConstantFx: eurCagr(scen.scenarios.base.totalCagr, s.config.horizonYears, fxRate, fxRate),
              sensitivity: fxSensitivity(scen.scenarios.base.totalCagr, s.config.horizonYears, fxRate),
              referencePriceEur: c.price ? c.price.value / fxRate : null,
            }
          : null,
        vetoes: c.vetoes.map((v) => ({ severity: v.severity, upheld: v.upheld, reason: v.reason, downgraded: v.downgraded, evidence: v.raw.evidence, source: v.raw.source_url, evidenceIds: v.raw.evidence_ids })),
        dataConfidence: c.confidence,
        issues: c.issues,
        debateStatus: c.issues.criticalOpen ? "CRITICAL_OPEN" : c.issues.open ? "OPEN_ISSUES" : "CLOSED",
        cio: cioC,
      },
    });
  }
  const ranked = rankFinalists(verdictRows, s.config.maxFinalists);
  ranked.forEach((r, i) => (r.rank = i + 1));
  const convergence = computeConvergence(s, verdictRows.map((v) => ({ ticker: v.ticker, verdict: v.verdict, priceVerified: v.priceVerified, confidence: v.confidence })));
  const fresh = getSession(s.id)!;
  const report = {
    generated_at: new Date().toISOString(),
    cutoff_at: fresh.cutoffAt,
    mode: s.mode,
    synthetic: deps.md.synthetic,
    models: { main: s.settings.model, debate: s.settings.debateModel, adapter: deps.adapter.kind },
    objective: s.config,
    coverage: fresh.coverage,
    agenda: tickers,
    executive_summary: cio?.executive_summary ?? `Sin decisión del CIO: ${cioError ?? "no disponible"}. Los veredictos se limitan a lo que permite el motor y quedan pendientes de verificación.`,
    portfolio_note: cio?.portfolio_note ?? "",
    ranking: ranked.map((r) => r.ticker),
    buys: verdictRows.filter((v) => v.verdict === "POTENTIAL_BUY").map((v) => v.ticker),
    convergence,
    methodology: { scoring: SCORING_METHOD, scenarios: SCENARIO_FORMULA, totalReturn: TOTAL_RETURN_METHOD },
    limitations: [
      ...(fresh.coverage?.limitations ?? []),
      ...(cio?.limitations ?? []),
      ...(cioError ? [`Decisión del CIO no disponible: ${cioError}`] : []),
      "Las estimaciones no son garantías de rentabilidad. El 15% es un objetivo de selección.",
      "Los precios gratuitos pueden estar retrasados; la fecha y el tipo de cada precio figuran en la tabla.",
    ],
    usage: usageTotals(s.id),
    disclaimer: "Informe generado por un sistema de IA con fines de investigación. No constituye asesoramiento financiero. Las rentabilidades estimadas no están garantizadas.",
  };
  const FinalReportCheck = z.object({ generated_at: z.string(), ranking: z.array(z.string()).max(5), convergence: z.string(), executive_summary: z.string().min(1), limitations: z.array(z.string()).min(1) });
  const valid = FinalReportCheck.safeParse(report).success && verdictRows.every((v) => v.verdict);
  tx(getDb(), () => {
    saveVerdicts(s.id, verdictRows.map(({ priceVerified: _p, confidence: _c, ...v }) => v));
    saveFinalReport(s.id, report, valid);
    if (!valid) throw new PhaseFailedError("El informe final no superó la validación");
    if (cio) transitionSession(s.id, "COMPLETED", { convergence });
    else transitionSession(s.id, "STOPPED_BY_BUDGET", { convergence: "STOPPED_BY_BUDGET" });
  });
}

/* ------------------------------- driver ----------------------------- */

const NEXT: Partial<Record<SessionStatus, SessionStatus>> = {
  CREATED: "DISCOVERY",
  ROUND_1_COMPLETE: "CROSS_REVIEW",
};

export async function runSession(sessionId: string, deps: RunnerDeps): Promise<SessionRow> {
  requeueInterruptedTasks(sessionId);
  for (let guard = 0; guard < 50; guard++) {
    const s = getSession(sessionId);
    if (!s) throw new Error("Sesión no encontrada");
    if (TERMINAL_STATUSES.includes(s.status) || s.status === "PAUSED_ERROR") return s;
    try {
      if (s.stopRequested) throw new StopRequestedError();
      const nxt = NEXT[s.status];
      if (nxt) {
        transitionSession(s.id, nxt);
        continue;
      }
      switch (s.status) {
        case "DISCOVERY":
          await phaseDiscovery(s, deps);
          break;
        case "ROUND_1_RUNNING":
          await phaseRound1(s, deps);
          break;
        case "CROSS_REVIEW":
          await phaseCrossReview(s, deps);
          transitionSession(s.id, "DEBATE");
          break;
        case "DEBATE":
          await phaseDebate(s, deps);
          transitionSession(s.id, "VERIFICATION");
          break;
        case "VERIFICATION":
          await phaseVerification(s, deps);
          transitionSession(s.id, "REVISION");
          break;
        case "REVISION":
          await phaseRevision(s, deps);
          transitionSession(s.id, s.settings.limits.maxDebateRounds >= 2 ? "SELECTIVE_DEBATE" : "FINAL_DECISION");
          break;
        case "SELECTIVE_DEBATE":
          await phaseSelective(s, deps);
          transitionSession(s.id, "FINAL_DECISION");
          break;
        case "FINAL_DECISION":
          await phaseFinal(s, deps);
          break;
        default:
          return s;
      }
    } catch (e) {
      const cur = getSession(sessionId)!;
      if (e instanceof StopRequestedError || cur.stopRequested) {
        for (const t of listTasks(sessionId)) if (t.status === "PENDING" || t.status === "RUNNING") failTask(sessionId, t.taskKey, "Cancelada por el usuario", "CANCELLED");
        transitionSession(sessionId, "STOPPED_BY_USER", { convergence: "STOPPED_BY_USER" });
        return getSession(sessionId)!;
      }
      if (e instanceof BudgetExceededError) {
        updateSession(sessionId, { budgetExhausted: true });
        logError(sessionId, { phase: cur.status, message: e.message });
        const debatePhases: SessionStatus[] = ["CROSS_REVIEW", "DEBATE", "VERIFICATION", "REVISION", "SELECTIVE_DEBATE"];
        // Controlled stop: skip remaining debate and let the CIO document pending disagreements with the reserve.
        if (debatePhases.includes(cur.status)) {
          transitionSession(sessionId, "FINAL_DECISION");
          continue;
        }
        transitionSession(sessionId, "STOPPED_BY_BUDGET", { convergence: "STOPPED_BY_BUDGET", error: e.message });
        return getSession(sessionId)!;
      }
      const msg = e instanceof Error ? e.message : String(e);
      logError(sessionId, { phase: cur.status, message: msg });
      if (!TERMINAL_STATUSES.includes(cur.status)) transitionSession(sessionId, "PAUSED_ERROR", { error: msg });
      return getSession(sessionId)!;
    }
  }
  return getSession(sessionId)!;
}

/** Resume after a pause or a restart: completed tasks are never re-executed. */
export function prepareResume(sessionId: string) {
  const s = getSession(sessionId);
  if (!s) throw new Error("Sesión no encontrada");
  requeueInterruptedTasks(sessionId);
  if (s.status === "PAUSED_ERROR") {
    for (const t of listTasks(sessionId)) if (t.status === "FAILED" || t.status === "CANCELLED") ensureTask(sessionId, t.taskKey, { phase: t.phase });
    transitionSession(sessionId, s.resumeStatus ?? "DISCOVERY", { error: null });
    updateSession(sessionId, { error: null });
  }
}

export { candidatesBlock, PROFILES };
