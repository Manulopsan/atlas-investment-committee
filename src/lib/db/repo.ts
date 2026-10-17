import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { getDb, nowIso, tx } from "./index";
import { AppSettingsSchema, defaultSettings, type AppSettings, type InvestmentConfig } from "../config";
import { assertTransition, InvalidTransitionError, isPaused } from "../state";
import type {
  AgentRole,
  Convergence,
  CoverageLevel,
  IssueKind,
  IssueStatus,
  MessageType,
  SessionMode,
  SessionStatus,
  TaskStatus,
  Verdict,
} from "../types";

type Row = Record<string, unknown>;
const j = (v: unknown) => JSON.stringify(v ?? null);
const pj = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const db = (): DatabaseSync => getDb();
const run = (sql: string, ...p: SQLInputValue[]) => db().prepare(sql).run(...p);
const get = (sql: string, ...p: SQLInputValue[]) => db().prepare(sql).get(...p) as Row | undefined;
const all = (sql: string, ...p: SQLInputValue[]) => db().prepare(sql).all(...p) as Row[];

/* ----------------------------- settings ----------------------------- */

export function getSettings(): AppSettings {
  const row = get("SELECT value_json FROM settings WHERE key = 'app'");
  if (!row) return defaultSettings();
  const parsed = AppSettingsSchema.safeParse(pj(row.value_json, {}));
  return parsed.success ? parsed.data : defaultSettings();
}

/** Small JSON values kept next to the app settings (e.g. subscription usage calibration). */
export function getKv<T>(key: string, fallback: T): T {
  const row = get("SELECT value_json FROM settings WHERE key = ?", key);
  return row ? pj(row.value_json, fallback) : fallback;
}

export function setKv(key: string, value: unknown) {
  run(
    "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
    key,
    j(value),
    nowIso(),
  );
}

/** A session paused by the Claude subscription limit: when the window resets and whether to resume on its own. */
export interface LimitPause {
  resetsAt: string | null;
  autoResume: boolean;
  pausedAt: string;
}

export function getLimitPause(sessionId: string): LimitPause | null {
  return getKv<LimitPause | null>(`limit_pause:${sessionId}`, null);
}

export function setLimitPause(sessionId: string, p: LimitPause | null) {
  if (p) setKv(`limit_pause:${sessionId}`, p);
  else run("DELETE FROM settings WHERE key = ?", `limit_pause:${sessionId}`);
}

export function saveSettings(s: AppSettings): AppSettings {
  const valid = AppSettingsSchema.parse(s);
  run(
    "INSERT INTO settings (key, value_json, updated_at) VALUES ('app', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
    j(valid),
    nowIso(),
  );
  return valid;
}

/* ----------------------------- sessions ----------------------------- */

export interface CoverageInfo {
  level: CoverageLevel;
  description: string;
  universeSize: number | null;
  screened: number;
  sources: string[];
  limitations: string[];
}

export interface SessionRow {
  id: string;
  createdAt: string;
  updatedAt: string;
  mode: SessionMode;
  status: SessionStatus;
  resumeStatus: SessionStatus | null;
  convergence: Convergence | null;
  config: InvestmentConfig;
  settings: AppSettings;
  coverage: CoverageInfo | null;
  estimate: unknown;
  stopRequested: boolean;
  budgetExhausted: boolean;
  error: string | null;
  cutoffAt: string | null;
  completedAt: string | null;
  runRequested: boolean;
  leaseOwner: string | null;
  leaseUntil: string | null;
}

function toSession(r: Row): SessionRow {
  return {
    id: r.id as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    mode: r.mode as SessionMode,
    status: r.status as SessionStatus,
    resumeStatus: (r.resume_status as SessionStatus) ?? null,
    convergence: (r.convergence as Convergence) ?? null,
    config: pj(r.config_json, {} as InvestmentConfig),
    settings: pj(r.settings_json, defaultSettings()),
    coverage: pj(r.coverage_json, null),
    estimate: pj(r.estimate_json, null),
    stopRequested: Boolean(r.stop_requested),
    budgetExhausted: Boolean(r.budget_exhausted),
    error: (r.error as string) ?? null,
    cutoffAt: (r.cutoff_at as string) ?? null,
    completedAt: (r.completed_at as string) ?? null,
    runRequested: Boolean(r.run_requested),
    leaseOwner: (r.lease_owner as string) ?? null,
    leaseUntil: (r.lease_until as string) ?? null,
  };
}

/* ------------------------------ run leases --------------------------- */
// A session is executed by exactly one runner (web process or worker) holding a time-limited lease.

export function requestRun(id: string, requested = true) {
  run("UPDATE sessions SET run_requested = ? WHERE id = ?", requested ? 1 : 0, id);
}

export function acquireLease(id: string, owner: string, ms: number): boolean {
  const now = nowIso();
  const until = new Date(Date.now() + ms).toISOString();
  const r = run("UPDATE sessions SET lease_owner = ?, lease_until = ? WHERE id = ? AND (lease_until IS NULL OR lease_until < ? OR lease_owner = ?)", owner, until, id, now, owner);
  return Number(r.changes) === 1;
}

export function renewLease(id: string, owner: string, ms: number): boolean {
  const r = run("UPDATE sessions SET lease_until = ? WHERE id = ? AND lease_owner = ?", new Date(Date.now() + ms).toISOString(), id, owner);
  return Number(r.changes) === 1;
}

export function releaseLease(id: string, owner: string) {
  run("UPDATE sessions SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?", id, owner);
}

export function leaseActive(s: Pick<SessionRow, "leaseUntil">): boolean {
  return Boolean(s.leaseUntil && s.leaseUntil > nowIso());
}

/** Sessions waiting for a runner: requested, not finished/paused, and with no live lease (includes crashed runs). */
export function listRunnable(limit = 10): SessionRow[] {
  return all(
    "SELECT * FROM sessions WHERE run_requested = 1 AND status NOT IN ('COMPLETED','DRY_RUN_COMPLETE','STOPPED_BY_USER','STOPPED_BY_BUDGET','FAILED','PAUSED_ERROR','PAUSED_LIMIT') AND (lease_until IS NULL OR lease_until < ?) ORDER BY updated_at LIMIT ?",
    nowIso(),
    limit,
  ).map(toSession);
}

/** Cheap change signature used by the SSE endpoint. */
export function sessionSignature(id: string): string | null {
  const s = get("SELECT updated_at, status, lease_until, run_requested FROM sessions WHERE id = ?", id);
  if (!s) return null;
  const c = get(
    `SELECT (SELECT COUNT(*) FROM messages WHERE session_id = $id) AS m, (SELECT COUNT(*) FROM ai_usage WHERE session_id = $id) AS u,
            (SELECT COUNT(*) FROM evidence WHERE session_id = $id) AS e, (SELECT COUNT(*) FROM issues WHERE session_id = $id) AS i,
            (SELECT COALESCE(MAX(updated_at), '') FROM issues WHERE session_id = $id) AS iu, (SELECT COUNT(*) FROM reports WHERE session_id = $id) AS r,
            (SELECT GROUP_CONCAT(task_key || ':' || status || ':' || IFNULL(progress_note, ''), '|') FROM tasks WHERE session_id = $id AND status IN ('RUNNING','FAILED')) AS t,
            (SELECT COUNT(*) FROM tasks WHERE session_id = $id AND status = 'SUCCEEDED') AS ts`,
    { $id: id } as unknown as SQLInputValue,
  )!;
  const live = s.lease_until && (s.lease_until as string) > nowIso() ? 1 : 0;
  return [s.updated_at, s.status, live, s.run_requested, c.m, c.u, c.e, c.i, c.iu, c.r, c.t, c.ts].join("~");
}

export function createSession(input: { mode: SessionMode; settings: AppSettings; estimate?: unknown }): SessionRow {
  const id = randomUUID();
  const now = nowIso();
  run(
    "INSERT INTO sessions (id, created_at, updated_at, mode, status, config_json, settings_json, estimate_json, cutoff_at) VALUES (?, ?, ?, ?, 'CREATED', ?, ?, ?, ?)",
    id,
    now,
    now,
    input.mode,
    j(input.settings.investment),
    j(input.settings),
    j(input.estimate ?? null),
    now,
  );
  return getSession(id)!;
}

export function getSession(id: string): SessionRow | null {
  const r = get("SELECT * FROM sessions WHERE id = ?", id);
  return r ? toSession(r) : null;
}

export function listSessions(limit = 50): SessionRow[] {
  return all("SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?", limit).map(toSession);
}

export function transitionSession(id: string, to: SessionStatus, extra: { error?: string | null; convergence?: Convergence } = {}): SessionRow {
  const s = getSession(id);
  if (!s) throw new Error(`Sesión no encontrada: ${id}`);
  assertTransition(s.status, to);
  // A paused session may only resume into the phase it was interrupted in.
  if (isPaused(s.status) && !["STOPPED_BY_USER", "FAILED", "PAUSED_ERROR", "PAUSED_LIMIT"].includes(to) && to !== (s.resumeStatus ?? "CREATED")) {
    throw new InvalidTransitionError(s.status, to);
  }
  const terminal = ["COMPLETED", "DRY_RUN_COMPLETE", "STOPPED_BY_USER", "STOPPED_BY_BUDGET", "FAILED"].includes(to);
  run(
    `UPDATE sessions SET status = ?, updated_at = ?, error = COALESCE(?, error), convergence = COALESCE(?, convergence),
     resume_status = CASE WHEN ? IN ('PAUSED_ERROR','PAUSED_LIMIT') AND status NOT IN ('PAUSED_ERROR','PAUSED_LIMIT') THEN status ELSE resume_status END,
     completed_at = CASE WHEN ? THEN ? ELSE completed_at END WHERE id = ?`,
    to,
    nowIso(),
    extra.error ?? null,
    extra.convergence ?? null,
    to,
    terminal ? 1 : 0,
    nowIso(),
    id,
  );
  return getSession(id)!;
}

export function updateSession(id: string, fields: Partial<{ coverage: CoverageInfo; convergence: Convergence; error: string | null; stopRequested: boolean; budgetExhausted: boolean; estimate: unknown }>) {
  const sets: string[] = [];
  const vals: SQLInputValue[] = [];
  if (fields.coverage !== undefined) {
    sets.push("coverage_json = ?");
    vals.push(j(fields.coverage));
  }
  if (fields.convergence !== undefined) {
    sets.push("convergence = ?");
    vals.push(fields.convergence);
  }
  if (fields.error !== undefined) {
    sets.push("error = ?");
    vals.push(fields.error);
  }
  if (fields.stopRequested !== undefined) {
    sets.push("stop_requested = ?");
    vals.push(fields.stopRequested ? 1 : 0);
  }
  if (fields.budgetExhausted !== undefined) {
    sets.push("budget_exhausted = ?");
    vals.push(fields.budgetExhausted ? 1 : 0);
  }
  if (fields.estimate !== undefined) {
    sets.push("estimate_json = ?");
    vals.push(j(fields.estimate));
  }
  if (!sets.length) return;
  sets.push("updated_at = ?");
  vals.push(nowIso(), id);
  run(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`, ...vals);
}

export function deleteSession(id: string) {
  run("DELETE FROM sessions WHERE id = ?", id);
}

/* ------------------------------- tasks ------------------------------ */

export interface TaskRow {
  id: number;
  sessionId: string;
  taskKey: string;
  phase: string;
  agentRole: AgentRole | null;
  ticker: string | null;
  status: TaskStatus;
  attempts: number;
  progressNote: string | null;
  result: unknown;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

function toTask(r: Row): TaskRow {
  return {
    id: r.id as number,
    sessionId: r.session_id as string,
    taskKey: r.task_key as string,
    phase: r.phase as string,
    agentRole: (r.agent_role as AgentRole) ?? null,
    ticker: (r.ticker as string) ?? null,
    status: r.status as TaskStatus,
    attempts: r.attempts as number,
    progressNote: (r.progress_note as string) ?? null,
    result: pj(r.result_json, null),
    error: (r.error as string) ?? null,
    startedAt: (r.started_at as string) ?? null,
    finishedAt: (r.finished_at as string) ?? null,
  };
}

export function getTask(sessionId: string, taskKey: string): TaskRow | null {
  const r = get("SELECT * FROM tasks WHERE session_id = ? AND task_key = ?", sessionId, taskKey);
  return r ? toTask(r) : null;
}

export function listTasks(sessionId: string): TaskRow[] {
  return all("SELECT * FROM tasks WHERE session_id = ? ORDER BY id", sessionId).map(toTask);
}

export function ensureTask(sessionId: string, taskKey: string, meta: { phase: string; agentRole?: AgentRole | null; ticker?: string | null }): TaskRow {
  run(
    "INSERT INTO tasks (session_id, task_key, phase, agent_role, ticker, status) VALUES (?, ?, ?, ?, ?, 'PENDING') ON CONFLICT(session_id, task_key) DO NOTHING",
    sessionId,
    taskKey,
    meta.phase,
    meta.agentRole ?? null,
    meta.ticker ?? null,
  );
  return getTask(sessionId, taskKey)!;
}

export function markTaskRunning(sessionId: string, taskKey: string, note?: string) {
  run(
    "UPDATE tasks SET status = 'RUNNING', attempts = attempts + 1, started_at = ?, error = NULL, progress_note = ? WHERE session_id = ? AND task_key = ?",
    nowIso(),
    note ?? null,
    sessionId,
    taskKey,
  );
}

export function setTaskProgress(sessionId: string, taskKey: string, note: string) {
  run("UPDATE tasks SET progress_note = ? WHERE session_id = ? AND task_key = ?", note, sessionId, taskKey);
}

export function completeTask(sessionId: string, taskKey: string, result: unknown) {
  run(
    "UPDATE tasks SET status = 'SUCCEEDED', result_json = ?, finished_at = ?, progress_note = NULL WHERE session_id = ? AND task_key = ?",
    j(result),
    nowIso(),
    sessionId,
    taskKey,
  );
}

export function failTask(sessionId: string, taskKey: string, error: string, status: TaskStatus = "FAILED") {
  run("UPDATE tasks SET status = ?, error = ?, finished_at = ? WHERE session_id = ? AND task_key = ?", status, error, nowIso(), sessionId, taskKey);
}

export function resetTaskForRetry(sessionId: string, taskKey: string) {
  run("UPDATE tasks SET status = 'PENDING', error = NULL WHERE session_id = ? AND task_key = ? AND status IN ('FAILED','CANCELLED')", sessionId, taskKey);
}

/** Tasks left RUNNING by a crashed process are re-queued on resume (no completed task is touched). */
export function requeueInterruptedTasks(sessionId: string) {
  run("UPDATE tasks SET status = 'PENDING' WHERE session_id = ? AND status = 'RUNNING'", sessionId);
}

/* ---------------------------- candidates ---------------------------- */

export interface CandidateRow {
  ticker: string;
  cik: string | null;
  name: string | null;
  exchange: string | null;
  sic: string | null;
  sector: string | null;
  source: "DISCOVERY" | "USER_CSV" | "BOTH" | "SYNTHETIC";
  included: boolean;
  exclusionReason: string | null;
  screen: Record<string, unknown> | null;
  synthetic: boolean;
}

export function saveCandidates(sessionId: string, rows: CandidateRow[]) {
  tx(db(), () => {
    run("DELETE FROM candidates WHERE session_id = ?", sessionId);
    for (const c of rows) {
      run(
        "INSERT INTO candidates (session_id, ticker, cik, name, exchange, sic, sector, source, included, exclusion_reason, screen_json, synthetic) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        sessionId,
        c.ticker,
        c.cik,
        c.name,
        c.exchange,
        c.sic,
        c.sector,
        c.source,
        c.included ? 1 : 0,
        c.exclusionReason,
        j(c.screen),
        c.synthetic ? 1 : 0,
      );
    }
  });
}

export function listCandidates(sessionId: string, onlyIncluded = false): CandidateRow[] {
  const rows = all(`SELECT * FROM candidates WHERE session_id = ? ${onlyIncluded ? "AND included = 1" : ""} ORDER BY included DESC, ticker`, sessionId);
  return rows.map((r) => ({
    ticker: r.ticker as string,
    cik: (r.cik as string) ?? null,
    name: (r.name as string) ?? null,
    exchange: (r.exchange as string) ?? null,
    sic: (r.sic as string) ?? null,
    sector: (r.sector as string) ?? null,
    source: r.source as CandidateRow["source"],
    included: Boolean(r.included),
    exclusionReason: (r.exclusion_reason as string) ?? null,
    screen: pj(r.screen_json, null),
    synthetic: Boolean(r.synthetic),
  }));
}

/* ------------------------------ reports ----------------------------- */

export interface ReportRow<T = unknown> {
  id: number;
  sessionId: string;
  agentRole: AgentRole;
  version: number;
  kind: "INITIAL" | "REVISION";
  phase: string;
  frozen: boolean;
  content: T;
  taskKey: string | null;
  createdAt: string;
}

function toReport<T>(r: Row): ReportRow<T> {
  return {
    id: r.id as number,
    sessionId: r.session_id as string,
    agentRole: r.agent_role as AgentRole,
    version: r.version as number,
    kind: r.kind as "INITIAL" | "REVISION",
    phase: r.phase as string,
    frozen: Boolean(r.frozen),
    content: pj(r.content_json, null as T),
    taskKey: (r.task_key as string) ?? null,
    createdAt: r.created_at as string,
  };
}

/** Initial reports are stored unfrozen until the whole round closes; revisions are frozen on insert. */
export function insertReport(sessionId: string, role: AgentRole, kind: "INITIAL" | "REVISION", phase: string, content: unknown, taskKey?: string): ReportRow {
  return tx(db(), () => {
    const existing = get("SELECT * FROM reports WHERE session_id = ? AND task_key = ?", sessionId, taskKey ?? "__none__");
    if (existing) return toReport(existing);
    if (kind === "INITIAL") {
      const prior = get("SELECT * FROM reports WHERE session_id = ? AND agent_role = ? AND version = 1", sessionId, role);
      if (prior) {
        if (prior.frozen) throw new Error("El informe inicial ya está congelado y no puede reemplazarse");
        run("DELETE FROM reports WHERE id = ?", prior.id as number);
      }
    }
    const v = kind === "INITIAL" ? 1 : ((get("SELECT MAX(version) AS v FROM reports WHERE session_id = ? AND agent_role = ?", sessionId, role)?.v as number) ?? 0) + 1;
    if (kind === "REVISION" && v < 2) throw new Error("No existe informe inicial que revisar");
    run(
      "INSERT INTO reports (session_id, agent_role, version, kind, phase, frozen, content_json, task_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      sessionId,
      role,
      v,
      kind,
      phase,
      kind === "REVISION" ? 1 : 0,
      j(content),
      taskKey ?? null,
      nowIso(),
    );
    return toReport(get("SELECT * FROM reports WHERE session_id = ? AND agent_role = ? AND version = ?", sessionId, role, v)!);
  });
}

export function freezeInitialReports(sessionId: string): number {
  return Number(run("UPDATE reports SET frozen = 1 WHERE session_id = ? AND kind = 'INITIAL' AND frozen = 0", sessionId).changes);
}

export function listReports<T = unknown>(sessionId: string, role?: AgentRole): ReportRow<T>[] {
  const rows = role
    ? all("SELECT * FROM reports WHERE session_id = ? AND agent_role = ? ORDER BY version", sessionId, role)
    : all("SELECT * FROM reports WHERE session_id = ? ORDER BY agent_role, version", sessionId);
  return rows.map((r) => toReport<T>(r));
}

export function latestReport<T = unknown>(sessionId: string, role: AgentRole): ReportRow<T> | null {
  const r = get("SELECT * FROM reports WHERE session_id = ? AND agent_role = ? ORDER BY version DESC LIMIT 1", sessionId, role);
  return r ? toReport<T>(r) : null;
}

export function initialReport<T = unknown>(sessionId: string, role: AgentRole): ReportRow<T> | null {
  const r = get("SELECT * FROM reports WHERE session_id = ? AND agent_role = ? AND version = 1", sessionId, role);
  return r ? toReport<T>(r) : null;
}

/* ------------------------------ messages ---------------------------- */

export interface MessageRow {
  id: number;
  sessionId: string;
  round: number;
  phase: string;
  ticker: string | null;
  fromRole: AgentRole;
  toRole: AgentRole | "ALL";
  type: MessageType;
  claim: string;
  evidenceText: string | null;
  evidenceIds: string[];
  question: string | null;
  expectedOutcome: string | null;
  inReplyTo: number | null;
  taskKey: string | null;
  createdAt: string;
}

function toMessage(r: Row): MessageRow {
  return {
    id: r.id as number,
    sessionId: r.session_id as string,
    round: r.round as number,
    phase: r.phase as string,
    ticker: (r.ticker as string) ?? null,
    fromRole: r.from_role as AgentRole,
    toRole: r.to_role as AgentRole | "ALL",
    type: r.type as MessageType,
    claim: r.claim as string,
    evidenceText: (r.evidence_text as string) ?? null,
    evidenceIds: pj(r.evidence_ids_json, []),
    question: (r.question as string) ?? null,
    expectedOutcome: (r.expected_outcome as string) ?? null,
    inReplyTo: (r.in_reply_to as number) ?? null,
    taskKey: (r.task_key as string) ?? null,
    createdAt: r.created_at as string,
  };
}

export function insertMessage(m: Omit<MessageRow, "id" | "createdAt">): MessageRow {
  const res = run(
    "INSERT INTO messages (session_id, round, phase, ticker, from_role, to_role, type, claim, evidence_text, evidence_ids_json, question, expected_outcome, in_reply_to, task_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    m.sessionId,
    m.round,
    m.phase,
    m.ticker,
    m.fromRole,
    m.toRole,
    m.type,
    m.claim,
    m.evidenceText,
    j(m.evidenceIds),
    m.question,
    m.expectedOutcome,
    m.inReplyTo,
    m.taskKey,
    nowIso(),
  );
  return toMessage(get("SELECT * FROM messages WHERE id = ?", Number(res.lastInsertRowid))!);
}

export function listMessages(sessionId: string, f: { ticker?: string; role?: AgentRole; round?: number; type?: MessageType; taskKey?: string } = {}): MessageRow[] {
  const where = ["session_id = ?"];
  const p: SQLInputValue[] = [sessionId];
  if (f.ticker) {
    where.push("ticker = ?");
    p.push(f.ticker);
  }
  if (f.role) {
    where.push("(from_role = ? OR to_role = ?)");
    p.push(f.role, f.role);
  }
  if (f.round !== undefined) {
    where.push("round = ?");
    p.push(f.round);
  }
  if (f.type) {
    where.push("type = ?");
    p.push(f.type);
  }
  if (f.taskKey) {
    where.push("task_key = ?");
    p.push(f.taskKey);
  }
  return all(`SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY id`, ...p).map(toMessage);
}

export function getMessage(id: number): MessageRow | null {
  const r = get("SELECT * FROM messages WHERE id = ?", id);
  return r ? toMessage(r) : null;
}

/** Idempotency: messages from a task are written once, even if the task re-runs after a crash. */
export function deleteMessagesForTask(sessionId: string, taskKey: string) {
  run("DELETE FROM messages WHERE session_id = ? AND task_key = ?", sessionId, taskKey);
}

/* ------------------------------- issues ----------------------------- */

export interface IssueClaim {
  by: AgentRole | "SYSTEM";
  statement: string;
  value?: number | null;
  unit?: string | null;
  evidenceIds?: string[];
}

export interface IssueRow {
  id: number;
  sessionId: string;
  ticker: string | null;
  kind: IssueKind;
  critical: boolean;
  status: IssueStatus;
  title: string;
  description: string | null;
  claims: IssueClaim[];
  evidenceIds: string[];
  resolution: string | null;
  resolvedValue: number | null;
  assignedTo: AgentRole | null;
  verificationAttempts: number;
  createdBy: string;
  sourceMessageId: number | null;
  createdAt: string;
  updatedAt: string;
}

function toIssue(r: Row): IssueRow {
  return {
    id: r.id as number,
    sessionId: r.session_id as string,
    ticker: (r.ticker as string) ?? null,
    kind: r.kind as IssueKind,
    critical: Boolean(r.critical),
    status: r.status as IssueStatus,
    title: r.title as string,
    description: (r.description as string) ?? null,
    claims: pj(r.claims_json, []),
    evidenceIds: pj(r.evidence_ids_json, []),
    resolution: (r.resolution as string) ?? null,
    resolvedValue: (r.resolved_value as number) ?? null,
    assignedTo: (r.assigned_to as AgentRole) ?? null,
    verificationAttempts: r.verification_attempts as number,
    createdBy: r.created_by as string,
    sourceMessageId: (r.source_message_id as number) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export function createIssue(i: {
  sessionId: string;
  ticker: string | null;
  kind: IssueKind;
  critical: boolean;
  title: string;
  description?: string;
  claims: IssueClaim[];
  evidenceIds?: string[];
  createdBy: string;
  sourceMessageId?: number | null;
  assignedTo?: AgentRole | null;
}): IssueRow {
  const now = nowIso();
  const res = run(
    "INSERT INTO issues (session_id, ticker, kind, critical, status, title, description, claims_json, evidence_ids_json, created_by, source_message_id, assigned_to, created_at, updated_at) VALUES (?,?,?,?, 'OPEN', ?,?,?,?,?,?,?,?,?)",
    i.sessionId,
    i.ticker,
    i.kind,
    i.critical ? 1 : 0,
    i.title,
    i.description ?? null,
    j(i.claims),
    j(i.evidenceIds ?? []),
    i.createdBy,
    i.sourceMessageId ?? null,
    i.assignedTo ?? null,
    now,
    now,
  );
  const id = Number(res.lastInsertRowid);
  addIssueHistory(id, i.createdBy, "CREATED", { title: i.title, claims: i.claims });
  return getIssue(id)!;
}

export function getIssue(id: number): IssueRow | null {
  const r = get("SELECT * FROM issues WHERE id = ?", id);
  return r ? toIssue(r) : null;
}

export function listIssues(sessionId: string, f: { ticker?: string; status?: IssueStatus[] } = {}): IssueRow[] {
  const rows = f.ticker
    ? all("SELECT * FROM issues WHERE session_id = ? AND ticker = ? ORDER BY id", sessionId, f.ticker)
    : all("SELECT * FROM issues WHERE session_id = ? ORDER BY id", sessionId);
  const list = rows.map(toIssue);
  return f.status ? list.filter((x) => f.status!.includes(x.status)) : list;
}

export function updateIssue(
  id: number,
  actor: string,
  change: Partial<Pick<IssueRow, "status" | "resolution" | "resolvedValue" | "assignedTo" | "critical">> & { addEvidenceIds?: string[]; addClaims?: IssueClaim[]; incrementAttempts?: boolean },
) {
  const cur = getIssue(id);
  if (!cur) throw new Error(`Incidencia no encontrada: ${id}`);
  const evidenceIds = Array.from(new Set([...cur.evidenceIds, ...(change.addEvidenceIds ?? [])]));
  const claims = [...cur.claims, ...(change.addClaims ?? [])];
  run(
    "UPDATE issues SET status = ?, resolution = ?, resolved_value = ?, assigned_to = ?, critical = ?, evidence_ids_json = ?, claims_json = ?, verification_attempts = verification_attempts + ?, updated_at = ? WHERE id = ?",
    change.status ?? cur.status,
    change.resolution !== undefined ? change.resolution : cur.resolution,
    change.resolvedValue !== undefined ? change.resolvedValue : cur.resolvedValue,
    change.assignedTo !== undefined ? change.assignedTo : cur.assignedTo,
    (change.critical ?? cur.critical) ? 1 : 0,
    j(evidenceIds),
    j(claims),
    change.incrementAttempts ? 1 : 0,
    nowIso(),
    id,
  );
  addIssueHistory(id, actor, change.status ? `STATUS:${cur.status}→${change.status}` : "UPDATED", change);
  return getIssue(id)!;
}

export function addIssueHistory(issueId: number, actor: string, change: string, details: unknown) {
  run("INSERT INTO issue_history (issue_id, at, actor, change, details_json) VALUES (?,?,?,?,?)", issueId, nowIso(), actor, change, j(details));
}

export function listIssueHistory(issueId: number) {
  return all("SELECT * FROM issue_history WHERE issue_id = ? ORDER BY id", issueId).map((r) => ({
    at: r.at as string,
    actor: r.actor as string,
    change: r.change as string,
    details: pj(r.details_json, null),
  }));
}

/* ---------------------------- hypotheses ---------------------------- */

export function insertHypothesis(h: { sessionId: string; issueId: number | null; ticker: string | null; label: string; proposedBy: string; assumptions: unknown; consequence: unknown }) {
  run(
    "INSERT INTO hypotheses (session_id, issue_id, ticker, label, proposed_by, assumptions_json, consequence_json, created_at) VALUES (?,?,?,?,?,?,?,?)",
    h.sessionId,
    h.issueId,
    h.ticker,
    h.label,
    h.proposedBy,
    j(h.assumptions),
    j(h.consequence),
    nowIso(),
  );
}

export function listHypotheses(sessionId: string, ticker?: string) {
  const rows = ticker
    ? all("SELECT * FROM hypotheses WHERE session_id = ? AND ticker = ? ORDER BY id", sessionId, ticker)
    : all("SELECT * FROM hypotheses WHERE session_id = ? ORDER BY id", sessionId);
  return rows.map((r) => ({
    id: r.id as number,
    issueId: (r.issue_id as number) ?? null,
    ticker: (r.ticker as string) ?? null,
    label: r.label as string,
    proposedBy: r.proposed_by as string,
    assumptions: pj(r.assumptions_json, null),
    consequence: pj(r.consequence_json, null),
    createdAt: r.created_at as string,
  }));
}

/* ---------------------------- calculations -------------------------- */

export function insertCalculation(c: { sessionId: string; ticker: string | null; kind: string; formula: string; inputs: unknown; outputs: unknown }) {
  const res = run(
    "INSERT INTO calculations (session_id, ticker, kind, formula, inputs_json, outputs_json, created_at) VALUES (?,?,?,?,?,?,?)",
    c.sessionId,
    c.ticker,
    c.kind,
    c.formula,
    j(c.inputs),
    j(c.outputs),
    nowIso(),
  );
  return Number(res.lastInsertRowid);
}

export function listCalculations(sessionId: string, ticker?: string) {
  const rows = ticker
    ? all("SELECT * FROM calculations WHERE session_id = ? AND ticker = ? ORDER BY id", sessionId, ticker)
    : all("SELECT * FROM calculations WHERE session_id = ? ORDER BY id", sessionId);
  return rows.map((r) => ({
    id: r.id as number,
    ticker: (r.ticker as string) ?? null,
    kind: r.kind as string,
    formula: r.formula as string,
    inputs: pj(r.inputs_json, null),
    outputs: pj(r.outputs_json, null),
    createdAt: r.created_at as string,
  }));
}

/* ------------------------------ verdicts ---------------------------- */

export interface VerdictRow {
  ticker: string;
  rank: number | null;
  verdict: Verdict;
  cioProposedVerdict: Verdict | null;
  overrideReason: string | null;
  finalScore: number | null;
  content: Record<string, unknown>;
}

export function saveVerdicts(sessionId: string, rows: VerdictRow[]) {
  tx(db(), () => {
    run("DELETE FROM verdicts WHERE session_id = ?", sessionId);
    for (const v of rows) {
      run(
        "INSERT INTO verdicts (session_id, ticker, rank, verdict, cio_proposed_verdict, override_reason, final_score, content_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        sessionId,
        v.ticker,
        v.rank,
        v.verdict,
        v.cioProposedVerdict,
        v.overrideReason,
        v.finalScore,
        j(v.content),
        nowIso(),
      );
    }
  });
}

export function listVerdicts(sessionId: string): VerdictRow[] {
  return all("SELECT * FROM verdicts WHERE session_id = ? ORDER BY rank IS NULL, rank, final_score DESC", sessionId).map((r) => ({
    ticker: r.ticker as string,
    rank: (r.rank as number) ?? null,
    verdict: r.verdict as Verdict,
    cioProposedVerdict: (r.cio_proposed_verdict as Verdict) ?? null,
    overrideReason: (r.override_reason as string) ?? null,
    finalScore: (r.final_score as number) ?? null,
    content: pj(r.content_json, {}),
  }));
}

export function saveFinalReport(sessionId: string, content: unknown, validated: boolean) {
  run(
    "INSERT INTO final_reports (session_id, content_json, validated, created_at) VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET content_json = excluded.content_json, validated = excluded.validated, created_at = excluded.created_at",
    sessionId,
    j(content),
    validated ? 1 : 0,
    nowIso(),
  );
}

export function getFinalReport<T = Record<string, unknown>>(sessionId: string): { content: T; validated: boolean; createdAt: string } | null {
  const r = get("SELECT * FROM final_reports WHERE session_id = ?", sessionId);
  return r ? { content: pj(r.content_json, {} as T), validated: Boolean(r.validated), createdAt: r.created_at as string } : null;
}

/* ------------------------------- usage ------------------------------ */

export interface UsageRow {
  taskKey: string | null;
  ticker: string | null;
  inputEstimateBasis: string | null;
  agentRole: AgentRole | null;
  phase: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estCostUsd: number | null;
  costBasis: string;
  stopReason: string | null;
  requestId: string | null;
  createdAt: string;
}

export function insertUsage(sessionId: string, u: Omit<UsageRow, "createdAt" | "ticker" | "inputEstimateBasis"> & { ticker?: string | null; inputEstimateBasis?: string | null }) {
  run(
    "INSERT INTO ai_usage (session_id, task_key, ticker, input_estimate_basis, agent_role, phase, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, est_cost_usd, cost_basis, stop_reason, request_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    sessionId,
    u.taskKey,
    u.ticker ?? null,
    u.inputEstimateBasis ?? null,
    u.agentRole,
    u.phase,
    u.model,
    u.inputTokens,
    u.outputTokens,
    u.cacheReadTokens,
    u.cacheWriteTokens,
    u.estCostUsd,
    u.costBasis,
    u.stopReason,
    u.requestId,
    nowIso(),
  );
}

export function listUsage(sessionId: string): UsageRow[] {
  return all("SELECT * FROM ai_usage WHERE session_id = ? ORDER BY id", sessionId).map((r) => ({
    taskKey: (r.task_key as string) ?? null,
    ticker: (r.ticker as string) ?? null,
    inputEstimateBasis: (r.input_estimate_basis as string) ?? null,
    agentRole: (r.agent_role as AgentRole) ?? null,
    phase: (r.phase as string) ?? null,
    model: r.model as string,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    cacheReadTokens: r.cache_read_tokens as number,
    cacheWriteTokens: r.cache_write_tokens as number,
    estCostUsd: (r.est_cost_usd as number) ?? null,
    costBasis: r.cost_basis as string,
    stopReason: (r.stop_reason as string) ?? null,
    requestId: (r.request_id as string) ?? null,
    createdAt: r.created_at as string,
  }));
}

export function usageTotals(sessionId: string) {
  const r = get(
    "SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS inp, COALESCE(SUM(output_tokens),0) AS outp, COALESCE(SUM(cache_read_tokens),0) AS cr, COALESCE(SUM(cache_write_tokens),0) AS cw, COALESCE(SUM(est_cost_usd),0) AS cost FROM ai_usage WHERE session_id = ?",
    sessionId,
  )!;
  return {
    calls: Number(r.calls),
    inputTokens: Number(r.inp),
    outputTokens: Number(r.outp),
    cacheReadTokens: Number(r.cr),
    cacheWriteTokens: Number(r.cw),
    estCostUsd: Number(r.cost),
  };
}

/* ------------------------------- errors ----------------------------- */

export function logError(sessionId: string | null, e: { taskKey?: string | null; phase?: string | null; message: string; details?: string | null }) {
  run(
    "INSERT INTO errors (session_id, task_key, phase, message, details, created_at) VALUES (?,?,?,?,?,?)",
    sessionId,
    e.taskKey ?? null,
    e.phase ?? null,
    e.message,
    e.details ?? null,
    nowIso(),
  );
}

export function listErrors(sessionId: string) {
  return all("SELECT * FROM errors WHERE session_id = ? ORDER BY id", sessionId).map((r) => ({
    taskKey: (r.task_key as string) ?? null,
    phase: (r.phase as string) ?? null,
    message: r.message as string,
    details: (r.details as string) ?? null,
    createdAt: r.created_at as string,
  }));
}

/* ---------------------------- agent memory -------------------------- */

export function addAgentNote(sessionId: string, role: AgentRole, note: string) {
  run("INSERT INTO agent_notes (session_id, agent_role, note, created_at) VALUES (?,?,?,?)", sessionId, role, note.slice(0, 2000), nowIso());
}

/** Working memory is private to each agent: callers must pass the agent's own role. */
export function listAgentNotes(sessionId: string, role: AgentRole): string[] {
  return all("SELECT note FROM agent_notes WHERE session_id = ? AND agent_role = ? ORDER BY id", sessionId, role).map((r) => r.note as string);
}
