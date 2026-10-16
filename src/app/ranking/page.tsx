"use client";
import { Suspense, useMemo, useState } from "react";
import { useSelectedSession } from "@/components/hooks";
import { useSessionView } from "@/components/session";
import { Badge, Card, Empty, ErrorBox, fmt, Notice, SessionLink, StatusBadge, Td, Th, VerdictBadge } from "@/components/ui";
import type { ScenarioSetResult } from "@/lib/finance/valuation";
import type { SessionView } from "@/components/types";

type V = SessionView["verdicts"][number];
interface Content {
  name: string | null;
  sector: string | null;
  synthetic: boolean;
  price: { value: number; asOf: string | null; kind: string | null; evidenceId: string } | null;
  scores: { quality: number | null; valuation: number | null; risk: number | null; catalysts: number | null };
  scenarios: ScenarioSetResult | null;
  dataConfidence: { score: number };
  debateStatus: string;
  eur: { baseCagrEurConstantFx: number | null } | null;
}
const C = (v: V) => v.content as unknown as Content;

const SORTS: Record<string, (v: V) => number | null> = {
  rank: (v) => (v.rank === null ? null : -v.rank),
  final: (v) => v.finalScore,
  quality: (v) => C(v).scores.quality,
  valuation: (v) => C(v).scores.valuation,
  return: (v) => C(v).scenarios?.scenarios.base.totalCagr ?? null,
  risk: (v) => (C(v).scores.risk === null ? null : -C(v).scores.risk!),
};

function Ranking() {
  const [sid] = useSelectedSession();
  const { data: v, error } = useSessionView(sid);
  const [sort, setSort] = useState("rank");
  const [sector, setSector] = useState("");
  const [verif, setVerif] = useState("");
  const [onlyRanked, setOnlyRanked] = useState(false);
  const rows = useMemo(() => {
    if (!v) return [];
    const f = SORTS[sort];
    return v.verdicts
      .filter((x) => (!sector || C(x).sector === sector) && (!onlyRanked || x.rank !== null))
      .filter((x) => !verif || (verif === "verified" ? C(x).price && C(x).dataConfidence.score >= 0.7 : !C(x).price || C(x).dataConfidence.score < 0.7))
      .sort((a, b) => (f(b) ?? -Infinity) - (f(a) ?? -Infinity));
  }, [v, sort, sector, verif, onlyRanked]);
  if (!sid) return <Empty title="Seleccione una sesión" />;
  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!v) return <p className="text-sm text-ink-2">Cargando…</p>;
  const fr = v.finalReport;
  if (!fr) return <Empty title="El ranking final aún no existe">Se genera cuando el CIO emite su decisión y el informe final se valida. {v.session.status !== "COMPLETED" && `Estado actual: ${v.session.status}.`}</Empty>;
  const content = fr.content as { executive_summary: string; convergence: string; buys: string[]; limitations: string[]; ranking: string[]; objective: { targetAnnualReturn: number } };
  const sectors = Array.from(new Set(v.verdicts.map((x) => C(x).sector).filter(Boolean))) as string[];
  const sel = "rounded-md border border-line bg-surface-1 px-2 py-1 text-xs";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Final Ranking</h1>
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-2">Convergencia</span>
          <StatusBadge status={content.convergence} />
          {content.convergence === "RESOLVED" ? <Badge tone="good">consenso documentado</Badge> : <Badge tone="warning">sin consenso pleno: hay cuestiones pendientes</Badge>}
          {!fr.validated && <Badge tone="critical">informe no validado</Badge>}
        </div>
      </div>
      <Card title="Resumen del CIO">
        <p className="text-sm">{content.executive_summary}</p>
        <p className="mt-2 text-sm">
          <b>Compras potenciales:</b> {content.buys.length ? content.buys.join(", ") : "ninguna — el comité no recomienda compras con la evidencia disponible"}.{" "}
          <b>Finalistas en ranking:</b> {content.ranking.length} (máximo {v.session.config.maxFinalists}; nunca se rellena hasta cinco).
        </p>
        <Notice tone="neutral">
          El objetivo del {fmt.pct(content.objective.targetAnnualReturn, 0)} anual es un criterio de selección, no una promesa. Las rentabilidades mostradas son estimaciones del motor a partir de hipótesis explícitas; cada ficha indica las hipótesis que deben cumplirse.
        </Notice>
      </Card>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Orden y filtros">
        <label className="text-xs text-ink-2">Ordenar por <select className={sel} value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="rank">Ranking</option><option value="final">Puntuación final</option><option value="quality">Calidad</option><option value="valuation">Valoración</option><option value="return">Rentabilidad potencial</option><option value="risk">Riesgo (menor primero)</option>
        </select></label>
        <select className={sel} value={sector} onChange={(e) => setSector(e.target.value)} aria-label="Sector"><option value="">Todos los sectores</option>{sectors.map((s) => <option key={s}>{s}</option>)}</select>
        <select className={sel} value={verif} onChange={(e) => setVerif(e.target.value)} aria-label="Verificación"><option value="">Cualquier verificación</option><option value="verified">Precio verificado y confianza ≥ 70%</option><option value="unverified">Datos incompletos</option></select>
        <label className="flex items-center gap-1 text-xs text-ink-2"><input type="checkbox" checked={onlyRanked} onChange={(e) => setOnlyRanked(e.target.checked)} /> Solo finalistas</label>
      </div>
      <div className="overflow-x-auto rounded-lg border border-line bg-surface-1">
        <table className="w-full min-w-[1400px]">
          <thead>
            <tr>
              <Th>#</Th><Th>Empresa</Th><Th>Sector</Th><Th>Precio ref. (fecha)</Th><Th>Valor razonable central [rango]</Th><Th>Precio máx. objetivo</Th><Th>Entrada propuesta</Th>
              <Th>Valor año N bajista / base / alcista</Th><Th>CAGR bajista / base / alcista</Th><Th>Puntuación</Th><Th>Riesgo</Th><Th>Confianza datos</Th><Th>Debate</Th><Th>Veredicto</Th><Th></Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => {
              const c = C(x);
              const sc = c.scenarios;
              return (
                <tr key={x.ticker} className={x.rank ? "" : "opacity-80"}>
                  <Td className="num font-semibold">{x.rank ?? "—"}</Td>
                  <Td><div className="font-semibold">{x.ticker}</div><div className="text-[11px] text-ink-2">{c.name}</div>{c.synthetic && <Badge tone="demo">sintético</Badge>}</Td>
                  <Td className="text-xs">{c.sector ?? "n/d"}</Td>
                  <Td className="num whitespace-nowrap text-xs">{c.price ? <>{fmt.money(c.price.value)} $<div className="text-[10px] text-ink-3">{c.price.asOf?.replace("T", " ")}</div><div className="text-[10px] text-ink-3">{c.price.kind} · {c.price.evidenceId}</div></> : <Badge tone="warning">no verificado</Badge>}</Td>
                  <Td className="num whitespace-nowrap text-xs">{fmt.money(sc?.fairValueCentral)} <span className="text-ink-3">[{fmt.money(sc?.fairValueLow)}–{fmt.money(sc?.fairValueHigh)}]</span></Td>
                  <Td className="num text-xs">{fmt.money(sc?.maxPriceForTarget)}</Td>
                  <Td className="num text-xs">{fmt.money(sc?.proposedEntryPrice)}</Td>
                  <Td className="num whitespace-nowrap text-xs">{fmt.money(sc?.scenarios.bear.valueYearN)} / {fmt.money(sc?.scenarios.base.valueYearN)} / {fmt.money(sc?.scenarios.bull.valueYearN)}</Td>
                  <Td className="num whitespace-nowrap text-xs">{fmt.pct(sc?.scenarios.bear.totalCagr)} / <b>{fmt.pct(sc?.scenarios.base.totalCagr)}</b> / {fmt.pct(sc?.scenarios.bull.totalCagr)}{c.eur && <div className="text-[10px] text-ink-3">EUR base (FX const.): {fmt.pct(c.eur.baseCagrEurConstantFx)}</div>}</Td>
                  <Td className="num text-xs font-semibold">{fmt.num(x.finalScore)}</Td>
                  <Td className="num text-xs">{fmt.num(c.scores.risk, 0)}</Td>
                  <Td className="num text-xs">{Math.round(c.dataConfidence.score * 100)}%</Td>
                  <Td className="text-xs"><StatusBadge status={c.debateStatus} /></Td>
                  <Td className="min-w-[200px] text-xs"><VerdictBadge verdict={x.verdict} />{x.overrideReason && <div className="mt-1 max-w-[220px] text-[10px] text-ink-3">{x.overrideReason}</div>}</Td>
                  <Td className="text-xs"><SessionLink href={`/company/${x.ticker}`} s={sid}>Ficha →</SessionLink></Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-ink-3">Valores de escenario en USD por acción al final del horizonte ({v.session.config.horizonYears} años). La puntuación final la calcula el motor (calidad 30%, valoración 30%, rentabilidad 20%, solidez 15%, catalizadores 5%, con penalización por riesgo). Un veto crítico excluye sin compensación.</p>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Ranking />
    </Suspense>
  );
}
