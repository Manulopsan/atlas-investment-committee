"use client";
import { useEffect, useState } from "react";
import { api, usePolling } from "./hooks";
import type { SessionView } from "./types";
import { Button, ErrorBox, Notice } from "./ui";
import { PHASE_ORDER } from "@/lib/state";

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
  const st = v.session.status === "PAUSED_ERROR" ? v.session.resumeStatus ?? "CREATED" : v.session.status;
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
  return (
    <div className="space-y-3">
      {s.error && <ErrorBox>{s.error}</ErrorBox>}
      {s.queued && <Notice tone="accent">En cola: el proceso <code>npm run worker</code> ejecutará la sesión (modo ATLAS_RUNNER=worker). Si no hay ningún worker en marcha, arránquelo.</Notice>}
      {s.interrupted && <Notice tone="serious">La sesión se interrumpió (por ejemplo, al cerrar la aplicación). Puede reanudarla: las tareas ya completadas no se repiten.</Notice>}
      <div className="flex flex-wrap gap-2">
        {s.running && <Button variant="danger" disabled={busy} onClick={() => act("stop")}>Detener</Button>}
        {!s.running && !s.queued && !terminal && <Button variant="primary" disabled={busy} onClick={() => act("resume")}>Reanudar</Button>}
        {!s.running && s.status === "PAUSED_ERROR" && <Button variant="danger" disabled={busy} onClick={() => act("abandon")}>Abandonar (FAILED)</Button>}
        {!s.running && !terminal && s.status !== "PAUSED_ERROR" && <Button variant="danger" disabled={busy} onClick={() => act("stop")}>Detener</Button>}
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
