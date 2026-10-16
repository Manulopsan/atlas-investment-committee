import os from "node:os";
import {
  acquireLease,
  getSession,
  leaseActive,
  logError,
  releaseLease,
  renewLease,
  requestRun,
  resetTaskForRetry,
  transitionSession,
  updateSession,
  type SessionRow,
} from "../db/repo";
import { AnthropicAdapter } from "../llm/anthropic";
import { ScriptedAdapter } from "../llm/scripted";
import type { ModelAdapter } from "../llm/adapter";
import { createMarketData } from "../market-data";
import { syntheticMarketData } from "../market-data/synthetic";
import { TERMINAL_STATUSES } from "../state";
import { prepareResume, runSession, type RunnerDeps } from "./runner";

/**
 * Session execution.
 * - ATLAS_RUNNER=inprocess (default): the web server runs sessions itself.
 * - ATLAS_RUNNER=worker: the web server only enqueues; `npm run worker`
 *   executes them in a separate process, so a web restart does not interrupt
 *   a paid session, and a crashed worker's session is picked up again when its
 *   lease expires (completed tasks are never repeated).
 * Either way a session is run by exactly one holder of a DB lease.
 */
export const LEASE_MS = 30_000;
export const runnerMode = (): "inprocess" | "worker" => (process.env.ATLAS_RUNNER?.trim() === "worker" ? "worker" : "inprocess");

/** Dry-run adapter: any model call is a bug, so it fails loudly instead of spending money. */
class NoCallAdapter implements ModelAdapter {
  id = "dry-run";
  kind = "scripted" as const;
  async create(): Promise<never> {
    throw new Error("Análisis en seco: no se permiten llamadas al modelo");
  }
}

export class StartError extends Error {}

export function buildDeps(s: SessionRow, signal?: AbortSignal): RunnerDeps {
  if (s.mode === "demo") return { adapter: new ScriptedAdapter(), md: { ...syntheticMarketData(), asOf: s.config.asOfDate ?? null }, settings: s.settings, signal };
  const md = createMarketData(s.mode, s.settings, { userPrices: s.config.userPrices });
  if (s.mode === "dry_run") return { adapter: new NoCallAdapter(), md, settings: s.settings, signal };
  if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new StartError("ANTHROPIC_API_KEY no está configurada en el servidor");
  return { adapter: new AnthropicAdapter({ refusalFallback: s.settings.refusalFallback }), md, settings: s.settings, signal };
}

const g = globalThis as unknown as { __atlasLocal?: Map<string, Promise<unknown>> };
const local: Map<string, Promise<unknown>> = (g.__atlasLocal ??= new Map());

export function ownerId(kind: string) {
  return `${kind}:${os.hostname()}:${process.pid}`;
}

/** Runs a session while holding (and renewing) its lease. Returns false if another runner holds it. */
export async function runWithLease(id: string, owner: string): Promise<boolean> {
  if (!acquireLease(id, owner, LEASE_MS)) return false;
  const abort = new AbortController();
  const heartbeat = setInterval(() => {
    if (!renewLease(id, owner, LEASE_MS)) abort.abort();
    // Stop requests may come from another process: abort the in-flight model call.
    if (getSession(id)?.stopRequested) abort.abort();
  }, 2_000);
  try {
    const s = getSession(id)!;
    await runSession(id, buildDeps(s, abort.signal));
  } catch (e) {
    logError(id, { message: `Fallo del orquestador: ${e instanceof Error ? e.message : e}` });
  } finally {
    clearInterval(heartbeat);
    requestRun(id, false);
    releaseLease(id, owner);
  }
  return true;
}

export function isRunning(id: string) {
  const s = getSession(id);
  return Boolean(s && leaseActive(s));
}

export function startSession(id: string): void {
  const s = getSession(id);
  if (!s) throw new StartError("Sesión no encontrada");
  if (TERMINAL_STATUSES.includes(s.status)) return;
  if (s.mode === "live" && !process.env.ANTHROPIC_API_KEY?.trim() && runnerMode() === "inprocess") throw new StartError("ANTHROPIC_API_KEY no está configurada en el servidor");
  requestRun(id, true);
  if (runnerMode() === "worker" || local.has(id)) return; // the worker picks it up
  const p = runWithLease(id, ownerId("web")).finally(() => local.delete(id));
  local.set(id, p);
}

export function stopSession(id: string) {
  updateSession(id, { stopRequested: true });
  const s = getSession(id);
  // Nobody is running it (paused, interrupted or queued): stop immediately.
  if (s && !leaseActive(s) && !TERMINAL_STATUSES.includes(s.status)) {
    requestRun(id, false);
    transitionSession(id, "STOPPED_BY_USER", { convergence: "STOPPED_BY_USER" });
  }
}

export function resumeSession(id: string) {
  const s = getSession(id);
  if (!s || TERMINAL_STATUSES.includes(s.status)) throw new StartError("La sesión no se puede reanudar");
  if (leaseActive(s)) return;
  if (s.mode === "live" && !process.env.ANTHROPIC_API_KEY?.trim() && runnerMode() === "inprocess") throw new StartError("ANTHROPIC_API_KEY no está configurada en el servidor");
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
  if (leaseActive(s)) throw new StartError("Detenga la sesión antes de abandonarla");
  requestRun(id, false);
  transitionSession(id, "FAILED", { convergence: "FAILED", error: s.error ?? "Sesión abandonada por el usuario tras un error" });
}

/** Display state shared by the API views. */
export function runState(s: SessionRow) {
  const running = leaseActive(s);
  const terminal = TERMINAL_STATUSES.includes(s.status) || s.status === "PAUSED_ERROR";
  const queued = !running && !terminal && s.runRequested && runnerMode() === "worker";
  return { running, queued, interrupted: !running && !terminal && !queued, runner: runnerMode() };
}
