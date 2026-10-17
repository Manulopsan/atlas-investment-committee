"use client";
import { useEffect, useState } from "react";
import { api } from "./hooks";

interface Window {
  utilization: number | null;
  resetsAt: string | null;
}

export interface SubscriptionInfo {
  provider: "subscription" | "api";
  loggedIn?: boolean;
  subscriptionType?: string | null;
  status?: string | null;
  fiveHour?: Window | null;
  sevenDay?: Window | null;
  stopAtPct?: number;
}

export const clock = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }) : "—");

/** "en 1 h 12 min" / "ya" — time left until an ISO timestamp. */
export function until(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return "ya";
  const min = Math.ceil(ms / 60_000);
  return min >= 60 ? `en ${Math.floor(min / 60)} h ${min % 60} min` : `en ${min} min`;
}

/** Polls the plan's usage windows (no model call). */
export function useSubscription(intervalMs = 60_000) {
  const [info, setInfo] = useState<SubscriptionInfo | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api<SubscriptionInfo>("/api/subscription").then((r) => alive && setInfo(r)).catch(() => {});
    load();
    const t = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intervalMs]);
  return info;
}

/** Compact header meter: 5-hour window usage against the configured stop threshold. */
export function SubscriptionMeter() {
  const info = useSubscription();
  if (!info || info.provider !== "subscription") return null;
  if (!info.loggedIn) return <span className="text-xs text-serious">Claude: sin sesión</span>;
  const used = info.fiveHour?.utilization != null ? info.fiveHour.utilization * 100 : null;
  const stop = info.stopAtPct ?? 95;
  const tone = info.status === "rejected" || (used !== null && used >= stop) ? "bg-critical" : used !== null && used >= stop - 15 ? "bg-warning" : "bg-good";
  return (
    <div className="flex items-center gap-2 text-xs text-ink-2" title={`Ventana semanal: ${info.sevenDay?.utilization != null ? `${(info.sevenDay.utilization * 100).toFixed(0)} %` : "n/d"} · reinicio ${info.sevenDay?.resetsAt ? new Date(info.sevenDay.resetsAt).toLocaleString("es-ES") : "—"}`}>
      <span>Claude{info.subscriptionType ? ` ${info.subscriptionType}` : ""} · 5 h</span>
      <span className="relative h-2 w-20 overflow-hidden rounded bg-surface-2" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={used ?? undefined} aria-label="Uso de la ventana de 5 horas">
        <span className={`absolute inset-y-0 left-0 ${tone}`} style={{ width: `${Math.min(100, used ?? 0)}%` }} />
        <span className="absolute inset-y-0 w-px bg-ink-2" style={{ left: `${stop}%` }} aria-hidden />
      </span>
      <span className="num font-semibold text-ink">{used === null ? "n/d" : `${used.toFixed(0)} %`}</span>
      <span>reinicio {clock(info.fiveHour?.resetsAt)}</span>
    </div>
  );
}
