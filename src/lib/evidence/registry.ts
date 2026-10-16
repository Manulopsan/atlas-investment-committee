import type { SQLInputValue } from "node:sqlite";
import { getDb, nowIso } from "../db/index";
import { createIssue, listIssues } from "../db/repo";
import type { AccountingBasis, Confidence, DataType, PeriodType, VerificationStatus } from "../types";

export type PriceKind = "REALTIME" | "DELAYED" | "CLOSE" | "USER_SUPPLIED";

export interface EvidenceInput {
  ticker: string | null;
  company?: string | null;
  metric: string;
  value: number | null;
  valueText?: string | null;
  unit: string | null;
  period?: string | null;
  periodType?: PeriodType;
  fiscalYear?: number | null;
  basis?: AccountingBasis;
  publishedAt?: string | null;
  retrievedAt?: string;
  source: string;
  url?: string | null;
  dataType: DataType;
  verification: VerificationStatus;
  priceKind?: PriceKind | null;
  formula?: string | null;
  inputs?: string[];
  confidence: Confidence;
  confidenceReason?: string | null;
  createdBy: string;
  synthetic?: boolean;
}

export interface Evidence extends Required<Omit<EvidenceInput, "inputs" | "synthetic">> {
  id: string;
  inputs: string[];
  synthetic: boolean;
  createdAt: string;
}

type Row = Record<string, unknown>;

function toEvidence(r: Row): Evidence {
  return {
    id: r.id as string,
    ticker: (r.ticker as string) ?? null,
    company: (r.company as string) ?? null,
    metric: r.metric as string,
    value: (r.value as number) ?? null,
    valueText: (r.value_text as string) ?? null,
    unit: (r.unit as string) ?? null,
    period: (r.period as string) ?? null,
    periodType: r.period_type as PeriodType,
    fiscalYear: (r.fiscal_year as number) ?? null,
    basis: r.basis as AccountingBasis,
    publishedAt: (r.published_at as string) ?? null,
    retrievedAt: r.retrieved_at as string,
    source: r.source as string,
    url: (r.url as string) ?? null,
    dataType: r.data_type as DataType,
    verification: r.verification as VerificationStatus,
    priceKind: (r.price_kind as PriceKind) ?? null,
    formula: (r.formula as string) ?? null,
    inputs: r.inputs_json ? (JSON.parse(r.inputs_json as string) as string[]) : [],
    confidence: r.confidence as Confidence,
    confidenceReason: (r.confidence_reason as string) ?? null,
    createdBy: r.created_by as string,
    synthetic: Boolean(r.synthetic),
    createdAt: r.created_at as string,
  };
}

export class EvidenceValidationError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "EvidenceValidationError";
  }
}

/**
 * Validation rules applied to every evidence record:
 *  - VERIFIED requires a source URL (an agent cannot self-certify a claim).
 *  - Only the system (tools that actually fetched the data) may create VERIFIED evidence.
 *  - Prices must carry a timestamp and a price kind (close / delayed / realtime).
 *  - CALCULATED evidence must document its formula.
 */
export function validateEvidence(e: EvidenceInput): EvidenceInput {
  const out = { ...e };
  if (out.verification === "VERIFIED") {
    if (!out.url) throw new EvidenceValidationError("Una evidencia VERIFIED necesita URL de fuente");
    if (!out.createdBy.startsWith("system:")) {
      out.verification = "UNVERIFIED";
    }
  }
  if (out.metric === "price") {
    if (!out.publishedAt) throw new EvidenceValidationError("Una cotización sin fecha no es válida");
    if (!out.priceKind) throw new EvidenceValidationError("La cotización debe indicar si es cierre, retrasada o en tiempo real");
  }
  if (out.dataType === "CALCULATED" && !out.formula) throw new EvidenceValidationError("Una cifra calculada debe documentar su fórmula");
  if (!out.url && out.dataType === "REPORTED") out.verification = out.verification === "VERIFIED" ? "UNVERIFIED" : out.verification;
  if (out.value !== null && !Number.isFinite(out.value)) out.value = null;
  return out;
}

function nextId(sessionId: string): string {
  const r = getDb().prepare("SELECT COUNT(*) AS n FROM evidence WHERE session_id = ?").get(sessionId) as Row;
  return `EV-${Number(r.n) + 1}`;
}

function conflictKey(e: EvidenceInput) {
  return [e.ticker, e.metric, e.period ?? "", e.periodType ?? "NA", e.unit ?? "", e.basis ?? "NA"];
}

/** Relative tolerance for treating two values of the same metric/period as consistent. */
const TOLERANCE = 0.01;

export function addEvidence(sessionId: string, input: EvidenceInput): Evidence {
  const e = validateEvidence(input);
  const db = getDb();
  // Same datapoint from the same source already registered → reuse (idempotent tool calls).
  const dup = db
    .prepare(
      "SELECT * FROM evidence WHERE session_id = ? AND IFNULL(ticker,'') = IFNULL(?, '') AND metric = ? AND IFNULL(period,'') = ? AND IFNULL(url,'') = IFNULL(?, '') AND source = ? AND ((value IS NULL AND ? IS NULL) OR value = ?)",
    )
    .get(sessionId, e.ticker, e.metric, e.period ?? "", e.url ?? null, e.source, e.value, e.value) as Row | undefined;
  if (dup) return toEvidence(dup);

  const id = sessionScopedId(sessionId);
  const now = nowIso();
  db.prepare(
    `INSERT INTO evidence (id, session_id, ticker, company, metric, value, value_text, unit, period, period_type, fiscal_year, basis, published_at, retrieved_at, source, url, data_type, verification, price_kind, formula, inputs_json, confidence, confidence_reason, created_by, synthetic, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    sessionId,
    e.ticker,
    e.company ?? null,
    e.metric,
    e.value,
    e.valueText ?? null,
    e.unit,
    e.period ?? null,
    e.periodType ?? "NA",
    e.fiscalYear ?? null,
    e.basis ?? "NA",
    e.publishedAt ?? null,
    e.retrievedAt ?? now,
    e.source,
    e.url ?? null,
    e.dataType,
    e.verification,
    e.priceKind ?? null,
    e.formula ?? null,
    JSON.stringify(e.inputs ?? []),
    e.confidence,
    e.confidenceReason ?? null,
    e.createdBy,
    e.synthetic ? 1 : 0,
    now,
  );
  detectConflict(sessionId, id);
  return getEvidence(sessionId, id)!;
}

function sessionScopedId(sessionId: string): string {
  // Evidence ids are short and readable for agents; the primary key is session-scoped by prefix.
  const short = nextId(sessionId);
  return `${sessionId.slice(0, 8)}:${short}`;
}

/** Agents see and cite the short id (EV-n); the registry resolves both forms. */
export function shortId(id: string): string {
  const i = id.indexOf(":");
  return i >= 0 ? id.slice(i + 1) : id;
}

export function getEvidence(sessionId: string, id: string): Evidence | null {
  const full = id.includes(":") ? id : `${sessionId.slice(0, 8)}:${id}`;
  const r = getDb().prepare("SELECT * FROM evidence WHERE session_id = ? AND id = ?").get(sessionId, full) as Row | undefined;
  return r ? toEvidence(r) : null;
}

export function listEvidence(sessionId: string, f: { ticker?: string; metric?: string; verification?: VerificationStatus } = {}): Evidence[] {
  const where = ["session_id = ?"];
  const p: SQLInputValue[] = [sessionId];
  if (f.ticker) {
    where.push("ticker = ?");
    p.push(f.ticker);
  }
  if (f.metric) {
    where.push("metric = ?");
    p.push(f.metric);
  }
  if (f.verification) {
    where.push("verification = ?");
    p.push(f.verification);
  }
  return (getDb().prepare(`SELECT * FROM evidence WHERE ${where.join(" AND ")} ORDER BY rowid`).all(...p) as Row[]).map(toEvidence);
}

export function setVerification(sessionId: string, id: string, status: VerificationStatus, reason?: string) {
  const ev = getEvidence(sessionId, id);
  if (!ev) return;
  getDb()
    .prepare("UPDATE evidence SET verification = ?, confidence_reason = COALESCE(?, confidence_reason) WHERE session_id = ? AND id = ?")
    .run(status, reason ?? null, sessionId, ev.id);
}

/**
 * When two records for the same ticker/metric/period/unit/basis disagree by more
 * than the tolerance, both are kept, both are flagged CONFLICT, and a
 * DATA_CONFLICT issue is opened for review. Nothing is overwritten.
 */
function detectConflict(sessionId: string, newId: string) {
  const ne = getEvidence(sessionId, newId)!;
  if (ne.value === null || !ne.ticker || ne.periodType === "POINT") return;
  const [ticker, metric, period, periodType, unit, basis] = conflictKey(ne);
  const others = (getDb()
    .prepare(
      "SELECT * FROM evidence WHERE session_id = ? AND ticker = ? AND metric = ? AND IFNULL(period,'') = ? AND period_type = ? AND IFNULL(unit,'') = ? AND basis = ? AND id != ? AND value IS NOT NULL",
    )
    .all(sessionId, ticker, metric, period, periodType, unit, basis, newId) as Row[]).map(toEvidence);
  for (const o of others) {
    const denom = Math.max(Math.abs(o.value!), Math.abs(ne.value), 1e-9);
    if (Math.abs(o.value! - ne.value) / denom > TOLERANCE) {
      const already = listIssues(sessionId, { ticker: ne.ticker }).some(
        (i) => i.kind === "DATA_CONFLICT" && i.evidenceIds.includes(o.id) && i.evidenceIds.includes(ne.id),
      );
      if (already) continue;
      // The system-fetched record keeps its status unless it is itself contradicted by another system record.
      if (!(o.createdBy.startsWith("system:") && !ne.createdBy.startsWith("system:"))) setVerification(sessionId, o.id, "CONFLICT");
      setVerification(sessionId, ne.id, "CONFLICT");
      createIssue({
        sessionId,
        ticker: ne.ticker,
        kind: "DATA_CONFLICT",
        critical: false,
        title: `Discrepancia en ${metric} ${period || ""} (${ne.ticker})`,
        description: `Dos fuentes registran valores distintos para la misma métrica y periodo. Se conservan ambas referencias.`,
        claims: [
          { by: "SYSTEM", statement: `${shortId(o.id)} (${o.source}) = ${o.value} ${o.unit ?? ""}`, value: o.value, unit: o.unit, evidenceIds: [o.id] },
          { by: "SYSTEM", statement: `${shortId(ne.id)} (${ne.source}) = ${ne.value} ${ne.unit ?? ""}`, value: ne.value, unit: ne.unit, evidenceIds: [ne.id] },
        ],
        evidenceIds: [o.id, ne.id],
        createdBy: "system:evidence-registry",
      });
    }
  }
}

/** Compact, model-readable listing of the registry (used in prompts). */
export function evidenceDigest(sessionId: string, opts: { tickers?: string[]; max?: number } = {}): string {
  const list = listEvidence(sessionId).filter((e) => !opts.tickers || (e.ticker && opts.tickers.includes(e.ticker)));
  const max = opts.max ?? 400;
  const lines = list.slice(0, max).map(
    (e) =>
      `${shortId(e.id)} | ${e.ticker ?? "-"} | ${e.metric} | ${e.value ?? e.valueText ?? "n/d"} ${e.unit ?? ""} | ${e.period ?? ""} ${e.periodType} | ${e.dataType}/${e.verification} | ${e.source}${e.url ? " " + e.url : ""}`,
  );
  if (list.length > max) lines.push(`… ${list.length - max} registros adicionales omitidos`);
  return lines.join("\n");
}

/** Does a citation point to a real, verified evidence record? */
export function citationStatus(sessionId: string, ids: string[] | undefined): { verified: string[]; unverified: string[]; missing: string[] } {
  const out = { verified: [] as string[], unverified: [] as string[], missing: [] as string[] };
  for (const id of ids ?? []) {
    const e = getEvidence(sessionId, id);
    if (!e) out.missing.push(id);
    else if (e.verification === "VERIFIED") out.verified.push(shortId(e.id));
    else out.unverified.push(shortId(e.id));
  }
  return out;
}
