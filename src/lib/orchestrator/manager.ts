import { getSession, getSettings, logError, resetTaskForRetry, transitionSession, updateSession } from "../db/repo";
import { AnthropicAdapter } from "../llm/anthropic";
import { ScriptedAdapter } from "../llm/scripted";
import type { ModelAdapter } from "../llm/adapter";
import { createMarketData } from "../market-data";
import { syntheticMarketData } from "../market-data/synthetic";
import { TERMINAL_STATUSES } from "../state";
import { prepareResume, runSession } from "./runner";

/** Dry-run adapter: any model call is a bug, so it fails loudly instead of spending money. */
class NoCallAdapter implements ModelAdapter {
  id = "dry-run";
  kind = "scripted" as const;
  async create(): Promise<never> {
    throw new Error("Análisis en seco: no se permiten llamadas al modelo");
  }
}

interface Running {
  promise: Promise<unknown>;
  abort: AbortController;
}

const g = globalThis as unknown as { __atlasRunning?: Map<string, Running> };
const running: Map<string, Running> = (g.__atlasRunning ??= new Map());

export function isRunning(id: string) {
  return running.has(id);
}

export class StartError extends Error {}

export function startSession(id: string): void {
  if (running.has(id)) return;
  const s = getSession(id);
  if (!s) throw new StartError("Sesión no encontrada");
  if (TERMINAL_STATUSES.includes(s.status)) return;
  let adapter: ModelAdapter;
  let md;
  if (s.mode === "demo") {
    adapter = new ScriptedAdapter();
    md = syntheticMarketData();
  } else if (s.mode === "dry_run") {
    adapter = new NoCallAdapter();
    md = createMarketData("dry_run", s.settings, { userPrices: s.config.userPrices });
  } else {
    if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new StartError("ANTHROPIC_API_KEY no está configurada en el servidor");
    adapter = new AnthropicAdapter({ refusalFallback: s.settings.refusalFallback });
    md = createMarketData("live", s.settings, { userPrices: s.config.userPrices });
  }
  const abort = new AbortController();
  const promise = runSession(id, { adapter, md, settings: s.settings, signal: abort.signal })
    .catch((e) => logError(id, { message: `Fallo del orquestador: ${e instanceof Error ? e.message : e}` }))
    .finally(() => running.delete(id));
  running.set(id, { promise, abort });
}

export function stopSession(id: string) {
  updateSession(id, { stopRequested: true });
  const r = running.get(id);
  r?.abort.abort();
  const s = getSession(id);
  // Not running (e.g. paused or interrupted): stop immediately.
  if (!r && s && !TERMINAL_STATUSES.includes(s.status)) transitionSession(id, "STOPPED_BY_USER", { convergence: "STOPPED_BY_USER" });
}

export function resumeSession(id: string) {
  if (running.has(id)) return;
  const s = getSession(id);
  if (!s || TERMINAL_STATUSES.includes(s.status)) throw new StartError("La sesión no se puede reanudar");
  if (s.mode === "live" && !process.env.ANTHROPIC_API_KEY?.trim()) throw new StartError("ANTHROPIC_API_KEY no está configurada en el servidor");
  prepareResume(id);
  startSession(id);
}

export function retryTask(id: string, taskKey: string) {
  resetTaskForRetry(id, taskKey);
  resumeSession(id);
}

export function abandonSession(id: string) {
  const s = getSession(id);
  if (!s || TERMINAL_STATUSES.includes(s.status)) return;
  running.get(id)?.abort.abort();
  transitionSession(id, "FAILED", { convergence: "FAILED", error: s.error ?? "Sesión abandonada por el usuario tras un error" });
}

export { getSettings };
