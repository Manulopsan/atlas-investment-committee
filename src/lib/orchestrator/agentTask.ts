import type { z } from "zod";
import type { AppSettings } from "../config";
import { insertUsage, setTaskProgress } from "../db/repo";
import { formatZodError, toInputSchema } from "../agents/schemas";
import { PROFILES } from "../agents/profiles";
import { ModelRefusalError, type MessageParam, type ModelAdapter, type ToolUnion } from "../llm/adapter";
import { checkBudget, costOf, COST_BASIS, estimateTokens, priceFor, StopRequestedError, SUBSCRIPTION_COST_BASIS } from "../llm/cost";
import { recordSubscriptionCall } from "../llm/subscription";
import type { MarketData } from "../market-data/types";
import type { AgentRole } from "../types";
import { runTool, toolDefinitions, webSearchTool } from "./tools";
import type Anthropic from "@anthropic-ai/sdk";

export interface OrchestratorDeps {
  adapter: ModelAdapter;
  md: MarketData;
  settings: AppSettings;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  isStopRequested: () => boolean;
}

export interface AgentTaskSpec<S extends z.ZodType> {
  sessionId: string;
  taskKey: string;
  phase: string;
  role: AgentRole;
  model: string;
  prompt: string;
  dataTools: string[];
  submit: { name: string; description: string; schema: S };
  maxIterations: number;
  isFinal?: boolean;
  round1?: boolean;
  /** Company this task is about (null for multi-company tasks) — used for per-company cost. */
  ticker?: string | null;
}

export class AgentOutputError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "AgentOutputError";
  }
}

/**
 * One agent task = one isolated conversation with the model: the agent's own
 * system prompt, the context authorised for this phase, the data tools it may
 * use, and a submit tool whose input is validated by Zod. Every model call is
 * budget-checked beforehand and its usage recorded afterwards.
 */
export async function runAgentTask<S extends z.ZodType>(spec: AgentTaskSpec<S>, deps: OrchestratorDeps): Promise<{ output: z.infer<S>; model: string; iterations: number }> {
  const profile = PROFILES[spec.role];
  const L = deps.settings.limits;
  const submitTool: ToolUnion = { name: spec.submit.name, description: spec.submit.description, input_schema: toInputSchema(spec.submit.schema) };
  const dataTools = spec.dataTools.length ? [...toolDefinitions(spec.dataTools), ...webSearchTool(deps.settings)] : [];
  const messages: MessageParam[] = [{ role: "user", content: spec.prompt }];
  const ctx = { sessionId: spec.sessionId, role: spec.role, phase: spec.phase, round1: Boolean(spec.round1), md: deps.md, settings: deps.settings, fetchImpl: deps.fetchImpl };
  const hardCap = spec.maxIterations + 2;

  for (let iter = 0; iter < hardCap; iter++) {
    if (deps.isStopRequested()) throw new StopRequestedError();
    const lastChance = iter >= spec.maxIterations - 1;
    const tools = lastChance ? [submitTool] : [...dataTools, submitTool];
    let estInput = estimateTokens(profile.system + JSON.stringify(messages) + JSON.stringify(tools));
    let estimateBasis = "heurística (~3 caracteres/token)";
    if (deps.settings.preciseTokenCount && deps.adapter.countTokens) {
      const exact = await deps.adapter.countTokens({ model: spec.model, system: profile.system, messages, tools });
      if (exact !== null) {
        estInput = exact;
        estimateBasis = "count_tokens (exacto)";
      }
    }
    checkBudget(spec.sessionId, deps.settings, { model: spec.model, estInputTokens: estInput, maxOutputTokens: L.maxOutputTokensPerCall, isFinal: Boolean(spec.isFinal) });

    const resp = await deps.adapter.create({
      model: spec.model,
      system: profile.system,
      messages,
      tools,
      maxTokens: L.maxOutputTokensPerCall,
      effort: deps.settings.effort,
      signal: deps.signal,
      meta: { sessionId: spec.sessionId, taskKey: spec.taskKey, role: spec.role, phase: spec.phase, iteration: iter },
    });
    const callCost = deps.adapter.kind === "scripted" ? 0 : costOf(resp.usage, priceFor(deps.settings, resp.model) ?? priceFor(deps.settings, spec.model));
    if (deps.adapter.kind === "subscription" && resp.windowUtilization) recordSubscriptionCall(spec.sessionId, resp.windowUtilization, callCost);
    insertUsage(spec.sessionId, {
      taskKey: spec.taskKey,
      ticker: spec.ticker ?? null,
      inputEstimateBasis: estimateBasis,
      agentRole: spec.role,
      phase: spec.phase,
      model: resp.model,
      inputTokens: resp.usage.input_tokens,
      outputTokens: resp.usage.output_tokens,
      cacheReadTokens: resp.usage.cache_read_input_tokens,
      cacheWriteTokens: resp.usage.cache_creation_input_tokens,
      estCostUsd: callCost,
      costBasis: deps.adapter.kind === "scripted" ? "SIMULADO: adaptador de demostración, sin coste real" : deps.adapter.kind === "subscription" ? SUBSCRIPTION_COST_BASIS : COST_BASIS,
      stopReason: resp.stopReason,
      requestId: resp.requestId,
    });

    if (resp.stopReason === "refusal") throw new ModelRefusalError(null);
    messages.push({ role: "assistant", content: resp.content });
    if (resp.stopReason === "pause_turn") continue;

    const toolUses = resp.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!toolUses.length) {
      if (resp.stopReason === "max_tokens") throw new AgentOutputError("La respuesta se truncó por max_tokens antes de entregar el resultado");
      messages.push({ role: "user", content: `Debes entregar tu resultado llamando a la herramienta ${spec.submit.name}. El texto libre no se guarda.` });
      continue;
    }
    setTaskProgress(spec.sessionId, spec.taskKey, `Iteración ${iter + 1}: ${toolUses.map((t) => t.name).join(", ")}`);

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    let accepted: z.infer<S> | null = null;
    for (const tu of toolUses) {
      if (tu.name === spec.submit.name) {
        const parsed = spec.submit.schema.safeParse(tu.input);
        if (parsed.success) {
          accepted = parsed.data;
        } else {
          results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: `Resultado rechazado por la validación de la aplicación. Corrige y vuelve a enviar:\n${formatZodError(parsed.error)}` });
        }
      }
    }
    if (accepted !== null) return { output: accepted, model: resp.model, iterations: iter + 1 };
    const dataCalls = toolUses.filter((t) => t.name !== spec.submit.name);
    const outs = await Promise.all(dataCalls.map((tu) => (spec.dataTools.includes(tu.name) ? runTool(tu.name, tu.input, ctx) : Promise.resolve({ content: `Herramienta no autorizada en esta fase: ${tu.name}`, isError: true }))));
    dataCalls.forEach((tu, i) => results.push({ type: "tool_result", tool_use_id: tu.id, content: outs[i].content, is_error: outs[i].isError || undefined }));
    const content: Anthropic.Beta.BetaContentBlockParam[] = [...results];
    if (iter + 1 >= spec.maxIterations - 1) {
      content.push({ type: "text", text: `Has alcanzado el límite de iteraciones de herramientas. Entrega ahora tu resultado con ${spec.submit.name}; marca como incertidumbre lo que no hayas podido comprobar.` });
    }
    messages.push({ role: "user", content });
  }
  throw new AgentOutputError(`El agente ${spec.role} no entregó un resultado válido tras ${hardCap} iteraciones`);
}
