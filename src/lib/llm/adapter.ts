import type Anthropic from "@anthropic-ai/sdk";
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

/** Abstraction over the model provider. Live sessions use the Anthropic SDK; demo/tests use a scripted adapter. */
export interface ModelAdapter {
  id: string;
  /** "scripted" responses are synthetic and never count as real analysis. */
  kind: "anthropic" | "scripted";
  create(req: ModelRequest): Promise<ModelResponse>;
  /** Exact input-token count for a request, when the provider offers it (null = unavailable). */
  countTokens?(req: Pick<ModelRequest, "model" | "system" | "messages" | "tools">): Promise<number | null>;
}

export class ModelRefusalError extends Error {
  constructor(public category: string | null) {
    super(`El modelo rechazó la solicitud (categoría: ${category ?? "n/d"})`);
    this.name = "ModelRefusalError";
  }
}
