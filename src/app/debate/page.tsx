"use client";
import { Suspense, useMemo, useState } from "react";
import { useSelectedSession } from "@/components/hooks";
import { useSessionView } from "@/components/session";
import { AgentChip, Badge, Empty, ErrorBox, fmt, SessionLink, StatusBadge } from "@/components/ui";
import { AGENT_ROLES, MESSAGE_TYPES, ROLE_LABELS } from "@/lib/types";

const TYPE_LABEL: Record<string, string> = { ARGUMENT: "Argumento", OBJECTION: "Objeción", RESPONSE: "Respuesta", EVIDENCE_REQUEST: "Petición de evidencia", REVISION: "Revisión" };

function Debate() {
  const [sid] = useSelectedSession();
  const { data: v, error } = useSessionView(sid);
  const [role, setRole] = useState("");
  const [ticker, setTicker] = useState("");
  const [round, setRound] = useState("");
  const [type, setType] = useState("");
  const tickers = useMemo(() => Array.from(new Set((v?.messages ?? []).map((m) => m.ticker).filter(Boolean))) as string[], [v]);
  if (!sid) return <Empty title="Seleccione una sesión">La línea temporal muestra solo mensajes realmente generados y guardados por el orquestador.</Empty>;
  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!v) return <p className="text-sm text-ink-2">Cargando…</p>;
  const msgs = v.messages.filter((m) => (!role || m.fromRole === role || m.toRole === role) && (!ticker || m.ticker === ticker) && (!round || String(m.round) === round) && (!type || m.type === type));
  const issuesByMsg = new Map(v.issues.filter((i) => i.sourceMessageId).map((i) => [i.sourceMessageId!, i]));
  const sel = "rounded-md border border-line bg-surface-1 px-2 py-1 text-xs";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Debate en directo</h1>
        <span className="text-xs text-ink-2">{v.messages.length} mensajes · {v.issues.length} incidencias</span>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filtros">
        <select className={sel} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Agente"><option value="">Todos los agentes</option>{AGENT_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select>
        <select className={sel} value={ticker} onChange={(e) => setTicker(e.target.value)} aria-label="Ticker"><option value="">Todos los tickers</option>{tickers.map((t) => <option key={t}>{t}</option>)}</select>
        <select className={sel} value={round} onChange={(e) => setRound(e.target.value)} aria-label="Ronda"><option value="">Todas las rondas</option>{[2, 3, 4].map((r) => <option key={r} value={r}>Ronda {r}</option>)}</select>
        <select className={sel} value={type} onChange={(e) => setType(e.target.value)} aria-label="Tipo"><option value="">Todos los tipos</option>{MESSAGE_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select>
      </div>
      {v.messages.length === 0 && <Empty title="Todavía no hay mensajes">El debate comienza cuando los cuatro informes de la ronda 1 están completos y congelados. Durante la ronda 1 los agentes trabajan aislados.</Empty>}
      <ol className="space-y-2">
        {msgs.map((m) => {
          const issue = issuesByMsg.get(m.id);
          return (
            <li key={m.id} id={`m${m.id}`} className="rounded-lg border border-line bg-surface-1 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="num text-ink-3">#{m.id}</span>
                <AgentChip role={m.fromRole} />
                <span className="text-ink-3">→</span>
                <AgentChip role={m.toRole} />
                <Badge tone={m.type === "OBJECTION" ? "serious" : m.type === "RESPONSE" ? "good" : m.type === "EVIDENCE_REQUEST" ? "warning" : m.type === "REVISION" ? "accent" : "neutral"}>{TYPE_LABEL[m.type]}</Badge>
                {m.ticker && <SessionLink href={`/company/${m.ticker}`} s={sid} className="font-semibold">{m.ticker}</SessionLink>}
                <span className="text-ink-3">Ronda {m.round} · {m.phase}</span>
                {m.inReplyTo && <a href={`#m${m.inReplyTo}`} className="text-accent hover:underline">responde a #{m.inReplyTo}</a>}
                <span className="ml-auto text-ink-3">{fmt.date(m.createdAt)}</span>
              </div>
              <p className="mt-1.5 text-sm text-ink">{m.claim}</p>
              <dl className="mt-1.5 grid gap-x-4 gap-y-0.5 text-xs text-ink-2 sm:grid-cols-[auto_1fr]">
                {(m.evidenceText || m.evidenceIds.length > 0) && (<><dt className="text-ink-3">Evidencia</dt><dd>{m.evidenceText} {m.evidenceIds.length > 0 && <span className="num">[{m.evidenceIds.join(", ")}]</span>}</dd></>)}
                {m.question && (<><dt className="text-ink-3">Pregunta</dt><dd>{m.question}</dd></>)}
                {m.expectedOutcome && (<><dt className="text-ink-3">Resultado esperado</dt><dd>{m.expectedOutcome}</dd></>)}
              </dl>
              {issue && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-line bg-surface-2 px-2 py-1 text-xs">
                  Incidencia #{issue.id} <StatusBadge status={issue.status} /> {issue.critical && <Badge tone="critical">crítica</Badge>} {issue.title}
                  {issue.resolution && <span className="text-ink-2">→ {issue.resolution}</span>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Debate />
    </Suspense>
  );
}
