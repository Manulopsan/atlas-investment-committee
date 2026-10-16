"use client";
import { Suspense, useState } from "react";
import { useSelectedSession } from "@/components/hooks";
import { useSessionView } from "@/components/session";
import { AgentChip, Badge, Card, Empty, ErrorBox, fmt, SessionLink, StatusBadge, Td, Th, VerificationBadge } from "@/components/ui";
import { stageOf, totalIn } from "@/components/derive";
import type { StoredReport, StoredRevision } from "@/lib/agents/schemas";
import { PROFILES } from "@/lib/agents/profiles";
import { AGENT_ROLES, ROLE_LABELS } from "@/lib/types";
import type { SessionView } from "@/components/types";
import type { Reconciliation } from "@/lib/evidence/reconcile";

function ReconBadge({ r }: { r?: Reconciliation }) {
  if (!r || (!r.matched.length && !r.unmatched.length)) return null;
  return (
    <details className="mt-1 text-[11px]">
      <summary className="cursor-pointer">
        Cifras en texto: <Badge tone="good">{r.matched.length} conciliadas</Badge> {r.unmatched.length > 0 && <Badge tone="warning">{r.unmatched.length} sin conciliar</Badge>}
      </summary>
      {r.matched.map((m, i) => <div key={`m${i}`} className="text-ink-2">✓ {m.raw} = {m.metric} [{m.evidenceId}]{m.verified ? "" : " (evidencia no verificada)"}</div>)}
      {r.unmatched.map((u, i) => <div key={`u${i}`} className="text-ink-2">! {u.raw} — {u.note}</div>)}
    </details>
  );
}

const TABS = ["Candidatas", "Informes iniciales", "Revisiones", "Evidencias", "Incidencias", "Historial de puntuaciones", "Exportar"] as const;

function InitialReports({ v, sid }: { v: SessionView; sid: string }) {
  const initial = v.reports.filter((r) => r.kind === "INITIAL");
  if (!initial.length) return <Empty title="Sin informes iniciales">Los informes aparecen cuando cada agente entrega y la aplicación valida su análisis. Ningún informe parcial se muestra como definitivo.</Empty>;
  return (
    <div className="space-y-4">
      {AGENT_ROLES.map((role) => {
        const r = initial.find((x) => x.agentRole === role);
        if (!r) return <Card key={role} title={ROLE_LABELS[role]}><p className="text-sm text-ink-2">Pendiente.</p></Card>;
        const c = r.content as StoredReport;
        return (
          <Card key={role} title={<AgentChip role={role} />} actions={<div className="flex gap-2">{r.frozen ? <Badge tone="neutral">congelado (inmutable)</Badge> : <Badge tone="warning">pendiente de cierre de ronda</Badge>}<span className="text-xs text-ink-3">{fmt.date(c.generated_at)} · {c.model}</span></div>}>
            <p className="text-sm">{c.executive_summary}</p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead><tr><Th>Ticker</Th><Th>Puntuación</Th><Th>Tesis</Th><Th>Métricas (evidencia)</Th><Th>Conclusión</Th></tr></thead>
                <tbody>
                  {c.companies.map((co) => (
                    <tr key={co.ticker}>
                      <Td><SessionLink href={`/company/${co.ticker}`} s={sid}>{co.ticker}</SessionLink></Td>
                      <Td className="num">{fmt.num(c.totals[co.ticker])}{role === "RISK" && <div className="text-[10px] text-ink-3">alto = peor</div>}</Td>
                      <Td className="max-w-sm text-xs">{co.thesis}</Td>
                      <Td className="text-xs">
                        {co.metrics.slice(0, 6).map((m, i) => (
                          <div key={i}>{m.name} {m.value ?? ""} {m.unit} {m.period} {m.evidence_id ? <span className="num text-ink-2">[{m.evidence_id}]</span> : <Badge tone="warning">no verificado</Badge>}</div>
                        ))}
                        <div className="text-ink-3">citas verificadas: {c.citation_check[co.ticker]?.verified.length ?? 0}, sin verificar: {c.citation_check[co.ticker]?.unverified.length ?? 0}, inexistentes: {c.citation_check[co.ticker]?.missing.length ?? 0}</div>
                        <ReconBadge r={c.reconciliation?.[co.ticker]} />
                      </Td>
                      <Td className="max-w-xs text-xs">{co.provisional_conclusion}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {c.vetoes && c.vetoes.length > 0 && <div className="mt-2 text-xs"><b>Vetos:</b> {c.vetoes.map((x) => `${x.ticker} [${x.severity}] ${x.reason}`).join(" · ")}</div>}
            {c.critical_questions && <div className="mt-2 text-xs"><b>Cuestiones críticas:</b> {c.critical_questions.join(" · ")}</div>}
            {c.uncertainties.length > 0 && <div className="mt-2 text-xs text-ink-2"><b>Incertidumbres:</b> {c.uncertainties.join(" · ")}</div>}
            <div className="mt-2 text-xs text-ink-2"><b>Conclusiones provisionales:</b> {c.provisional_conclusions}</div>
          </Card>
        );
      })}
    </div>
  );
}

function Revisions({ v }: { v: SessionView }) {
  const revs = v.reports.filter((r) => r.kind === "REVISION");
  if (!revs.length) return <Empty title="Sin revisiones todavía">Las revisiones se guardan como versiones nuevas tras el debate; los informes iniciales nunca se sobrescriben.</Empty>;
  return (
    <div className="space-y-4">
      {revs.map((r) => {
        const c = r.content as StoredRevision;
        return (
          <Card key={r.id} title={<span className="flex items-center gap-2"><AgentChip role={r.agentRole} /> <span className="text-ink-3">v{r.version} · ronda {c.round}</span></span>}>
            <p className="mb-2 text-sm">{c.executive_summary}</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px]">
                <thead><tr><Th>Ticker</Th><Th>Original → revisada</Th><Th>Conclusión original / revisada</Th><Th>Aceptados</Th><Th>Rechazados</Th><Th>Datos nuevos</Th><Th>Sin resolver</Th></tr></thead>
                <tbody>
                  {c.companies.map((co) => (
                    <tr key={co.ticker}>
                      <Td>{co.ticker}</Td>
                      <Td className="num">{fmt.num(co.original_total)} → {fmt.num(co.revised_total)}<div className="text-[11px] text-ink-2">{co.change_reason}</div><ReconBadge r={co.reconciliation} /></Td>
                      <Td className="text-xs"><div className="text-ink-3">{co.original_conclusion ?? "—"}</div><div>{co.revised_conclusion}</div></Td>
                      <Td className="text-xs">{co.accepted_arguments.map((a, i) => <div key={i}>{a.message_id ? `#${a.message_id} ` : ""}{a.summary}</div>)}</Td>
                      <Td className="text-xs">{co.rejected_arguments.map((a, i) => <div key={i}>{a.message_id ? `#${a.message_id} ` : ""}{a.summary} — {a.reason}</div>)}</Td>
                      <Td className="text-xs">{co.new_data.map((d, i) => <div key={i}>{d.evidence_id && <span className="num">[{d.evidence_id}] </span>}{d.summary}</div>)}</Td>
                      <Td className="text-xs">{co.unresolved.join(" · ")}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function EvidenceTable({ v }: { v: SessionView }) {
  const [q, setQ] = useState("");
  const [st, setSt] = useState("");
  const rows = v.evidence.filter((e) => (!st || e.verification === st) && (!q || `${e.ticker} ${e.metric} ${e.source}`.toLowerCase().includes(q.toLowerCase())));
  if (!v.evidence.length) return <Empty title="Registro de evidencias vacío">Cada dato que obtienen las herramientas se registra aquí con fuente, periodo, fecha y estado de verificación.</Empty>;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filtrar por ticker, métrica o fuente" className="w-64 rounded-md border border-line bg-surface-1 px-2 py-1 text-xs" />
        <select value={st} onChange={(e) => setSt(e.target.value)} className="rounded-md border border-line bg-surface-1 px-2 py-1 text-xs" aria-label="Verificación">
          <option value="">Todos los estados</option>
          {["VERIFIED", "UNVERIFIED", "CONFLICT", "UNREACHABLE"].map((x) => <option key={x}>{x}</option>)}
        </select>
        <span className="text-xs text-ink-3">{rows.length} de {v.evidence.length}</span>
      </div>
      <div className="max-h-[70vh] overflow-auto rounded-lg border border-line bg-surface-1">
        <table className="w-full min-w-[960px]">
          <thead className="sticky top-0 bg-surface-1"><tr><Th>Id</Th><Th>Ticker</Th><Th>Métrica</Th><Th>Valor</Th><Th>Periodo</Th><Th>Tipo</Th><Th>Verificación</Th><Th>Fuente</Th><Th>Publicado / recuperado</Th><Th>Confianza</Th></tr></thead>
          <tbody>
            {rows.slice(0, 600).map((e) => (
              <tr key={e.id}>
                <Td className="num text-xs">{e.id}</Td>
                <Td className="text-xs">{e.ticker ?? "—"}</Td>
                <Td className="text-xs">{e.metric}{e.formula && <div className="text-[10px] text-ink-3">{e.formula}</div>}</Td>
                <Td className="num text-xs">{e.unit === "ratio" ? fmt.pct(e.value) : fmt.big(e.value)} {e.unit !== "ratio" && e.unit}{e.priceKind && <div className="text-[10px] text-ink-3">{e.priceKind}</div>}</Td>
                <Td className="text-xs">{e.period} <span className="text-ink-3">{e.periodType}</span></Td>
                <Td className="text-xs">{e.dataType}{e.synthetic && <div><Badge tone="demo">sintético</Badge></div>}</Td>
                <Td><VerificationBadge v={e.verification} /></Td>
                <Td className="max-w-xs text-xs">{e.source}{e.url && (e.url.startsWith("https://") ? <a href={e.url} target="_blank" rel="noopener noreferrer nofollow" className="block truncate text-accent hover:underline">{e.url}</a> : <div className="truncate text-ink-3">{e.url}</div>)}</Td>
                <Td className="text-[11px] text-ink-2">{e.publishedAt ?? "—"}<div>{fmt.date(e.retrievedAt)}</div></Td>
                <Td className="text-[11px]">{e.confidence}<div className="text-ink-3">{e.confidenceReason}</div></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Issues({ v }: { v: SessionView }) {
  if (!v.issues.length) return <Empty title="Sin incidencias">Las discrepancias factuales, de previsión y de criterio se registran aquí con su historial.</Empty>;
  return (
    <div className="space-y-2">
      {v.issues.map((i) => (
        <div key={i.id} className="rounded-lg border border-line bg-surface-1 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="num text-xs text-ink-3">#{i.id}</span>
            <Badge>{i.kind}</Badge>
            <StatusBadge status={i.status} />
            {i.critical && <Badge tone="critical">crítica</Badge>}
            <b>{i.ticker}</b> {i.title}
          </div>
          <ul className="mt-1 text-xs text-ink-2">{i.claims.map((c, k) => <li key={k}>{c.by}: {c.statement}</li>)}</ul>
          {i.resolution && <p className="mt-1 text-xs"><b>Resolución:</b> {i.resolution}</p>}
          {i.kind === "FORECAST" && v.hypotheses.filter((h) => h.issueId === i.id).map((h) => {
            const c = h.consequence as { totalCagr?: number | null; valueYearN?: number | null } | null;
            return <p key={h.id} className="text-xs text-ink-2">Hipótesis «{h.label}» ({h.proposedBy}): valor año N {fmt.money(c?.valueYearN)} · CAGR {fmt.pct(c?.totalCagr)}</p>;
          })}
          <details className="mt-1 text-xs text-ink-3"><summary>Historial ({i.history.length})</summary>{i.history.map((h, k) => <div key={k}>{fmt.date(h.at)} · {h.actor} · {h.change}</div>)}</details>
        </div>
      ))}
    </div>
  );
}

function ScoreHistory({ v }: { v: SessionView }) {
  const rows = v.reports.flatMap((r) => ((r.content as { companies?: { ticker: string }[] }).companies ?? []).map((c) => ({ r, ticker: c.ticker })));
  if (!rows.length) return <Empty title="Sin puntuaciones" />;
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface-1">
      <table className="w-full min-w-[640px]">
        <thead><tr><Th>Agente</Th><Th>Versión</Th><Th>Etapa</Th><Th>Ticker</Th><Th>Total</Th><Th>Criterios</Th><Th>Motivo</Th></tr></thead>
        <tbody>
          {rows.map(({ r, ticker }) => {
            const rev = r.kind === "REVISION" ? (r.content as StoredRevision).companies.find((c) => c.ticker === ticker) : null;
            const scores = rev ? rev.revised_scores : (r.content as StoredReport).companies.find((c) => c.ticker === ticker)?.scores ?? {};
            return (
              <tr key={`${r.id}-${ticker}`}>
                <Td><AgentChip role={r.agentRole} short /></Td>
                <Td className="num">v{r.version}</Td>
                <Td>{stageOf(r)}</Td>
                <Td>{ticker}</Td>
                <Td className="num">{fmt.num(totalIn(r, ticker))}</Td>
                <Td className="text-[11px] text-ink-2">{PROFILES[r.agentRole].criteria.map((c) => `${c.label}: ${scores[c.key] ?? "n/d"}/${c.max}`).join(" · ")}</Td>
                <Td className="text-xs">{rev?.change_reason ?? "informe inicial"}</Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Candidates({ v, sid }: { v: SessionView; sid: string }) {
  const cov = v.session.coverage;
  return (
    <div className="space-y-3">
      {cov && (
        <div className="text-xs text-ink-2">
          <Badge tone={cov.level === "PARTIAL_UNIVERSE" ? "warning" : cov.level === "VERIFIED_FULL_UNIVERSE" ? "good" : "serious"}>{cov.level}</Badge> {cov.description}
          <ul className="mt-1 list-disc pl-5">{cov.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        </div>
      )}
      {!v.candidates.length ? <Empty title="Sin candidatas">El descubrimiento usa SEC EDGAR (frames XBRL) y la lista CSV importada en Settings.</Empty> : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface-1">
          <table className="w-full min-w-[720px]">
            <thead><tr><Th>Ticker</Th><Th>Nombre</Th><Th>Bolsa</Th><Th>Sector (SIC)</Th><Th>Origen</Th><Th>Margen op.</Th><Th>Margen FCO</Th><Th>CAGR ingresos 3a</Th><Th>Cribado</Th><Th>Estado</Th></tr></thead>
            <tbody>
              {v.candidates.map((c) => {
                const s = (c.screen ?? {}) as Record<string, number | null>;
                return (
                  <tr key={c.ticker}>
                    <Td><SessionLink href={`/company/${c.ticker}`} s={sid}>{c.ticker}</SessionLink></Td>
                    <Td className="text-xs">{c.name}</Td>
                    <Td className="text-xs">{c.exchange}</Td>
                    <Td className="text-xs">{c.sector} {c.sic && <span className="text-ink-3">({c.sic})</span>}</Td>
                    <Td className="text-xs">{c.source}{c.synthetic && <> <Badge tone="demo">sintético</Badge></>}</Td>
                    <Td className="num text-xs">{fmt.pct(s.opMargin)}</Td>
                    <Td className="num text-xs">{fmt.pct(s.ocfMargin)}</Td>
                    <Td className="num text-xs">{fmt.pct(s.revenueCagr3y)}</Td>
                    <Td className="num text-xs">{fmt.num(s.screenScore)}</Td>
                    <Td className="text-xs">{c.included ? <Badge tone="good">incluida</Badge> : <Badge tone="serious" title={c.exclusionReason ?? ""}>excluida</Badge>}<div className="text-[10px] text-ink-3">{c.exclusionReason}</div></Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Exports({ sid }: { sid: string }) {
  const items = [
    ["final-md", "Informe final (Markdown)"],
    ["final-csv", "Tabla comparativa (CSV)"],
    ["agents-md", "Informes de los agentes (Markdown)"],
    ["transcript-md", "Transcripción del debate (Markdown)"],
    ["evidence-csv", "Evidencias y fuentes (CSV)"],
    ["scores-csv", "Historial de puntuaciones (CSV)"],
  ];
  return (
    <Card title="Exportar">
      <ul className="space-y-1.5 text-sm">
        {items.map(([t, l]) => <li key={t}><a className="text-accent hover:underline" href={`/api/sessions/${sid}/export?type=${t}`}>{l}</a></li>)}
        {AGENT_ROLES.map((r) => <li key={r}><a className="text-accent hover:underline" href={`/api/sessions/${sid}/export?type=agents-md&role=${r}`}>Informes de {ROLE_LABELS[r]} (Markdown)</a></li>)}
      </ul>
      <p className="mt-3 text-xs text-ink-2">Cada exportación incluye fecha de corte, modelo, fuentes, limitaciones, estado de verificación y la advertencia de que las estimaciones no son garantías. Nunca contiene claves.</p>
    </Card>
  );
}

function Research() {
  const [sid] = useSelectedSession();
  const { data: v, error } = useSessionView(sid);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Candidatas");
  if (!sid) return <Empty title="Seleccione una sesión" />;
  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!v) return <p className="text-sm text-ink-2">Cargando…</p>;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Research</h1>
      <div role="tablist" className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${tab === t ? "border-accent font-semibold text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}>{t}</button>
        ))}
      </div>
      {tab === "Candidatas" && <Candidates v={v} sid={sid} />}
      {tab === "Informes iniciales" && <InitialReports v={v} sid={sid} />}
      {tab === "Revisiones" && <Revisions v={v} />}
      {tab === "Evidencias" && <EvidenceTable v={v} />}
      {tab === "Incidencias" && <Issues v={v} />}
      {tab === "Historial de puntuaciones" && <ScoreHistory v={v} />}
      {tab === "Exportar" && <Exports sid={sid} />}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Research />
    </Suspense>
  );
}
