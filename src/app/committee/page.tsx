"use client";
import { Suspense, useMemo, useState } from "react";
import { useSelectedSession } from "@/components/hooks";
import { PhaseBar, SessionActions, useSessionView } from "@/components/session";
import { AgentChip, Badge, Card, Empty, ErrorBox, fmt, StatusBadge } from "@/components/ui";
import { ScoreEvolution } from "@/components/charts";
import { opinionChanges, scoreHistory, tickersOf } from "@/components/derive";
import { PROFILES } from "@/lib/agents/profiles";
import { AGENT_ROLES, ROLE_LABELS } from "@/lib/types";
import type { StoredReport } from "@/lib/agents/schemas";

function Committee() {
  const [sid] = useSelectedSession();
  const { data: v, error, refresh } = useSessionView(sid);
  const tickers = useMemo(() => (v ? tickersOf(v) : []), [v]);
  const [ticker, setTicker] = useState<string>("");
  const t = ticker || tickers[0] || "";
  if (!sid) return <Empty title="Seleccione o inicie una sesión">El Committee Room muestra el estado real de cada agente a partir de las tareas registradas.</Empty>;
  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!v) return <p className="text-sm text-ink-2">Cargando…</p>;
  const usageBy = v.usage.byAgent as Record<string, { calls: number; estCostUsd: number }>;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Committee Room</h1>
        <StatusBadge status={v.session.status} />
      </div>
      <PhaseBar v={v} />
      <SessionActions v={v} onChange={refresh} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {AGENT_ROLES.map((role) => {
          const tasks = v.tasks.filter((x) => x.agentRole === role);
          const running = tasks.find((x) => x.status === "RUNNING");
          const failed = tasks.filter((x) => x.status === "FAILED");
          const last = [...v.messages].reverse().find((m) => m.fromRole === role);
          const latest = v.reports.filter((r) => r.agentRole === role).pop();
          const initial = v.reports.find((r) => r.agentRole === role && r.version === 1);
          const changes = opinionChanges(v, role).filter((c) => c.from !== null && c.from !== c.to);
          const r1 = tasks.find((x) => x.taskKey === `r1:${role}`);
          return (
            <section key={role} className="rounded-lg border border-line bg-surface-1" style={{ borderTop: `3px solid ${PROFILES[role].color}` }}>
              <header className="border-b border-line px-4 py-2.5">
                <AgentChip role={role} />
                <div className="text-xs text-ink-2">{PROFILES[role].mission}</div>
              </header>
              <div className="space-y-2.5 p-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-ink-3">Estado</span>
                  {running ? <Badge tone="accent">trabajando · {running.phase}</Badge> : failed.length ? <Badge tone="critical">{failed.length} tarea(s) fallida(s)</Badge> : tasks.length ? <Badge tone="good">en espera</Badge> : <Badge>sin tareas</Badge>}
                </div>
                {running && (
                  <div className="text-xs text-ink-2">
                    {running.ticker && <span className="font-semibold">{running.ticker} · </span>}
                    {running.progressNote ?? "Esperando respuesta del modelo…"}
                  </div>
                )}
                <div className="text-xs text-ink-2">
                  Ronda 1: {r1 ? <StatusBadge status={r1.status} /> : "—"} {initial?.frozen && <Badge tone="neutral">informe congelado</Badge>}
                </div>
                <div className="text-xs text-ink-2">Versiones del informe: {v.reports.filter((r) => r.agentRole === role).map((r) => `v${r.version}`).join(", ") || "—"}</div>
                {latest && t && (
                  <div className="text-xs">
                    Puntuación actual {t}: <span className="num font-semibold text-ink">{fmt.num(latest.kind === "INITIAL" ? (latest.content as StoredReport).totals?.[t] : (latest.content as { companies: { ticker: string; revised_total: number }[] }).companies.find((c) => c.ticker === t)?.revised_total)}</span>
                    {role === "RISK" && <span className="text-ink-3"> (alto = más riesgo)</span>}
                  </div>
                )}
                <div className="text-xs">
                  <div className="text-ink-3">Último mensaje</div>
                  {last ? <p className="line-clamp-4 text-ink">{last.ticker && <b>{last.ticker}: </b>}[{last.type}] {last.claim}</p> : <p className="text-ink-3">Sin mensajes (en la ronda 1 los agentes no se comunican).</p>}
                </div>
                <div className="text-xs">
                  <div className="text-ink-3">Cambios de opinión</div>
                  {changes.length ? (
                    <ul className="space-y-0.5">
                      {changes.slice(0, 5).map((c, i) => (
                        <li key={i}><b>{c.ticker}</b> <span className="num">{fmt.num(c.from)} → {fmt.num(c.to)}</span> ({c.stage}) <span className="text-ink-2">{c.reason}</span></li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-ink-3">Ninguno registrado.</p>
                  )}
                </div>
                <div className="num text-[11px] text-ink-3">{usageBy[role]?.calls ?? 0} llamadas · {(usageBy[role]?.estCostUsd ?? 0).toFixed(3)} $ (estimado)</div>
              </div>
            </section>
          );
        })}
      </div>
      <Card title="Evolución de puntuaciones" actions={tickers.length > 0 && (
        <select value={t} onChange={(e) => setTicker(e.target.value)} className="rounded-md border border-line bg-surface-1 px-2 py-1 text-xs" aria-label="Empresa">
          {tickers.map((x) => <option key={x}>{x}</option>)}
        </select>
      )}>
        {t ? <ScoreEvolution data={scoreHistory(v.reports, t)} /> : <p className="text-sm text-ink-2">Aún no hay informes.</p>}
        <p className="mt-2 text-xs text-ink-3">Escalas 0–100. {ROLE_LABELS.CIO}: puntuación preliminar ponderada de la ronda 1.</p>
      </Card>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Committee />
    </Suspense>
  );
}
