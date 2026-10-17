"use client";
import { useEffect, useState } from "react";
import { api, usePolling } from "./hooks";
import type { SessionView } from "./types";
import { Button, ErrorBox, Notice } from "./ui";
import { clock, until, useSubscription } from "./subscription";
import { isPaused, PHASE_ORDER } from "@/lib/state";
import { ROLE_LABELS } from "@/lib/types";

/**
 * Live session view: Server-Sent Events push a refresh whenever the stored
 * state changes; a slow poll remains as a fallback if SSE is unavailable.
 */
export function useSessionView(sid: string | null) {
  const [sseOk, setSseOk] = useState(false);
  const v = usePolling<SessionView>(sid ? `/api/sessions/${sid}` : null, (d) => d.session.running || d.session.queued || ["CREATED", "DISCOVERY"].includes(d.session.status), sseOk ? 20_000 : 2_500);
  const { refresh } = v;
  useEffect(() => {
    if (!sid || typeof EventSource === "undefined") return;
    const es = new EventSource(`/api/sessions/${sid}/events`);
    es.addEventListener("update", () => {
      setSseOk(true);
      refresh();
    });
    es.onerror = () => setSseOk(false);
    return () => es.close();
  }, [sid, refresh]);
  return v;
}

const PHASE_LABELS: Record<string, string> = {
  CREATED: "Creada",
  DISCOVERY: "Descubrimiento",
  ROUND_1_RUNNING: "R1 independiente",
  ROUND_1_COMPLETE: "R1 cerrada",
  CROSS_REVIEW: "R2A lectura cruzada",
  DEBATE: "R2B debate",
  VERIFICATION: "R2C verificación",
  REVISION: "R3 revisión",
  SELECTIVE_DEBATE: "R4 debate selectivo",
  FINAL_DECISION: "Decisión CIO",
  COMPLETED: "Completada",
};

export function PhaseBar({ v }: { v: SessionView }) {
  const st = isPaused(v.session.status) ? v.session.resumeStatus ?? "CREATED" : v.session.status;
  const idx = PHASE_ORDER.indexOf(st as (typeof PHASE_ORDER)[number]);
  return (
    <ol className="grid grid-cols-2 gap-1 sm:grid-cols-4 lg:grid-cols-11" aria-label="Fases">
      {PHASE_ORDER.map((p, i) => {
        const done = idx > i || v.session.status === "COMPLETED";
        const cur = idx === i && v.session.status !== "COMPLETED";
        return (
          <li key={p} aria-current={cur ? "step" : undefined} className={`rounded border px-2 py-1 text-[11px] ${done ? "border-good/40 bg-good/10 text-ink" : cur ? "border-accent bg-accent/15 font-semibold text-ink" : "border-line text-ink-3"}`}>
            {done ? "✓ " : cur ? "▶ " : ""}
            {PHASE_LABELS[p]}
          </li>
        );
      })}
    </ol>
  );
}

export function SessionActions({ v, onChange }: { v: SessionView; onChange: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = v.session;
  const act = async (action: string, taskKey?: string) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/sessions/${s.id}/action`, { method: "POST", body: JSON.stringify({ action, taskKey }) });
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const terminal = ["COMPLETED", "DRY_RUN_COMPLETE", "STOPPED_BY_USER", "STOPPED_BY_BUDGET", "FAILED"].includes(s.status);
  const failed = v.tasks.filter((t) => t.status === "FAILED");
  const limited = s.status === "PAUSED_LIMIT";
  return (
    <div className="space-y-3">
      {s.running && <Activity v={v} />}
      {limited && <LimitPausePanel v={v} busy={busy} act={act} />}
      {s.error && !limited && <ErrorBox>{s.error}</ErrorBox>}
      {s.queued && <Notice tone="accent">En cola: el proceso <code>npm run worker</code> ejecutará la sesión (modo ATLAS_RUNNER=worker). Si no hay ningún worker en marcha, arránquelo.</Notice>}
      {s.interrupted && !limited && <Notice tone="serious">La sesión se interrumpió (por ejemplo, al cerrar la aplicación). Puede reanudarla: las tareas ya completadas no se repiten.</Notice>}
      <div className="flex flex-wrap gap-2">
        {s.running && <Button variant="danger" disabled={busy} onClick={() => act("stop")}>Detener</Button>}
        {!s.running && !s.queued && !terminal && !limited && <Button variant="primary" disabled={busy} onClick={() => act("resume")}>Reanudar</Button>}
        {!s.running && limited && <Button variant="primary" disabled={busy} onClick={() => act("resume")}>Reanudar ahora</Button>}
        {!s.running && limited && <Button variant="danger" disabled={busy} onClick={() => act("stop")}>Detener definitivamente</Button>}
        {!s.running && s.status === "PAUSED_ERROR" && <Button variant="danger" disabled={busy} onClick={() => act("abandon")}>Abandonar (FAILED)</Button>}
        {!s.running && !terminal && !limited && s.status !== "PAUSED_ERROR" && <Button variant="danger" disabled={busy} onClick={() => act("stop")}>Detener</Button>}
      </div>
      {failed.length > 0 && !s.running && !terminal && (
        <div className="space-y-1">
          <div className="text-xs font-semibold text-ink-2">Tareas fallidas (se reintenta solo la tarea indicada):</div>
          {failed.map((t) => (
            <div key={t.taskKey} className="flex flex-wrap items-center gap-2 text-xs">
              <code className="num rounded bg-surface-2 px-1">{t.taskKey}</code>
              <span className="text-ink-2">{t.error}</span>
              <Button disabled={busy} onClick={() => act("retry", t.taskKey)}>Reintentar</Button>
            </div>
          ))}
        </div>
      )}
      {err && <ErrorBox>{err}</ErrorBox>}
    </div>
  );
}

/** What the session is doing right now: phase, tasks in flight and their last progress note. */
function Activity({ v }: { v: SessionView }) {
  const running = v.tasks.filter((t) => t.status === "RUNNING");
  const done = v.tasks.filter((t) => t.status === "SUCCEEDED").length;
  const calls = v.usage.totals.calls;
  return (
    <Notice tone="accent">
      <span className="block font-semibold">
        En ejecución · {PHASE_LABELS[v.session.status] ?? v.session.status} · {done}/{v.tasks.length} tareas completadas · {calls} llamadas al modelo
      </span>
      {running.length === 0 && <span className="block">Preparando la siguiente fase…</span>}
      {running.map((t) => (
        <span key={t.taskKey} className="block">
          ▸ {t.agentRole ? ROLE_LABELS[t.agentRole] : t.taskKey}
          {t.ticker ? ` · ${t.ticker}` : ""}: {t.progressNote ?? "esperando respuesta del modelo…"}
          {t.startedAt ? ` (desde ${clock(t.startedAt)})` : ""}
        </span>
      ))}
    </Notice>
  );
}

/** Paused by the Claude subscription limit: when it resumes, and the controls to change that. */
function LimitPausePanel({ v, busy, act }: { v: SessionView; busy: boolean; act: (a: string) => void }) {
  const p = v.session.limitPause;
  const sub = useSubscription(30_000);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const used = sub?.fiveHour?.utilization != null ? sub.fiveHour.utilization * 100 : null;
  const resetsAt = sub?.fiveHour?.resetsAt ?? p?.resetsAt ?? null;
  return (
    <Notice tone="warning">
      <span className="block font-semibold">Pausada: se alcanzó el tope de uso de su suscripción de Claude.</span>
      <span className="block">
        Todo lo hecho se conserva ({v.tasks.filter((t) => t.status === "SUCCEEDED").length} tareas completadas); al reanudar continúa desde {PHASE_LABELS[v.session.resumeStatus ?? ""] ?? "la fase interrumpida"} sin repetir trabajo.
      </span>
      <span className="block">
        Ventana de 5 h: {used === null ? "n/d" : `${used.toFixed(0)} %`} · se reinicia a las {clock(resetsAt)} ({until(resetsAt)}).
      </span>
      <span className="block">{v.session.error}</span>
      <label className="mt-1 flex items-center gap-2">
        <input type="checkbox" checked={Boolean(p?.autoResume)} disabled={busy} onChange={(e) => act(e.target.checked ? "autoresume_on" : "autoresume_off")} />
        Reanudar automáticamente cuando se reinicie la ventana (requiere la aplicación abierta en el servidor; no hace falta el navegador)
      </label>
    </Notice>
  );
}
