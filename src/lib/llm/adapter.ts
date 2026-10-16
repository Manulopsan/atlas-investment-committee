import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { AgentRole } from "../types";

export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type ToolUnion = Anthropic.Beta.BetaToolUnion;
export type ContentBlock = Anthropic.Beta.BetaContentBlock;

export interface ModelRequest {
  model: string;
  system: string;
  messages: MessageParam[];
  tools: ToolUnion[];
  maxTokens: number;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  signal?: AbortSignal;
  meta: { sessionId: string; taskKey: string; role: AgentRole; phase: string; iteration: number };
}

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface ModelResponse {
  content: ContentBlock[];
  stopReason: string | null;
  usage: ModelUsage;
  model: string;
  requestId: string | null;
}

/** Everything needed to run one agent task (one isolated conversation ending in a validated submission). */
export interface TaskRunSpec {
  sessionId: string;
  taskKey: string;
  phase: string;
  role: AgentRole;
  model: string;
  prompt: string;
  dataTools: string[];
  submit: { name: string; description: string; schema: z.ZodType };
  maxIterations: number;
  isFinal?: boolean;
  round1?: boolean;
  ticker?: string | null;
}

/** Abstraction over the model provider. Live sessions use the Anthropic SDK; demo/tests use a scripted adapter. */
export interface ModelAdapter {
  id: string;
  /** "scripted" responses are synthetic and never count as real analysis. */
  kind: "anthropic" | "scripted" | "claude_code";
  /** Single model call (the orchestrator runs the tool loop). */
  create(req: ModelRequest): Promise<ModelResponse>;
  /**
   * Whole-task execution, for providers that run their own agent loop
   * (Claude Code). When present, the orchestrator delegates the task to it.
   */
  runTask?(spec: TaskRunSpec, ctx: { signal?: AbortSignal; isStopRequested: () => boolean }): Promise<{ output: unknown; model: string; iterations: number }>;
  /** Exact input-token count for a request, when the provider offers it (null = unavailable). */
  countTokens?(req: Pick<ModelRequest, "model" | "system" | "messages" | "tools">): Promise<number | null>;
}

export class ModelRefusalError extends Error {
  constructor(public category: string | null) {
    super(`El modelo rechazó la solicitud (categoría: ${category ?? "n/d"})`);
    this.name = "ModelRefusalError";
  }
}
