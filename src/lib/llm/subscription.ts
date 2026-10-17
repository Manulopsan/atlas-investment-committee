import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSdkMcpServer, query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { getKv, setKv } from "../db/repo";
import type { ContentBlock, MessageParam, ModelAdapter, ModelRequest, ModelResponse, ModelUsage } from "./adapter";
import type { AppSettings } from "../config";
import { SubscriptionLimitError, type PlanEstimate, type SubscriptionEstimate } from "./cost";
import { lastSubscriptionStatus, rememberSubscriptionStatus as remember, type SubscriptionStatus, type UsageWindow } from "./usageWindow";

export { lastSubscriptionStatus, type SubscriptionStatus };

/**
 * Claude subscription adapter (server-only). Calls go through the Claude Agent
 * SDK, which runs Claude Code with the account logged in on this machine
 * (`claude` → /login, or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`).
 * Usage counts against the plan's 5-hour / 7-day windows instead of an API bill.
 *
 * The orchestrator keeps its own tool loop: each create() is one model turn.
 * The request's tools are exposed through an in-process MCP server, but every
 * call is denied before it runs; the tool_use blocks are handed back to the
 * orchestrator, which executes them and sends the results in the next turn.
 * Earlier turns are replayed as a text transcript (one block per entry so the
 * prompt cache can reuse the stable prefix).
 */

const MCP_SERVER = "atlas";
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;

/* ----------------------------- usage windows ----------------------------- */

/** True when Claude Code is logged in on this machine (credentials file or a `claude setup-token` token). */
export function claudeLoginAvailable(): boolean {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return true;
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  return fs.existsSync(path.join(dir, ".credentials.json"));
}

/** Environment for the Claude Code process: never an API key, so the subscription login is used. */
function sdkEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

const isoFromEpoch = (s: number | undefined) => (typeof s === "number" ? new Date(s * 1000).toISOString() : null);

function windowFromEvent(w: unknown): UsageWindow | null {
  if (!w || typeof w !== "object") return null;
  const o = w as { utilization?: number; resetsAt?: number };
  return { utilization: typeof o.utilization === "number" ? o.utilization : null, resetsAt: isoFromEpoch(o.resetsAt) };
}

/** Reads the plan's usage windows without a model call. Cached for a minute. */
export async function fetchSubscriptionStatus(maxAgeMs = 60_000): Promise<SubscriptionStatus> {
  const cur = lastSubscriptionStatus();
  if (cur && Date.now() - cur.updatedAt < maxAgeMs) return cur;
  if (!claudeLoginAvailable()) return { loggedIn: false, subscriptionType: null, status: null, fiveHour: null, sevenDay: null, updatedAt: Date.now() };
  const abort = new AbortController();
  // Streaming-input mode with a prompt that never yields: the CLI starts, answers control requests and makes no model call.
  const idle = (async function* (): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
  })();
  const q = query({ prompt: idle, options: { abortController: abort, tools: [], settingSources: [], persistSession: false, cwd: os.tmpdir(), env: sdkEnv() } });
  const timer = setTimeout(() => abort.abort(), 30_000);
  try {
    const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    const pct = (w: { utilization: number | null; resets_at: string | null } | null | undefined): UsageWindow | null =>
      w ? { utilization: typeof w.utilization === "number" ? w.utilization / 100 : null, resetsAt: w.resets_at } : null;
    remember({
      loggedIn: Boolean(u.subscription_type) || u.rate_limits_available,
      subscriptionType: u.subscription_type,
      fiveHour: pct(u.rate_limits?.five_hour),
      sevenDay: pct(u.rate_limits?.seven_day),
    });
  } catch {
    remember({});
  } finally {
    clearTimeout(timer);
    abort.abort();
    q.close();
  }
  return lastSubscriptionStatus()!;
}

/* ------------------------------ calibration ------------------------------ */

/**
 * How many points of the 5-hour window one USD of API-equivalent usage costs,
 * learnt from real sessions: the window's growth between calls divided by the
 * API-equivalent cost of those calls. Other Claude usage at the same time
 * inflates it, which errs on the safe side.
 */
interface Calibration {
  sessions: Record<string, { deltaPct: number; usd: number; lastUtil: number }>;
}
const CAL_KEY = "subscription_calibration";
/** Minimum observed growth (window points) before the ratio is trusted. */
const MIN_CAL_DELTA_PCT = 2;

export function recordSubscriptionCall(sessionId: string, util: { before: number | null; after: number | null }, usd: number | null) {
  if (util.after === null || usd === null) return;
  const cal = getKv<Calibration>(CAL_KEY, { sessions: {} });
  const e = (cal.sessions[sessionId] ??= { deltaPct: 0, usd: 0, lastUtil: util.before ?? util.after });
  if (util.after < e.lastUtil) {
    e.lastUtil = util.after; // the window was reset: start a new baseline
  } else {
    e.deltaPct += (util.after - e.lastUtil) * 100;
    e.usd += usd;
    e.lastUtil = util.after;
  }
  setKv(CAL_KEY, cal);
}

export function subscriptionCalibration(): { pctPerUsd: number | null; observedUsd: number; observedPct: number } {
  const cal = getKv<Calibration>(CAL_KEY, { sessions: {} });
  const rows = Object.values(cal.sessions);
  const pct = rows.reduce((a, r) => a + r.deltaPct, 0);
  const usd = rows.reduce((a, r) => a + r.usd, 0);
  return { pctPerUsd: pct >= MIN_CAL_DELTA_PCT && usd > 0 ? pct / usd : null, observedUsd: usd, observedPct: pct };
}

/** Pre-session view of the plan: current window usage and the expected share this session will take. */
export async function subscriptionEstimate(settings: AppSettings, est: PlanEstimate): Promise<SubscriptionEstimate> {
  const st = await fetchSubscriptionStatus();
  const cal = subscriptionCalibration();
  const pct = (w: UsageWindow | null) => (w?.utilization != null ? w.utilization * 100 : null);
  const used = pct(st.fiveHour);
  const estPct = cal.pctPerUsd !== null && est.estCostUsd !== null ? est.estCostUsd * cal.pctPerUsd : null;
  return {
    loggedIn: st.loggedIn,
    subscriptionType: st.subscriptionType,
    fiveHourUsedPct: used,
    fiveHourResetsAt: st.fiveHour?.resetsAt ?? null,
    sevenDayUsedPct: pct(st.sevenDay),
    sevenDayResetsAt: st.sevenDay?.resetsAt ?? null,
    stopAtPct: settings.subscriptionStopAtPct,
    estPctOfWindow: estPct,
    pctPerUsd: cal.pctPerUsd,
    observedPct: cal.observedPct,
    fitsInWindow: estPct !== null && used !== null ? used + estPct <= settings.subscriptionStopAtPct : null,
  };
}

/* -------------------------------- adapter -------------------------------- */

const toolResultText = (c: Anthropic.Beta.BetaToolResultBlockParam["content"]): string =>
  typeof c === "string" ? c : (c ?? []).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");

/** Replays the conversation so far as text blocks (the SDK only accepts user turns as input). */
function transcript(messages: MessageParam[]): Anthropic.Beta.BetaTextBlockParam[] {
  const names = new Map<string, string>();
  const out: string[] = [];
  messages.forEach((m, i) => {
    const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    for (const b of blocks) {
      if (b.type === "text") out.push(m.role === "user" ? (i === 0 ? b.text : `[MENSAJE DE LA APLICACIÓN]\n${b.text}`) : `[TU RESPUESTA ANTERIOR]\n${b.text}`);
      else if (b.type === "tool_use") {
        names.set(b.id, b.name);
        out.push(`[LLAMASTE A LA HERRAMIENTA ${b.name}]\n${JSON.stringify(b.input)}`);
      } else if (b.type === "tool_result") {
        out.push(`[RESULTADO DE ${names.get(b.tool_use_id) ?? "herramienta"}${b.is_error ? " — ERROR" : ""}]\n${toolResultText(b.content)}`);
      }
    }
  });
  if (messages.length > 1) out.splice(1, 0, "[HISTORIAL DE ESTA TAREA — continúa desde aquí llamando a una herramienta]");
  return out.map((text) => ({ type: "text" as const, text }));
}

function shapeFor(schema: unknown): z.ZodRawShape {
  try {
    const t = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
    if (t instanceof z.ZodObject) return t.shape;
  } catch {
    // fall through: an open object still lets the model call the tool; the orchestrator validates the input
  }
  return {};
}

export class ClaudeSubscriptionAdapter implements ModelAdapter {
  id = "claude-subscription";
  kind = "subscription" as const;

  async create(req: ModelRequest): Promise<ModelResponse> {
    // Only client tools are forwarded; server tools (web search) are API-only.
    const clientTools = req.tools.filter((t): t is Anthropic.Beta.BetaTool => "input_schema" in t);
    const server = createSdkMcpServer({
      name: MCP_SERVER,
      tools: clientTools.map((t) => ({
        name: t.name,
        description: t.description ?? t.name,
        inputSchema: shapeFor(t.input_schema),
        handler: async () => ({ content: [{ type: "text" as const, text: "La aplicación ejecuta esta herramienta." }] }),
      })),
    });
    const system = `${req.system}\n\nHerramientas: en este entorno cada herramienta X se invoca con el nombre ${MCP_PREFIX}X (por ejemplo ${MCP_PREFIX}${clientTools.at(-1)?.name ?? "submit"}). Responde siempre llamando a una herramienta.`;
    const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
      yield { type: "user", message: { role: "user", content: transcript(req.messages) }, parent_tool_use_id: null, session_id: "" } as SDKUserMessage;
    })();

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    const q = query({
      prompt,
      options: {
        abortController: abort,
        model: req.model,
        effort: req.effort,
        systemPrompt: system,
        tools: [],
        mcpServers: { [MCP_SERVER]: server },
        settingSources: [],
        persistSession: false,
        maxTurns: 1,
        cwd: os.tmpdir(),
        env: sdkEnv({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(req.maxTokens) }),
        // The orchestrator runs the tools itself: deny inside the SDK and stop the turn.
        canUseTool: async () => ({ behavior: "deny", message: "Ejecutada por la aplicación.", interrupt: true }),
      },
    });

    let firstId: string | null = null;
    const content: ContentBlock[] = [];
    let stop: string | null = null;
    let model = req.model;
    let requestId: string | null = null;
    let usage: ModelUsage | null = null;
    let before: number | null = null;
    let after: number | null = null;
    let error: string | null = null;
    let rejected: { msg: string; resetsAt: string | null } | null = null;
    try {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (m.type === "rate_limit_event") {
          const info = m.rate_limit_info as typeof m.rate_limit_info & { unifiedWindows?: { five_hour?: unknown; seven_day?: unknown } };
          const five = windowFromEvent(info.unifiedWindows?.five_hour);
          const seven = windowFromEvent(info.unifiedWindows?.seven_day);
          if (five?.utilization != null) {
            before ??= five.utilization;
            after = five.utilization;
          }
          remember({ status: info.status, ...(five ? { fiveHour: five } : {}), ...(seven ? { sevenDay: seven } : {}) });
          if (info.status === "rejected") rejected = { msg: "límite de uso de la suscripción de Claude alcanzado", resetsAt: isoFromEpoch(info.resetsAt) };
        } else if (m.type === "assistant" && m.parent_tool_use_id === null) {
          firstId ??= m.message.id;
          if (m.message.id !== firstId) continue; // only the first model turn counts
          model = m.message.model || model;
          requestId = m.request_id ?? requestId;
          stop = m.message.stop_reason ?? stop;
          usage = {
            input_tokens: m.message.usage.input_tokens ?? 0,
            output_tokens: m.message.usage.output_tokens ?? 0,
            cache_read_input_tokens: m.message.usage.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: m.message.usage.cache_creation_input_tokens ?? 0,
          };
          for (const b of m.message.content) {
            if (b.type === "text") content.push(b);
            else if (b.type === "tool_use") content.push({ ...b, name: b.name.startsWith(MCP_PREFIX) ? b.name.slice(MCP_PREFIX.length) : b.name });
          }
          if (m.error) error = `error del modelo (${m.error})`;
        } else if (m.type === "result") {
          if (m.subtype === "success" || m.subtype === "error_max_turns") {
            const u = m.usage;
            // The single-turn result carries the final usage (streamed assistant frames may report partial output tokens).
            usage = { input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0 };
          } else if (!content.length) {
            error ??= ("errors" in m && m.errors?.length ? m.errors.join("; ") : m.subtype) || "error desconocido";
          }
          break;
        }
      }
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
      q.close();
    }
    if (req.signal?.aborted) throw new Error("Llamada al modelo cancelada");
    // Plan limit reached: a controlled stop (the runner documents the outcome), not a task failure.
    if (rejected && !content.length) throw new SubscriptionLimitError(rejected.msg, rejected.resetsAt);
    if (error && !content.length) throw new Error(`Suscripción de Claude: ${error}`);
    const hasTool = content.some((b) => b.type === "tool_use");
    return {
      content,
      stopReason: hasTool ? "tool_use" : stop === "tool_use" ? "end_turn" : (stop ?? "end_turn"),
      usage: usage ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      model,
      requestId,
      windowUtilization: { before, after },
    };
  }
}
