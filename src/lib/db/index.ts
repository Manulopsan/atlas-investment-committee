import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live','dry_run','demo')),
  status TEXT NOT NULL,
  resume_status TEXT,
  convergence TEXT,
  config_json TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  coverage_json TEXT,
  estimate_json TEXT,
  stop_requested INTEGER NOT NULL DEFAULT 0,
  budget_exhausted INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  cutoff_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  phase TEXT NOT NULL,
  agent_role TEXT,
  ticker TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  progress_note TEXT,
  result_json TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (session_id, task_key)
);

CREATE TABLE IF NOT EXISTS candidates (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  cik TEXT,
  name TEXT,
  exchange TEXT,
  sic TEXT,
  sector TEXT,
  source TEXT NOT NULL,
  included INTEGER NOT NULL,
  exclusion_reason TEXT,
  screen_json TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, ticker)
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_role TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('INITIAL','REVISION')),
  phase TEXT NOT NULL,
  frozen INTEGER NOT NULL DEFAULT 0,
  content_json TEXT NOT NULL,
  task_key TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, agent_role, version)
);

-- Frozen reports are immutable: revisions are inserted as new versions.
CREATE TRIGGER IF NOT EXISTS reports_no_update_frozen
BEFORE UPDATE ON reports
WHEN OLD.frozen = 1
BEGIN
  SELECT RAISE(ABORT, 'report is frozen and immutable');
END;

CREATE TRIGGER IF NOT EXISTS reports_no_delete_frozen
BEFORE DELETE ON reports
WHEN OLD.frozen = 1 AND (SELECT COUNT(*) FROM sessions WHERE id = OLD.session_id) > 0
BEGIN
  SELECT RAISE(ABORT, 'report is frozen and immutable');
END;

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  phase TEXT NOT NULL,
  ticker TEXT,
  from_role TEXT NOT NULL,
  to_role TEXT NOT NULL,
  type TEXT NOT NULL,
  claim TEXT NOT NULL,
  evidence_text TEXT,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  question TEXT,
  expected_outcome TEXT,
  in_reply_to INTEGER,
  task_key TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ticker TEXT,
  company TEXT,
  metric TEXT NOT NULL,
  value REAL,
  value_text TEXT,
  unit TEXT,
  period TEXT,
  period_type TEXT NOT NULL DEFAULT 'NA',
  fiscal_year INTEGER,
  basis TEXT NOT NULL DEFAULT 'NA',
  published_at TEXT,
  retrieved_at TEXT NOT NULL,
  source TEXT NOT NULL,
  url TEXT,
  data_type TEXT NOT NULL,
  verification TEXT NOT NULL,
  price_kind TEXT,
  formula TEXT,
  inputs_json TEXT,
  confidence TEXT NOT NULL,
  confidence_reason TEXT,
  created_by TEXT NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ticker TEXT,
  kind TEXT NOT NULL,
  critical INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  claims_json TEXT NOT NULL DEFAULT '[]',
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  resolution TEXT,
  resolved_value REAL,
  assigned_to TEXT,
  verification_attempts INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  source_message_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issue_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  change TEXT NOT NULL,
  details_json TEXT
);

CREATE TABLE IF NOT EXISTS hypotheses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  issue_id INTEGER,
  ticker TEXT,
  label TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  assumptions_json TEXT NOT NULL,
  consequence_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calculations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ticker TEXT,
  kind TEXT NOT NULL,
  formula TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  outputs_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  rank INTEGER,
  verdict TEXT NOT NULL,
  cio_proposed_verdict TEXT,
  override_reason TEXT,
  final_score REAL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, ticker)
);

CREATE TABLE IF NOT EXISTS final_reports (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  content_json TEXT NOT NULL,
  validated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_key TEXT,
  agent_role TEXT,
  phase TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  est_cost_usd REAL,
  cost_basis TEXT NOT NULL,
  stop_reason TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  task_key TEXT,
  phase TEXT,
  message TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_role TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evals (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  cases_json TEXT NOT NULL,
  results_json TEXT,
  metrics_json TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
CREATE INDEX IF NOT EXISTS idx_evidence_session ON evidence(session_id, ticker, metric);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id, phase);
CREATE INDEX IF NOT EXISTS idx_usage_session ON ai_usage(session_id);
`;

let instance: DatabaseSync | null = null;

/** Additive migrations for databases created by earlier versions (idempotent). */
const MIGRATIONS: string[] = [
  "ALTER TABLE ai_usage ADD COLUMN ticker TEXT",
  "ALTER TABLE ai_usage ADD COLUMN input_estimate_basis TEXT",
  "ALTER TABLE sessions ADD COLUMN run_requested INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE sessions ADD COLUMN lease_owner TEXT",
  "ALTER TABLE sessions ADD COLUMN lease_until TEXT",
];

function migrate(db: DatabaseSync) {
  for (const m of MIGRATIONS) {
    try {
      db.exec(m);
    } catch (e) {
      if (!/duplicate column/i.test(String((e as Error).message))) throw e;
    }
  }
}

export function openDb(file: string): DatabaseSync {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Process-wide database handle. Tests can inject an in-memory DB. */
export function getDb(): DatabaseSync {
  if (!instance) {
    const file = process.env.ATLAS_DB_PATH?.trim() || path.join(process.cwd(), "data", "atlas.db");
    instance = openDb(file);
  }
  return instance;
}

export function setDbForTesting(db: DatabaseSync | null): void {
  instance = db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

const depth = new WeakMap<DatabaseSync, number>();

/** Synchronous, re-entrant transaction (nested calls use savepoints). */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  const sp = `sp_${d}`;
  db.exec(d === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
  depth.set(db, d + 1);
  try {
    const out = fn();
    depth.set(db, d);
    db.exec(d === 0 ? "COMMIT" : `RELEASE ${sp}`);
    return out;
  } catch (e) {
    depth.set(db, d);
    db.exec(d === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}
