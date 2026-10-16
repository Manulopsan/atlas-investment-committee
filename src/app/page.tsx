"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, useSelectedSession } from "@/components/hooks";
import { PhaseBar, SessionActions, useSessionView } from "@/components/session";
import { Badge, Button, Card, Empty, ErrorBox, fmt, Notice, SessionLink, Stat, StatusBadge } from "@/components/ui";
import type { PlanEstimate } from "@/lib/llm/cost";
import type { AppSettings } from "@/lib/config";
import { COVERAGE_LABELS } from "@/lib/types";

interface EnvStatus {
  anthropicKeyConfigured: boolean;
  secUserAgentConfigured: boolean;
  alphaVantageKeyConfigured: boolean;
}

function StartPanel({ onStarted }: { onStarted: (id: string) => void }) {
  const [mode, setMode] = useState<"demo" | "dry_run" | "live">("demo");
  const [consent, setConsent] = useState(false);
  const [est, setEst] = useState<PlanEstimate | null>(null);
  const [cfg, setCfg] = useState<{ settings: AppSettings; env: EnvStatus } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ settings: AppSettings; env: EnvStatus }>("/api/settings").then(setCfg).catch((e) => setErr(String(e)));
    api<PlanEstimate>("/api/estimate", { method: "POST", body: "{}" }).then(setEst).catch(() => {});
  }, []);
  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ id: string }>("/api/sessions", { method: "POST", body: JSON.stringify({ mode, consent }) });
      onStarted(r.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const keyMissing = cfg && !cfg.env.anthropicKeyConfigured;
  return (
    <Card title="Iniciar comité">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-semibold text-ink-2">Modalidad</legend>
            {[
              { v: "demo", t: "Demostración", d: "Datos y agentes SINTÉTICOS claramente etiquetados. Sin coste, sin red. Ejecuta el flujo completo." },
              { v: "dry_run", t: "Análisis en seco", d: "Sin llamadas de IA: comprueba configuración y fuentes (SEC), descubre candidatas y estima el coste." },
              { v: "live", t: "Comité real", d: "Llamadas de pago a la API de Anthropic con datos públicos reales. Requiere clave y consentimiento." },
            ].map((o) => (
              <label key={o.v} className={`flex cursor-pointer gap-2 rounded-md border p-2.5 ${mode === o.v ? "border-accent bg-accent/10" : "border-line"}`}>
                <input type="radio" name="mode" checked={mode === o.v} onChange={() => setMode(o.v as typeof mode)} className="mt-1" />
                <span>
                  <span className="text-sm font-semibold">{o.t}</span>
                  <span className="block text-xs text-ink-2">{o.d}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {mode === "live" && keyMissing && (
            <Notice tone="serious">
              No hay <code>ANTHROPIC_API_KEY</code> en el servidor. Cópiela en <code>.env.local</code> (ver <code>.env.example</code>) y reinicie <code>npm run dev</code>. La clave nunca se envía al navegador. Mientras tanto puede usar el modo demostración o el análisis en seco.
            </Notice>
          )}
          {mode !== "demo" && cfg && !cfg.env.secUserAgentConfigured && (
            <Notice>Falta <code>SEC_USER_AGENT</code> (nombre + e-mail de contacto, exigido por la SEC). Sin él no se pueden descargar datos de EDGAR.</Notice>
          )}
          {mode === "live" && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1" />
              <span>Entiendo que esta sesión realiza llamadas de pago a la API de Anthropic, que el coste real depende de los tokens y herramientas utilizados, y que la aplicación detendrá nuevas llamadas al alcanzar el presupuesto configurado.</span>
            </label>
          )}
          <Button variant="primary" disabled={busy || (mode === "live" && (!consent || Boolean(keyMissing)))} onClick={start}>
            {busy ? "Iniciando…" : mode === "live" ? "Iniciar comité (de pago)" : mode === "dry_run" ? "Ejecutar análisis en seco" : "Iniciar demostración"}
          </Button>
          {err && <ErrorBox>{err}</ErrorBox>}
        </div>
        <div>
          <div className="mb-2 text-xs font-semibold text-ink-2">Estimación previa (modo real) — aproximada</div>
          {est ? (
            <div className="space-y-2 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Llamadas aprox." value={fmt.int(est.totalCalls)} sub={`límite ${est.maxCalls}`} />
                <Stat label="Coste estimado" value={est.estCostUsd === null ? "n/d" : `${est.estCostUsd.toFixed(2)} $`} sub={`presupuesto ${est.budgetUsd} $`} />
              </div>
              <div className="text-xs text-ink-2">
                {est.agents} agentes · modelo principal <code>{est.model}</code> · debate <code>{est.debateModel}</code>
              </div>
              <div className="text-xs text-ink-2">Rondas: {est.rounds.join(" → ")}</div>
              <table className="w-full text-xs">
                <tbody>
                  {est.phases.map((p) => (
                    <tr key={p.phase} className="border-b border-line">
                      <td className="py-1">{p.phase}</td>
                      <td className="num py-1 text-right">{p.calls} llamadas</td>
                      <td className="num py-1 text-right">{fmt.big(p.inputTokens)} in / {fmt.big(p.outputTokens)} out</td>
                      <td className="num py-1 text-right">{p.estCostUsd === null ? "n/d" : `${p.estCostUsd.toFixed(2)} $`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {est.warnings.map((w) => (
                <p key={w} className="text-xs text-ink-2">⚠ {w}</p>
              ))}
            </div>
          ) : (
            <p className="text-sm text-ink-2">Calculando…</p>
          )}
        </div>
      </div>
    </Card>
  );
}

function Overview() {
  const [sid, setSid] = useSelectedSession();
  const router = useRouter();
  const { data: v, error, refresh } = useSessionView(sid);
  const s = v?.session;
  const openIssues = v?.issues.filter((i) => ["OPEN", "VERIFYING", "PENDING"].includes(i.status)).length ?? 0;
  const analysed = v ? new Set(v.reports.flatMap((r) => ((r.content as { companies?: { ticker: string }[] }).companies ?? []).map((c) => c.ticker))).size : 0;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Overview</h1>
          <p className="text-sm text-ink-2">Comité autónomo de cuatro agentes: análisis independiente, debate, revisión y decisión del CIO con cálculos deterministas y evidencias trazables.</p>
        </div>
      </div>
      {error && <ErrorBox>{error}</ErrorBox>}
      {!sid && <Empty title="No hay ninguna sesión seleccionada">Inicie un comité abajo o elija una sesión en el selector superior. El modo demostración funciona sin clave de API.</Empty>}
      {v && s && (
        <>
          <Card title={`Última sesión · ${s.id.slice(0, 8)}`} actions={<div className="flex gap-2"><StatusBadge status={s.status} />{s.convergence && <StatusBadge status={s.convergence} />}</div>}>
            <div className="space-y-4">
              <PhaseBar v={v} />
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                <Stat label="Empresas analizadas" value={analysed} />
                <Stat label="Candidatas" value={v.candidates.filter((c) => c.included).length} sub={`${v.candidates.length} evaluadas`} />
                <Stat label="Controversias abiertas" value={openIssues} sub={`${v.issues.length} incidencias`} />
                <Stat label="Finalistas" value={v.verdicts.filter((x) => x.rank !== null).length} sub={`${v.verdicts.filter((x) => x.verdict === "POTENTIAL_BUY").length} compras potenciales`} />
                <Stat label="Tokens" value={fmt.big(v.usage.totals.inputTokens + v.usage.totals.cacheReadTokens + v.usage.totals.cacheWriteTokens + v.usage.totals.outputTokens)} sub={`${v.usage.totals.calls} llamadas`} />
                <Stat label="Coste estimado" value={`${v.usage.totals.estCostUsd.toFixed(3)} $`} sub={s.mode === "demo" ? "simulado (demo, 0 $)" : "estimación, no factura"} />
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-2">
                <span>Modo: <Badge tone={s.mode === "demo" ? "demo" : "neutral"}>{s.mode}</Badge></span>
                <span>Actualizada: {fmt.date(s.updatedAt)}</span>
                <span>Cobertura: {s.coverage ? `${COVERAGE_LABELS[s.coverage.level]} — ${s.coverage.description}` : "pendiente"}</span>
                <span>Presupuesto: {s.settings.limits.maxBudgetUsd} $ · {s.settings.limits.maxCallsPerSession} llamadas máx.</span>
              </div>
              {s.coverage?.limitations?.length ? (
                <ul className="list-disc pl-5 text-xs text-ink-2">
                  {s.coverage.limitations.map((l) => <li key={l}>{l}</li>)}
                </ul>
              ) : null}
              {s.status === "DRY_RUN_COMPLETE" && <Notice tone="good">Análisis en seco completado sin llamadas de IA. Revise las candidatas en Research y la estimación de coste.</Notice>}
              {s.budgetExhausted && <Notice tone="critical">Se alcanzó el presupuesto o el límite de llamadas: el debate se detuvo de forma controlada y los desacuerdos pendientes se documentan en el informe final.</Notice>}
              <SessionActions v={v} onChange={refresh} />
              <div className="flex flex-wrap gap-3 text-sm">
                <SessionLink href="/committee" s={sid}>Committee Room →</SessionLink>
                <SessionLink href="/debate" s={sid}>Debate en directo →</SessionLink>
                <SessionLink href="/ranking" s={sid}>Ranking final →</SessionLink>
              </div>
            </div>
          </Card>
          {v.errors.length > 0 && (
            <Card title="Errores registrados">
              <ul className="space-y-1 text-xs">
                {v.errors.slice(-8).map((e, i) => (
                  <li key={i}><span className="text-ink-3">{fmt.date(e.createdAt)}</span> <code>{e.taskKey ?? e.phase}</code> {e.message}</li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
      <StartPanel onStarted={(id) => { setSid(id); router.push(`/committee?s=${id}`); }} />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Overview />
    </Suspense>
  );
}
