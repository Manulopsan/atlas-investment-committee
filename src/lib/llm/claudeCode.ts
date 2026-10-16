import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppSettings } from "../config";
import { insertUsage, setTaskProgress } from "../db/repo";
import { PROFILES } from "../agents/profiles";
import type { ModelAdapter, ModelRequest, ModelResponse, TaskRunSpec } from "./adapter";
import { BudgetExceededError, StopRequestedError } from "./cost";
import { usageTotals } from "../db/repo";

/**
 * Provider that runs each agent task through the local Claude Code CLI
 * (`claude -p`) signed in with the user's Claude subscription. There is no
 * per-token billing: usage counts against the plan's limits.
 *
 * Isolation: every task is a fresh, non-persisted Claude Code process with
 *  - our agent system prompt instead of Claude Code's,
 *  - ALL built-in tools disabled (--tools ""): no shell, no file access,
 *  - only the ATLAS MCP server (--strict-mcp-config) exposing the tools
 *    authorised for that task, and no user settings, hooks or CLAUDE.md,
 *  - ANTHROPIC_API_KEY removed from its environment so it never falls back to
 *    API billing.
 */
export const SUBSCRIPTION_BASIS = "SUSCRIPCIÓN Claude (Claude Code): sin coste por token; consume los límites de uso del plan. Importe = equivalente API orientativo";

export interface ClaudeCodeStatus {
  available: boolean;
  version: string | null;
  loggedIn: boolean;
  authMethod: string | null;
  usesApiKey: boolean;
  error: string | null;
}

/** Environment for the CLI: never pass an API key, so the subscription login is used. */
export function subscriptionEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_CHILD_SESSION;
  return env;
}

export function claudeCodeStatus(bin = "claude"): ClaudeCodeStatus {
  const base: ClaudeCodeStatus = { available: false, version: null, loggedIn: false, authMethod: null, usesApiKey: false, error: null };
  const v = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000, env: subscriptionEnv() });
  if (v.error || v.status !== 0) return { ...base, error: `No se encontró Claude Code (${bin}). Instálelo: npm install -g @anthropic-ai/claude-code` };
  const a = spawnSync(bin, ["auth", "status", "--json"], { encoding: "utf8", timeout: 20_000, env: subscriptionEnv() });
  try {
    const j = JSON.parse(a.stdout || "{}") as { loggedIn?: boolean; authMethod?: string };
    const method = j.authMethod ?? null;
    const usesApiKey = Boolean(method && /api[_-]?key/i.test(method));
    return { ...base, available: true, version: v.stdout.trim(), loggedIn: Boolean(j.loggedIn), authMethod: method, usesApiKey, error: j.loggedIn ? (usesApiKey ? "Claude Code está autenticado con una API key, no con la suscripción: ejecute `claude auth login`." : null) : "Claude Code no tiene sesión iniciada: ejecute `claude auth login` (o `claude setup-token`)." };
  } catch {
    return { ...base, available: true, version: v.stdout.trim(), error: "No se pudo leer el estado de autenticación de Claude Code" };
  }
}

interface CliResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, unknown>;
}

/** Turn budget (subscription mode has no money budget; the call limit counts model turns). */
export function checkTurnBudget(sessionId: string, settings: AppSettings, turns: number, isFinal: boolean) {
  const L = settings.limits;
  const used = usageTotals(sessionId).calls;
  const reserve = isFinal ? 0 : 4; // the CIO final decision may need up to 4 turns
  if (used + turns > L.maxCallsPerSession - reserve) {
    throw new BudgetExceededError(`límite de turnos del modelo (${used} usados, ${turns} más previstos, máximo ${L.maxCallsPerSession}${reserve ? `, ${reserve} reservados para el veredicto del CIO` : ""})`);
  }
}

export class ClaudeCodeAdapter implements ModelAdapter {
  id = "claude-code";
  kind = "claude_code" as const;
  constructor(private settings: AppSettings, private appDir = process.cwd()) {}

  async create(_req: ModelRequest): Promise<ModelResponse> {
    throw new Error("ClaudeCodeAdapter ejecuta tareas completas (runTask), no llamadas sueltas");
  }

  async runTask(spec: TaskRunSpec, ctx: { signal?: AbortSignal; isStopRequested: () => boolean }) {
    if (ctx.isStopRequested()) throw new StopRequestedError();
    const maxTurns = spec.maxIterations + 2;
    checkTurnBudget(spec.sessionId, this.settings, maxTurns, Boolean(spec.isFinal));

    const work = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-cc-"));
    const outputFile = path.join(work, "output.json");
    const ctxFile = path.join(work, "task.json");
    const mcpFile = path.join(work, "mcp.json");
    fs.writeFileSync(ctxFile, JSON.stringify({ sessionId: spec.sessionId, taskKey: spec.taskKey, role: spec.role, phase: spec.phase, round1: Boolean(spec.round1), dataTools: spec.dataTools, submitName: spec.submit.name, submitDescription: spec.submit.description, outputFile }), { mode: 0o600 });
    const tsx = path.join(this.appDir, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
    const dbPath = process.env.ATLAS_DB_PATH?.trim() || path.join(this.appDir, "data", "atlas.db");
    fs.writeFileSync(
      mcpFile,
      JSON.stringify({
        mcpServers: {
          atlas: {
            type: "stdio",
            command: tsx,
            args: [path.join(this.appDir, "scripts", "mcp-atlas.ts")],
            env: { ATLAS_MCP_CONTEXT_FILE: ctxFile, ATLAS_APP_DIR: this.appDir, ATLAS_DB_PATH: dbPath },
          },
        },
      }),
      { mode: 0o600 },
    );
    const allowed = [...spec.dataTools, spec.submit.name].map((t) => `mcp__atlas__${t}`).concat(this.settings.enableWebSearch ? ["WebSearch", "WebFetch"] : []);
    const system = `${PROFILES[spec.role].system}\n\nHERRAMIENTAS: solo dispones de las herramientas del servidor "atlas". Entrega tu resultado llamando a mcp__atlas__${spec.submit.name}; el texto libre no se guarda. No tienes acceso a ficheros, terminal ni Internet salvo a través de esas herramientas.`;
    const args = [
      "-p",
      "--output-format", "json",
      "--model", spec.model,
      "--system-prompt", system,
      // No built-in tools (no shell or file access). Optional web tools only if enabled in Settings.
      "--tools", this.settings.enableWebSearch ? "WebSearch,WebFetch" : "",
      "--mcp-config", mcpFile,
      "--strict-mcp-config",
      "--allowedTools", allowed.join(","),
      "--permission-mode", "dontAsk",
      "--max-turns", String(maxTurns),
      "--no-session-persistence",
      "--setting-sources", "",
    ];

    setTaskProgress(spec.sessionId, spec.taskKey, `Claude Code (suscripción) · ${spec.model} · máx. ${maxTurns} turnos`);
    const started = Date.now();
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string; killed: string | null }>((resolve) => {
      const child = spawn(this.settings.claudeCodePath, args, { cwd: work, env: subscriptionEnv(), stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let killed: string | null = null;
      const kill = (why: string) => {
        if (killed) return;
        killed = why;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      };
      const timer = setTimeout(() => kill("timeout"), this.settings.taskTimeoutMinutes * 60_000);
      const stopPoll = setInterval(() => ctx.isStopRequested() && kill("stop"), 2_000);
      ctx.signal?.addEventListener("abort", () => kill("stop"));
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (e) => {
        stderr += String(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        clearInterval(stopPoll);
        resolve({ code, stdout, stderr, killed });
      });
      child.stdin.end(spec.prompt);
    });

    let parsed: CliResult | null = null;
    try {
      parsed = JSON.parse(result.stdout.trim().split("\n").pop() || "null") as CliResult;
    } catch {
      parsed = null;
    }
    const u = parsed?.usage ?? {};
    insertUsage(spec.sessionId, {
      taskKey: spec.taskKey,
      ticker: spec.ticker ?? null,
      inputEstimateBasis: "Claude Code (bucle interno)",
      agentRole: spec.role,
      phase: spec.phase,
      model: spec.model,
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      estCostUsd: typeof parsed?.total_cost_usd === "number" ? parsed.total_cost_usd : null,
      costBasis: SUBSCRIPTION_BASIS,
      stopReason: parsed?.subtype ?? (result.killed ? `killed:${result.killed}` : `exit:${result.code}`),
      requestId: null,
      turns: parsed?.num_turns ?? 1,
    });

    const output = fs.existsSync(outputFile) ? JSON.parse(fs.readFileSync(outputFile, "utf8")) : null;
    fs.rmSync(work, { recursive: true, force: true });
    if (result.killed === "stop") throw new StopRequestedError();
    if (output !== null) return { output, model: spec.model, iterations: parsed?.num_turns ?? 1 };
    const detail = (parsed?.result ?? result.stderr).toString().replace(/\s+/g, " ").slice(0, 400);
    if (result.killed === "timeout") throw Object.assign(new Error(`Claude Code superó el tiempo máximo (${this.settings.taskTimeoutMinutes} min) sin entregar resultado`), { name: "AgentOutputError" });
    if (/usage limit|rate limit|limit reached|5-hour|weekly/i.test(detail)) {
      // Not a budget stop: the session pauses and can be resumed when the plan's limit resets.
      throw Object.assign(new Error(`Límite de uso de su suscripción alcanzado: reanude la sesión cuando se restablezca (${detail})`), { name: "UsageLimitError" });
    }
    if (/not logged in|login|authenticat|invalid api key|oauth/i.test(detail)) throw new Error(`Claude Code no está autenticado: ejecute \`claude auth login\`. Detalle: ${detail}`);
    const secs = Math.round((Date.now() - started) / 1000);
    throw Object.assign(new Error(`El agente ${spec.role} terminó sin entregar ${spec.submit.name} (${parsed?.subtype ?? `código ${result.code}`}, ${parsed?.num_turns ?? "?"} turnos, ${secs}s): ${detail}`), { name: "AgentOutputError" });
  }
}
