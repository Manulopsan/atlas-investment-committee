export const AGENT_ROLES = ["QUALITY", "VALUATION", "RISK", "CIO"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const SESSION_MODES = ["live", "dry_run", "demo"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

/** Session lifecycle. Transitions are validated in state.ts. */
export const SESSION_STATUSES = [
  "CREATED",
  "DISCOVERY",
  "ROUND_1_RUNNING",
  "ROUND_1_COMPLETE",
  "CROSS_REVIEW",
  "DEBATE",
  "VERIFICATION",
  "REVISION",
  "SELECTIVE_DEBATE",
  "FINAL_DECISION",
  "COMPLETED",
  "DRY_RUN_COMPLETE",
  "PAUSED_ERROR",
  "STOPPED_BY_USER",
  "STOPPED_BY_BUDGET",
  "FAILED",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const CONVERGENCE = [
  "RESOLVED",
  "PARTIAL",
  "UNRESOLVED",
  "STOPPED_BY_BUDGET",
  "STOPPED_BY_USER",
  "FAILED",
] as const;
export type Convergence = (typeof CONVERGENCE)[number];

export type TaskStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "CANCELLED";

export const MESSAGE_TYPES = ["ARGUMENT", "OBJECTION", "RESPONSE", "EVIDENCE_REQUEST", "REVISION"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export type DataType = "REPORTED" | "CALCULATED" | "ESTIMATED" | "UNVERIFIED";
export type VerificationStatus = "VERIFIED" | "UNVERIFIED" | "CONFLICT" | "UNREACHABLE";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type PeriodType = "FY" | "Q" | "TTM" | "POINT" | "NA";
export type AccountingBasis = "GAAP" | "NON_GAAP" | "NA";

export type IssueKind = "DATA_CONFLICT" | "FACTUAL_DISPUTE" | "FORECAST" | "JUDGEMENT";
export type IssueStatus = "OPEN" | "VERIFYING" | "RESOLVED" | "PENDING" | "DOCUMENTED";

export const VERDICTS = [
  "POTENTIAL_BUY",
  "EXCELLENT_TOO_EXPENSIVE",
  "WATCHLIST",
  "EXCLUDE",
  "PENDING_VERIFICATION",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_LABELS: Record<Verdict, string> = {
  POTENTIAL_BUY: "Compra potencial al precio indicado",
  EXCELLENT_TOO_EXPENSIVE: "Empresa excelente, pero demasiado cara",
  WATCHLIST: "Mantener en seguimiento",
  EXCLUDE: "Excluir por riesgo o calidad insuficiente",
  PENDING_VERIFICATION: "Pendiente de verificación",
};

export const ROLE_LABELS: Record<AgentRole, string> = {
  QUALITY: "Quality Analyst",
  VALUATION: "Valuation Analyst",
  RISK: "Risk Analyst",
  CIO: "CIO / Investment Director",
};

export type CoverageLevel = "VERIFIED_FULL_UNIVERSE" | "PARTIAL_UNIVERSE" | "CANDIDATE_LIST" | "UNVERIFIED_UNIVERSE";

export const COVERAGE_LABELS: Record<CoverageLevel, string> = {
  VERIFIED_FULL_UNIVERSE: "Universo completo verificado",
  PARTIAL_UNIVERSE: "Universo parcial",
  CANDIDATE_LIST: "Lista de candidatas",
  UNVERIFIED_UNIVERSE: "Universo no verificado",
};
