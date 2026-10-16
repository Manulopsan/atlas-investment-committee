"use client";
import { Suspense } from "react";
import { useParams } from "next/navigation";
import { useSelectedSession, usePolling } from "@/components/hooks";
import { AgentChip, Badge, Card, Empty, ErrorBox, fmt, StatusBadge, Td, Th, VerdictBadge, VerificationBadge } from "@/components/ui";
import { ScenarioBars, ScoreEvolution } from "@/components/charts";
import { scoreHistory } from "@/components/derive";
import type { CompanyView } from "@/components/types";
import { AGENT_ROLES } from "@/lib/types";

const KEY_METRICS = ["revenue", "grossProfit", "operatingIncome", "netIncome", "operatingCashFlow", "capex", "free_cash_flow", "dilutedShares", "epsDiluted", "longTermDebt", "cash", "equity", "gross_margin", "operating_margin", "fcf_margin", "roic_approx", "revenue_cagr_3y", "revenue_cagr_5y", "share_count_change_3y", "net_debt"];

function Company() {
  const [sid] = useSelectedSession();
  const { ticker } = useParams<{ ticker: string }>();
  const { data: v, error } = usePolling<CompanyView>(sid ? `/api/sessions/${sid}/company/${ticker}` : null, () => false);
  if (!sid) return <Empty title="Seleccione una sesión" />;
  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!v) return <p className="text-sm text-ink-2">Cargando…</p>;
  const s = v.snapshot;
  const sc = s.scenarios;
  const fin = v.evidence.filter((e) => KEY_METRICS.includes(e.metric) && e.periodType === "FY");
  const years = Array.from(new Set(fin.map((e) => e.fiscalYear).filter((x): x is number => x !== null))).sort((a, b) => b - a).slice(0, 5);
  const cio = (v.verdict?.content as { cio?: { rationale?: string; consensus?: string[]; dissent?: string[]; conditions_for_target?: string[]; catalysts?: { description: string; verifiable: boolean }[] } } | undefined)?.cio;
  const target = 0.15;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{s.ticker}</h1>
        <span className="text-sm text-ink-2">{s.name} · {s.sector ?? "sector n/d"}</span>
        {s.synthetic && <Badge tone="demo">empresa SINTÉTICA de demostración</Badge>}
        {v.verdict && <VerdictBadge verdict={v.verdict.verdict} />}
        {v.verdict?.rank && <Badge tone="accent">#{v.verdict.rank} del ranking</Badge>}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Precio y valoración" className="lg:col-span-1">
          <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
            <dt className="text-ink-3">Precio de referencia</dt><dd className="num">{s.price ? `${fmt.money(s.price.value)} $` : <Badge tone="warning">no verificado</Badge>}</dd>
            <dt className="text-ink-3">Fecha / tipo</dt><dd className="text-xs">{s.price ? `${s.price.asOf} · ${s.price.kind} · ${s.price.evidenceId}` : "—"}</dd>
            <dt className="text-ink-3">Valor razonable central</dt><dd className="num">{fmt.money(sc?.fairValueCentral)}</dd>
            <dt className="text-ink-3">Rango</dt><dd className="num">{fmt.money(sc?.fairValueLow)} – {fmt.money(sc?.fairValueHigh)}</dd>
            <dt className="text-ink-3">Precio máx. (objetivo)</dt><dd className="num">{fmt.money(sc?.maxPriceForTarget)}</dd>
            <dt className="text-ink-3">Entrada propuesta</dt><dd className="num">{fmt.money(sc?.proposedEntryPrice)}</dd>
            <dt className="text-ink-3">Margen de seguridad</dt><dd className="num">{fmt.pct(sc?.marginOfSafetyAtPrice)}</dd>
            <dt className="text-ink-3">Confianza en datos</dt><dd className="num">{Math.round(s.confidence.score * 100)}%</dd>
          </dl>
          <p className="mt-2 text-[11px] text-ink-3">{sc?.formula}</p>
        </Card>
        <Card title="Escenarios (CAGR total estimado)" className="lg:col-span-1">
          {sc ? <ScenarioBars bear={sc.scenarios.bear.totalCagr} base={sc.scenarios.base.totalCagr} bull={sc.scenarios.bull.totalCagr} target={sc.target ?? target} /> : <p className="text-sm text-ink-2">Sin hipótesis de valoración.</p>}
          {sc && (["bear", "base", "bull"] as const).map((k) => sc.scenarios[k].insufficientData.length > 0 && <p key={k} className="text-[11px] text-ink-3">{k}: datos insuficientes ({sc.scenarios[k].insufficientData.join(", ")})</p>)}
        </Card>
        <Card title="Evolución de puntuaciones" className="lg:col-span-1">
          <ScoreEvolution data={scoreHistory(v.reports, s.ticker)} height={200} />
        </Card>
      </div>
      <Card title="Tesis de inversión (última versión de cada agente)">
        <div className="grid gap-3 md:grid-cols-2">
          {AGENT_ROLES.map((r) => {
            const view = s.views[r];
            return (
              <div key={r} className="rounded-md border border-line p-3">
                <div className="flex items-center justify-between"><AgentChip role={r} /><span className="num text-sm font-semibold">{view ? fmt.num(view.total) : "n/d"}{view && <span className="text-[10px] text-ink-3"> v{view.version}</span>}</span></div>
                <p className="mt-1 text-sm">{view?.conclusion ?? "No analizada por este agente."}</p>
              </div>
            );
          })}
        </div>
        {cio && (
          <div className="mt-3 space-y-1 text-sm">
            <p><b>CIO:</b> {cio.rationale}</p>
            <p><b>Consenso:</b> {cio.consensus?.join("; ") || "—"}</p>
            <p><b>Discrepancias:</b> {cio.dissent?.join("; ") || "—"}</p>
            <p><b>Hipótesis necesarias para el objetivo:</b> {cio.conditions_for_target?.join("; ") || "—"}</p>
            <p><b>Catalizadores:</b> {cio.catalysts?.map((c) => `${c.description}${c.verifiable ? "" : " (no verificable)"}`).join("; ") || "—"}</p>
          </div>
        )}
        {v.verdict?.overrideReason && <p className="mt-2 text-xs text-ink-2">Ajuste del motor: {v.verdict.overrideReason}</p>}
      </Card>
      <Card title="Datos financieros (10-K, por ejercicio fiscal)">
        {years.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead><tr><Th>Métrica</Th>{years.map((y) => <Th key={y} className="text-right">FY{y}</Th>)}</tr></thead>
              <tbody>
                {KEY_METRICS.filter((m) => fin.some((e) => e.metric === m)).map((m) => (
                  <tr key={m}>
                    <Td className="text-xs">{m}</Td>
                    {years.map((y) => {
                      const e = fin.find((x) => x.metric === m && x.fiscalYear === y);
                      return <Td key={y} className="num text-right text-xs">{e ? <span title={`${e.id} · ${e.source} · ${e.verification}`}>{e.unit === "ratio" ? fmt.pct(e.value) : fmt.big(e.value)}{e.verification !== "VERIFIED" && " *"}</span> : "—"}</Td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-[11px] text-ink-3">— = dato no disponible (nunca se interpreta como cero). * = no verificado. Pase el cursor para ver la evidencia.</p>
          </div>
        ) : <p className="text-sm text-ink-2">Sin datos financieros registrados.</p>}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Riesgos y vetos">
          {s.vetoes.length ? s.vetoes.map((x, i) => (
            <div key={i} className="mb-2 text-sm">
              <Badge tone={x.severity === "critical" ? "critical" : x.severity === "high" ? "serious" : "warning"}>{x.severity}</Badge> {x.upheld ? "" : <Badge>retirado</Badge>} {x.reason}
              <div className="text-xs text-ink-2">Evidencia: {x.raw.evidence} {x.raw.evidence_ids.join(", ")} · Fuente: {x.raw.source_url ?? "n/d"}</div>
            </div>
          )) : <p className="text-sm text-ink-2">Sin vetos.</p>}
          <div className="mt-2 text-xs text-ink-2">Riesgo (Risk Analyst): {fmt.num(s.views.RISK?.total)} / 100 — alto = más riesgo.</div>
        </Card>
        <Card title="Incidencias e historial de decisiones">
          {v.issues.length ? v.issues.map((i) => (
            <div key={i.id} className="mb-2 text-xs">
              #{i.id} <Badge>{i.kind}</Badge> <StatusBadge status={i.status} /> {i.title}
              {i.resolution && <div className="text-ink-2">→ {i.resolution}</div>}
            </div>
          )) : <p className="text-sm text-ink-2">Sin incidencias.</p>}
          {v.hypotheses.map((h) => {
            const c = h.consequence as { totalCagr?: number | null } | null;
            return <div key={h.id} className="text-xs text-ink-2">Hipótesis «{h.label}» ({h.proposedBy}): CAGR {fmt.pct(c?.totalCagr)}</div>;
          })}
          <div className="mt-2 text-xs text-ink-3">Versiones: {v.reports.filter((r) => (r.content as { companies: unknown[] }).companies.length).map((r) => `${r.agentRole} v${r.version}`).join(" · ")}</div>
        </Card>
      </div>
      <Card title={`Debate sobre ${s.ticker} (${v.messages.length} mensajes)`}>
        <ol className="space-y-2">
          {v.messages.map((m) => (
            <li key={m.id} className="text-sm">
              <span className="num text-xs text-ink-3">#{m.id} R{m.round}</span> <AgentChip role={m.fromRole} short /> → <AgentChip role={m.toRole} short /> <Badge>{m.type}</Badge> {m.claim}
              {m.evidenceIds.length > 0 && <span className="num text-xs text-ink-2"> [{m.evidenceIds.join(", ")}]</span>}
            </li>
          ))}
        </ol>
        {!v.messages.length && <p className="text-sm text-ink-2">Sin debate registrado para esta empresa.</p>}
      </Card>
      <Card title="Fuentes y cálculos">
        <div className="max-h-80 overflow-auto">
          <table className="w-full min-w-[640px]">
            <thead><tr><Th>Id</Th><Th>Métrica</Th><Th>Valor</Th><Th>Periodo</Th><Th>Estado</Th><Th>Fuente</Th></tr></thead>
            <tbody>
              {v.evidence.map((e) => (
                <tr key={e.id}>
                  <Td className="num text-xs">{e.id}</Td><Td className="text-xs">{e.metric}</Td><Td className="num text-xs">{e.unit === "ratio" ? fmt.pct(e.value) : fmt.big(e.value)}</Td><Td className="text-xs">{e.period}</Td><Td><VerificationBadge v={e.verification} /></Td>
                  <Td className="text-xs">{e.url?.startsWith("https://") ? <a href={e.url} target="_blank" rel="noopener noreferrer nofollow" className="text-accent hover:underline">{e.source}</a> : e.source}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 text-xs text-ink-2">Cálculos deterministas registrados: {v.calculations.map((c) => c.kind).join(", ") || "ninguno"}</div>
      </Card>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Company />
    </Suspense>
  );
}
