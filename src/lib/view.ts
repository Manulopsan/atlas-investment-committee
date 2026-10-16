import {
  getFinalReport,
  getSession,
  listCalculations,
  listCandidates,
  listErrors,
  listHypotheses,
  listIssueHistory,
  listIssues,
  listMessages,
  listReports,
  listSessions,
  listTasks,
  listVerdicts,
} from "./db/repo";
import { listEvidence, shortId } from "./evidence/registry";
import { usageBreakdown } from "./llm/cost";
import { runState } from "./orchestrator/manager";
import { companySnapshot } from "./orchestrator/companyState";
import { redactDeep } from "./security/redact";

/** Serialisable state for the dashboard. Secrets are never part of it (and are redacted defensively). */
export function sessionSummaries() {
  return redactDeep(
    listSessions(30).map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      mode: s.mode,
      status: s.status,
      convergence: s.convergence,
      ...runState(s),
      usage: usageBreakdown(s.id).totals,
    })),
  );
}

export function sessionView(id: string) {
  const s = getSession(id);
  if (!s) return null;
  const evidence = listEvidence(id).map((e) => ({ ...e, id: shortId(e.id), inputs: e.inputs.map(shortId) }));
  return redactDeep({
    session: { ...s, ...runState(s) },
    tasks: listTasks(id),
    candidates: listCandidates(id),
    reports: listReports(id),
    messages: listMessages(id),
    issues: listIssues(id).map((i) => ({ ...i, evidenceIds: i.evidenceIds.map(shortId), history: listIssueHistory(i.id) })),
    hypotheses: listHypotheses(id),
    evidence,
    calculations: listCalculations(id),
    verdicts: listVerdicts(id),
    finalReport: getFinalReport(id),
    usage: usageBreakdown(id),
    errors: listErrors(id),
  });
}

export function companyView(id: string, ticker: string) {
  const s = getSession(id);
  if (!s) return null;
  const t = ticker.toUpperCase();
  return redactDeep({
    snapshot: companySnapshot(id, t, s.config),
    candidate: listCandidates(id).find((c) => c.ticker === t) ?? null,
    verdict: listVerdicts(id).find((v) => v.ticker === t) ?? null,
    messages: listMessages(id, { ticker: t }),
    issues: listIssues(id, { ticker: t }).map((i) => ({ ...i, history: listIssueHistory(i.id) })),
    hypotheses: listHypotheses(id, t),
    evidence: listEvidence(id, { ticker: t }).map((e) => ({ ...e, id: shortId(e.id), inputs: e.inputs.map(shortId) })),
    calculations: listCalculations(id, t),
    reports: listReports(id).map((r) => ({ ...r, content: { ...(r.content as object), companies: ((r.content as { companies?: { ticker: string }[] }).companies ?? []).filter((c) => c.ticker === t) } })),
  });
}
