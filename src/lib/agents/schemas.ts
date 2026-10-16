import { z } from "zod";
import { AGENT_ROLES, MESSAGE_TYPES, VERDICTS, type AgentRole } from "../types";
import { PROFILES } from "./profiles";
import type { Reconciliation } from "../evidence/reconcile";

/**
 * Structured outputs of every agent task. The model submits them through a
 * "submit_*" tool; the application validates them with these schemas and
 * rejects (with an explanation sent back to the model) anything invalid.
 */
const Role = z.enum(AGENT_ROLES);
const Ticker = z.string().min(1).max(12).transform((s) => s.toUpperCase());
const EvidenceIds = z.array(z.string()).max(30).default([]);

export const MetricCitation = z.object({
  name: z.string().min(1),
  value: z.number().nullable(),
  unit: z.string().min(1),
  period: z.string().min(1).describe("Periodo fiscal, p.ej. FY2025, Q2-2026, TTM, o fecha de la cotización"),
  evidence_id: z.string().nullable().describe("EV-n devuelto por una herramienta; null si no hay evidencia"),
  note: z.string().optional(),
});

export const SourceRef = z.object({ title: z.string(), url: z.string(), evidence_id: z.string().nullable().optional() });

export const ScenarioInput = z.object({
  metric: z.enum(["EPS", "FCF_PER_SHARE"]),
  metric_year_n: z.number().nullable().describe("Métrica por acción en el año del horizonte"),
  exit_multiple: z.number().nullable(),
  cumulative_dividends_per_share: z.number().nullable().describe("Dividendos acumulados por acción en el horizonte; 0 solo si no paga"),
  rationale: z.string(),
});

export const ValuationBlock = z.object({
  discount_rate: z.number().min(0.03).max(0.25),
  reference_price_evidence_id: z.string().nullable(),
  scenarios: z.object({ bear: ScenarioInput, base: ScenarioInput, bull: ScenarioInput }),
  valuation_view: z.enum(["UNDERVALUED", "FAIR", "OVERVALUED", "INSUFFICIENT_DATA"]),
  flags: z.array(z.enum(["EXCELLENT_BUT_EXPENSIVE", "CHEAP_LOW_QUALITY", "HIGH_ASSUMPTION_SENSITIVITY"])).default([]),
});

export const Veto = z.object({
  ticker: Ticker,
  reason: z.string().min(5),
  evidence: z.string().min(5),
  source_url: z.string().nullable(),
  evidence_ids: EvidenceIds,
  severity: z.enum(["critical", "high", "medium"]),
  status: z.enum(["upheld", "withdrawn"]).default("upheld"),
});
export type VetoT = z.infer<typeof Veto>;

function scoresSchema(role: AgentRole) {
  const shape: Record<string, z.ZodNumber> = {};
  for (const c of PROFILES[role].criteria) shape[c.key] = z.number().min(0).max(c.max).describe(`${c.label} (0–${c.max})`);
  return z.object(shape);
}

function companySchema(role: AgentRole) {
  const base = z.object({
    ticker: Ticker,
    thesis: z.string().min(10),
    metrics: z.array(MetricCitation).max(40),
    scores: scoresSchema(role),
    provisional_conclusion: z.string().min(5),
    uncertainties: z.array(z.string()).default([]),
    key_points: z.array(z.string()).default([]),
  });
  if (role === "VALUATION") return base.extend({ valuation: ValuationBlock.nullable() });
  return base;
}

export function initialReportSchema(role: AgentRole) {
  const base = z.object({
    executive_summary: z.string().min(20),
    companies: z.array(companySchema(role)).min(1).max(30),
    sources: z.array(SourceRef).default([]),
    uncertainties: z.array(z.string()).default([]),
    provisional_conclusions: z.string().min(10),
  });
  if (role === "RISK") return base.extend({ vetoes: z.array(Veto).default([]) });
  if (role === "CIO") return base.extend({ critical_questions: z.array(z.string()).min(1).max(15) });
  return base;
}

export interface CompanyAnalysisT {
  ticker: string;
  thesis: string;
  metrics: z.infer<typeof MetricCitation>[];
  scores: Record<string, number>;
  provisional_conclusion: string;
  uncertainties: string[];
  key_points: string[];
  valuation?: z.infer<typeof ValuationBlock> | null;
}

export interface InitialReportT {
  executive_summary: string;
  companies: CompanyAnalysisT[];
  sources: z.infer<typeof SourceRef>[];
  uncertainties: string[];
  provisional_conclusions: string;
  vetoes?: VetoT[];
  critical_questions?: string[];
}

/** Stored report = validated model output + fields the application fills in itself. */
export interface StoredReport extends InitialReportT {
  role: AgentRole;
  generated_at: string;
  model: string;
  totals: Record<string, number>;
  citation_check: Record<string, { verified: string[]; unverified: string[]; missing: string[] }>;
  /** Figures written in free text, reconciled against the evidence registry. */
  reconciliation?: Record<string, Reconciliation>;
}

export const FactualDispute = z.object({
  metric: z.string(),
  period: z.string(),
  unit: z.string(),
  reported_value: z.number().nullable(),
  alternative_value: z.number().nullable(),
});

export const CrossReviewSchema = z.object({
  strong_arguments: z.array(z.object({ about_role: Role, ticker: Ticker.nullable(), summary: z.string() })).min(3).max(6),
  objections: z.array(z.object({
    target_role: Role,
    ticker: Ticker.nullable(),
    claim: z.string(),
    evidence: z.string(),
    evidence_ids: EvidenceIds,
    severity: z.enum(["critical", "major", "minor"]),
  })).min(3).max(8),
  potential_factual_errors: z.array(z.object({
    target_role: Role,
    ticker: Ticker,
    explanation: z.string(),
    evidence_ids: EvidenceIds,
    dispute: FactualDispute,
  })).max(10).default([]),
  questionable_assumptions: z.array(z.object({ target_role: Role, ticker: Ticker.nullable(), assumption: z.string(), why: z.string() })).max(10).default([]),
  open_questions: z.array(z.object({ ticker: Ticker.nullable(), question: z.string(), addressed_to: Role })).max(10).default([]),
  list_changes: z.object({
    add: z.array(z.object({ ticker: Ticker, reason: z.string() })).default([]),
    remove: z.array(z.object({ ticker: Ticker, reason: z.string() })).default([]),
  }),
  debate_priority: z.array(Ticker).max(10).default([]).describe("Tickers que deberían debatirse primero"),
});
export type CrossReviewT = z.infer<typeof CrossReviewSchema>;

export const DebateMessageSchema = z.object({
  to: z.enum([...AGENT_ROLES, "ALL"]),
  type: z.enum(MESSAGE_TYPES),
  claim: z.string().min(5),
  evidence: z.string().default(""),
  evidence_ids: EvidenceIds,
  question: z.string().nullable(),
  expected_outcome: z.string().min(3),
  in_reply_to: z.number().int().nullable(),
  factual_dispute: FactualDispute.nullable().default(null),
});
export type DebateMessageT = z.infer<typeof DebateMessageSchema>;

export const DebateTurnSchema = z.object({ messages: z.array(DebateMessageSchema).min(1).max(4) });

export const Alternative = z.object({
  label: z.string(),
  proposed_by: Role,
  metric_year_n: z.number().nullable(),
  exit_multiple: z.number().nullable(),
  cumulative_dividends_per_share: z.number().nullable(),
});

export const CioTurnSchema = z.object({
  messages: z.array(DebateMessageSchema).min(1).max(4),
  controversies: z.array(z.object({
    description: z.string(),
    kind: z.enum(["FACTUAL", "FORECAST", "JUDGEMENT"]),
    critical: z.boolean(),
    assigned_to: Role,
    action: z.enum(["VERIFY", "RECALCULATE", "RESPOND", "NONE"]),
    dispute: FactualDispute.nullable().default(null),
    alternatives: z.array(Alternative).max(4).default([]),
  })).max(6),
});
export type CioTurnT = z.infer<typeof CioTurnSchema>;

export const VerificationSchema = z.object({
  issue_id: z.number().int(),
  outcome: z.enum(["RESOLVED", "UNRESOLVABLE"]),
  corrected_value: z.number().nullable(),
  unit: z.string().nullable(),
  evidence_ids: EvidenceIds,
  explanation: z.string().min(5),
});
export type VerificationT = z.infer<typeof VerificationSchema>;

export function revisionSchema(role: AgentRole) {
  const company = z.object({
    ticker: Ticker,
    revised_scores: scoresSchema(role),
    revised_conclusion: z.string().min(5),
    accepted_arguments: z.array(z.object({ message_id: z.number().int().nullable(), summary: z.string() })).default([]),
    rejected_arguments: z.array(z.object({ message_id: z.number().int().nullable(), summary: z.string(), reason: z.string() })).default([]),
    new_data: z.array(z.object({ evidence_id: z.string().nullable(), summary: z.string() })).default([]),
    unresolved: z.array(z.string()).default([]),
    change_reason: z.string().describe("Por qué cambian (o no) las puntuaciones"),
    ...(role === "VALUATION" ? { valuation: ValuationBlock.nullable() } : {}),
  });
  const base = z.object({ executive_summary: z.string().min(10), companies: z.array(company).min(1).max(30) });
  if (role === "RISK") return base.extend({ vetoes: z.array(Veto).default([]) });
  return base;
}

export interface RevisionCompanyT {
  ticker: string;
  revised_scores: Record<string, number>;
  revised_conclusion: string;
  accepted_arguments: { message_id: number | null; summary: string }[];
  rejected_arguments: { message_id: number | null; summary: string; reason: string }[];
  new_data: { evidence_id: string | null; summary: string }[];
  unresolved: string[];
  change_reason: string;
  valuation?: z.infer<typeof ValuationBlock> | null;
}

export interface StoredRevision {
  role: AgentRole;
  generated_at: string;
  model: string;
  round: number;
  executive_summary: string;
  companies: (RevisionCompanyT & {
    original_scores: Record<string, number> | null;
    original_total: number | null;
    revised_total: number;
    original_conclusion: string | null;
    reconciliation?: Reconciliation;
  })[];
  vetoes?: VetoT[];
}

export const SelectiveAgendaSchema = z.object({
  controversies: z.array(z.object({
    ticker: Ticker,
    question: z.string().min(5),
    addressed_to: z.array(Role).min(1).max(3),
    category: z.enum(["QUALITY_VS_VALUATION", "PERMANENT_LOSS", "NEAR_THRESHOLD", "UNVERIFIED_CRITICAL_DATA", "ENTRY_PRICE_SENSITIVITY", "OTHER"]),
    why_decision_relevant: z.string(),
  })).max(8),
});
export type SelectiveAgendaT = z.infer<typeof SelectiveAgendaSchema>;

export function selectiveAnswerSchema(role: AgentRole) {
  return z.object({
    answers: z.array(z.object({
      controversy_index: z.number().int().min(0),
      answer: z.string().min(5),
      evidence_ids: EvidenceIds,
      position_changed: z.boolean(),
    })).min(1).max(8),
    revised_companies: z.array(revisionSchema(role).shape.companies.element).max(10).default([]),
    vetoes: role === "RISK" ? z.array(Veto).default([]) : z.array(Veto).max(0).default([]),
  });
}

export const FinalDecisionSchema = z.object({
  executive_summary: z.string().min(20),
  companies: z.array(z.object({
    ticker: Ticker,
    catalysts_score: z.number().min(0).max(100),
    catalysts: z.array(z.object({ description: z.string(), verifiable: z.boolean(), evidence_ids: EvidenceIds })).default([]),
    proposed_verdict: z.enum(VERDICTS),
    rationale: z.string().min(10),
    consensus: z.array(z.string()).default([]),
    dissent: z.array(z.string()).default([]),
    conditions_for_target: z.array(z.string()).default([]).describe("Hipótesis que deben cumplirse para aproximarse al objetivo"),
  })).min(1).max(15),
  portfolio_note: z.string().default(""),
  limitations: z.array(z.string()).default([]),
});
export type FinalDecisionT = z.infer<typeof FinalDecisionSchema>;

/** JSON schema for an Anthropic tool input. */
export function toInputSchema(schema: z.ZodType): { type: "object"; [k: string]: unknown } {
  const js = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete js.$schema;
  return js as { type: "object"; [k: string]: unknown };
}

/** Human-readable validation error returned to the model so it can correct itself. */
export function formatZodError(e: z.ZodError): string {
  return e.issues.slice(0, 15).map((i) => `- ${i.path.join(".") || "(raíz)"}: ${i.message}`).join("\n");
}

/**
 * Submit-tool name → validation schema. Shared by the in-process tool loop and
 * the MCP server used with Claude Code, so both validate exactly the same way.
 */
export function submitSchema(name: string, role: AgentRole): z.ZodType | null {
  switch (name) {
    case "submit_initial_report":
      return initialReportSchema(role);
    case "submit_cross_review":
      return CrossReviewSchema;
    case "submit_debate_turn":
      return DebateTurnSchema;
    case "submit_cio_turn":
      return CioTurnSchema;
    case "submit_verification":
      return VerificationSchema;
    case "submit_revision":
      return revisionSchema(role);
    case "submit_selective_agenda":
      return SelectiveAgendaSchema;
    case "submit_selective_answer":
      return selectiveAnswerSchema(role);
    case "submit_final_decision":
      return FinalDecisionSchema;
    default:
      return null;
  }
}
