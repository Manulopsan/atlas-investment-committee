"use client";
import { useState } from "react";
import { api, usePolling } from "@/components/hooks";
import { Badge, Button, Card, Empty, ErrorBox, fmt, Notice, StatusBadge, Td, Th } from "@/components/ui";
import type { EvalRunRow } from "@/lib/evals";

export default function EvalsPage() {
  const { data, error, refresh } = usePolling<{ runs: EvalRunRow[] }>("/api/evals", (d) => d.runs.some((r) => r.status === "RUNNING"), 3000);
  const [err, setErr] = useState<string | null>(null);
  const startDemo = async () => {
    setErr(null);
    try {
      await api("/api/evals", { method: "POST", body: JSON.stringify({ mode: "demo" }) });
      setTimeout(refresh, 500);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Evals</h1>
        <Button onClick={startDemo}>Ejecutar evaluación de demostración</Button>
      </div>
      <Notice tone="neutral">
        Cada caso vuelve a ejecutar el comité <b>a una fecha pasada</b> (modo histórico: solo presentaciones y precios disponibles entonces) y compara veredictos y escenarios con la rentabilidad realizada después. Las evaluaciones reales son de pago y se lanzan desde la terminal: <code>npm run eval -- --file evals/cases.example.json</code> (muestra la estimación) y después con <code>--confirm-cost</code>.
      </Notice>
      {(error || err) && <ErrorBox>{error ?? err}</ErrorBox>}
      {!data?.runs.length && <Empty title="Todavía no hay evaluaciones">La evaluación de demostración usa datos sintéticos: valida el arnés, no el criterio del comité.</Empty>}
      {data?.runs.map((r) => (
        <Card key={r.id} title={<span className="flex flex-wrap items-center gap-2">{r.name} {r.mode === "demo" && <Badge tone="demo">sintético</Badge>}</span>} actions={<div className="flex items-center gap-2"><StatusBadge status={r.status} /><span className="text-xs text-ink-3">{fmt.date(r.createdAt)}</span></div>}>
          {r.error && <ErrorBox>{r.error}</ErrorBox>}
          {r.metrics && (
            <div className="mb-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>Compras: <b>{r.metrics.buys.count}</b> · CAGR realizado medio <b className="num">{fmt.pct(r.metrics.buys.meanRealizedCagr)}</b></div>
              <div>Acierto (≥ {fmt.pct(r.metrics.target, 0)}): <b className="num">{fmt.pct(r.metrics.buys.hitRate)}</b></div>
              <div>Spearman puntuación↔realizado: <b className="num">{fmt.num(r.metrics.spearmanScoreVsRealized, 2)}</b></div>
              <div>Error medio CAGR base: <b className="num">{fmt.pct(r.metrics.baseCagrMeanAbsError)}</b> · dentro del rango: <b className="num">{fmt.pct(r.metrics.withinBearBullRate)}</b></div>
            </div>
          )}
          {(r.results ?? []).map((c) => (
            <div key={c.sessionId} className="mb-3 overflow-x-auto">
              <div className="mb-1 text-xs text-ink-2">{c.case.name} — a fecha {c.case.asOf} · sesión <a className="text-accent hover:underline" href={`/ranking?s=${c.sessionId}`}>{c.sessionId.slice(0, 8)}</a> · {c.status} · {c.convergence}</div>
              <table className="w-full min-w-[720px]">
                <thead><tr><Th>Ticker</Th><Th>Veredicto</Th><Th>Puntuación</Th><Th>CAGR previsto bajista / base / alcista</Th><Th>CAGR realizado</Th><Th>Nota</Th></tr></thead>
                <tbody>
                  {c.outcomes.map((o) => (
                    <tr key={o.ticker}>
                      <Td>{o.ticker}</Td><Td className="text-xs">{o.verdict ?? "—"}</Td><Td className="num">{fmt.num(o.finalScore)}</Td>
                      <Td className="num text-xs">{fmt.pct(o.predicted.bear)} / {fmt.pct(o.predicted.base)} / {fmt.pct(o.predicted.bull)}</Td>
                      <Td className="num">{fmt.pct(o.realizedCagr)} <span className="text-[10px] text-ink-3">{o.realizedBasis === "price_only" ? "solo precio" : o.realizedBasis === "total_return" ? "total" : ""}</span></Td>
                      <Td className="text-xs text-ink-2">{o.note}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {r.metrics && <ul className="list-disc pl-5 text-[11px] text-ink-3">{r.metrics.caveats.map((c) => <li key={c}>{c}</li>)}</ul>}
        </Card>
      ))}
    </div>
  );
}
