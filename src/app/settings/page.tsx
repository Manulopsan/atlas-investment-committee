"use client";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/components/hooks";
import { Badge, Button, Card, ErrorBox, Notice } from "@/components/ui";
import { SECTOR_EXCLUSIONS, type AppSettings } from "@/lib/config";

interface Env {
  anthropicKeyConfigured: boolean;
  secUserAgentConfigured: boolean;
  alphaVantageKeyConfigured: boolean;
}

const input = "w-full rounded-md border border-line bg-surface-1 px-2 py-1 text-sm";

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-semibold text-ink-2">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-ink-3">{hint}</span>}
    </label>
  );
}

function Num({ value, onChange, step = 1, min, max }: { value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number }) {
  return <input type="number" className={input} value={Number.isFinite(value) ? value : ""} step={step} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} />;
}

const EXCL_LABEL: Record<string, string> = { BANKS: "Bancos", INSURANCE: "Aseguradoras", TELECOM: "Telecomunicaciones", SHELL_COMPANIES: "SPAC / sociedades instrumentales" };

export default function SettingsPage() {
  const [s, setS] = useState<AppSettings | null>(null);
  const [env, setEnv] = useState<Env | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [csv, setCsv] = useState("");
  const [csvInfo, setCsvInfo] = useState<string | null>(null);
  const [newModel, setNewModel] = useState("");
  useEffect(() => {
    api<{ settings: AppSettings; env: Env }>("/api/settings").then((r) => (setS(r.settings), setEnv(r.env))).catch((e) => setErr(String(e)));
  }, []);
  if (!s) return err ? <ErrorBox>{err}</ErrorBox> : <p className="text-sm text-ink-2">Cargando…</p>;
  const up = (f: (d: AppSettings) => void) => setS((prev) => {
    const next = structuredClone(prev!);
    f(next);
    return next;
  });
  const save = async () => {
    setErr(null);
    setMsg(null);
    try {
      const r = await api<{ settings: AppSettings }>("/api/settings", { method: "PUT", body: JSON.stringify({ settings: s }) });
      setS(r.settings);
      setMsg("Configuración guardada. Se aplicará a las sesiones nuevas (cada sesión congela su configuración al iniciarse).");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const importCsv = async (text: string) => {
    try {
      const r = await api<{ tickers: string[]; prices: { ticker: string; price: number; date: string }[]; rejected: string[] }>("/api/csv", { method: "POST", body: JSON.stringify({ csv: text }) });
      up((d) => {
        d.investment.userTickers = Array.from(new Set([...d.investment.userTickers, ...r.tickers]));
        d.investment.userPrices = [...d.investment.userPrices.filter((p) => !r.prices.some((n) => n.ticker === p.ticker)), ...r.prices];
      });
      setCsvInfo(`${r.tickers.length} tickers importados${r.prices.length ? `, ${r.prices.length} precios del usuario (se marcarán NO VERIFICADOS)` : ""}${r.rejected.length ? `; ${r.rejected.length} líneas rechazadas` : ""}. Guarde para aplicar.`);
    } catch (e) {
      setCsvInfo(e instanceof Error ? e.message : String(e));
    }
  };
  const inv = s.investment;
  const L = s.limits;
  const models = Object.keys(s.pricing);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Settings</h1>
        <Button variant="primary" onClick={save}>Guardar configuración</Button>
      </div>
      {msg && <Notice tone="good">{msg}</Notice>}
      {err && <ErrorBox>{err}</ErrorBox>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Modelo y clave (servidor)">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 text-sm">
              API key: {env?.anthropicKeyConfigured ? <Badge tone="good">configurada en el servidor</Badge> : <Badge tone="serious">no configurada</Badge>}
              SEC User-Agent: {env?.secUserAgentConfigured ? <Badge tone="good">configurado</Badge> : <Badge tone="serious">no configurado</Badge>}
              Alpha Vantage: {env?.alphaVantageKeyConfigured ? <Badge tone="good">configurada</Badge> : <Badge>opcional</Badge>}
            </div>
            <p className="text-xs text-ink-2">Las claves se configuran solo en <code>.env.local</code> del servidor (ver <code>.env.example</code>) y nunca se envían al navegador, ni se guardan en SQLite, logs o exportaciones.</p>
            <Field label="Modelo principal" hint="Informes iniciales, revisiones y decisión del CIO.">
              <select className={input} value={s.model} onChange={(e) => up((d) => void (d.model = e.target.value))}>{models.map((m) => <option key={m}>{m}</option>)}</select>
            </Field>
            <Field label="Modelo de debate y verificación (calidad configurable)">
              <select className={input} value={s.debateModel} onChange={(e) => up((d) => void (d.debateModel = e.target.value))}>{models.map((m) => <option key={m}>{m}</option>)}</select>
            </Field>
            <Field label="Esfuerzo (effort)" hint="Más esfuerzo = más tokens y coste.">
              <select className={input} value={s.effort} onChange={(e) => up((d) => void (d.effort = e.target.value as AppSettings["effort"]))}>{["low", "medium", "high", "xhigh", "max"].map((m) => <option key={m}>{m}</option>)}</select>
            </Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.refusalFallback} onChange={(e) => up((d) => void (d.refusalFallback = e.target.checked))} /> Fallback de servidor ante rechazos (beta; se desactiva solo si la API lo rechaza)</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.enableWebSearch} onChange={(e) => up((d) => void (d.enableWebSearch = e.target.checked))} /> Búsqueda web del servidor de Anthropic (coste adicional por búsqueda; resultados siempre NO VERIFICADOS)</label>
          </div>
        </Card>
        <Card title="Presupuesto y límites">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Presupuesto máx. por sesión (USD)"><Num value={L.maxBudgetUsd} step={0.5} min={0} onChange={(n) => up((d) => void (d.limits.maxBudgetUsd = n))} /></Field>
            <Field label="Llamadas máx. por sesión"><Num value={L.maxCallsPerSession} min={1} onChange={(n) => up((d) => void (d.limits.maxCallsPerSession = n))} /></Field>
            <Field label="Tokens de entrada máx. por llamada"><Num value={L.maxInputTokensPerCall} step={1000} onChange={(n) => up((d) => void (d.limits.maxInputTokensPerCall = n))} /></Field>
            <Field label="Tokens de salida máx. por llamada"><Num value={L.maxOutputTokensPerCall} step={1000} onChange={(n) => up((d) => void (d.limits.maxOutputTokensPerCall = n))} /></Field>
            <Field label="Rondas completas de debate (1–2)"><Num value={L.maxDebateRounds} min={1} max={2} onChange={(n) => up((d) => void (d.limits.maxDebateRounds = n))} /></Field>
            <Field label="Rondas adicionales de revisión (0–1)"><Num value={L.maxExtraRevisionRounds} min={0} max={1} onChange={(n) => up((d) => void (d.limits.maxExtraRevisionRounds = n))} /></Field>
            <Field label="Verificaciones máx. por empresa"><Num value={L.maxVerificationsPerCompany} min={0} onChange={(n) => up((d) => void (d.limits.maxVerificationsPerCompany = n))} /></Field>
            <Field label="Iteraciones de herramientas por tarea"><Num value={L.maxToolIterations} min={1} onChange={(n) => up((d) => void (d.limits.maxToolIterations = n))} /></Field>
            <Field label="Concurrencia (agentes en paralelo)"><Num value={L.concurrency} min={1} max={4} onChange={(n) => up((d) => void (d.limits.concurrency = n))} /></Field>
            <Field label="Reserva para el veredicto (fracción)" hint="Parte del presupuesto que el debate no puede usar."><Num value={L.finalReserveFraction} step={0.05} min={0} max={0.5} onChange={(n) => up((d) => void (d.limits.finalReserveFraction = n))} /></Field>
          </div>
        </Card>
        <Card title="Objetivo de inversión">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Horizonte (años)"><Num value={inv.horizonYears} min={1} max={10} onChange={(n) => up((d) => void (d.investment.horizonYears = n))} /></Field>
            <Field label="Rentabilidad objetivo anual" hint="Objetivo de selección, no promesa."><Num value={inv.targetAnnualReturn} step={0.01} min={0} max={1} onChange={(n) => up((d) => void (d.investment.targetAnnualReturn = n))} /></Field>
            <Field label="Margen de seguridad requerido"><Num value={inv.requiredMarginOfSafety} step={0.05} min={0} max={0.8} onChange={(n) => up((d) => void (d.investment.requiredMarginOfSafety = n))} /></Field>
            <Field label="Tasa de descuento de referencia"><Num value={inv.discountRate} step={0.005} min={0.03} max={0.25} onChange={(n) => up((d) => void (d.investment.discountRate = n))} /></Field>
            <Field label="Máx. finalistas (0–5)"><Num value={inv.maxFinalists} min={0} max={5} onChange={(n) => up((d) => void (d.investment.maxFinalists = n))} /></Field>
            <Field label="Tolerancia al riesgo">
              <select className={input} value={inv.riskTolerance} onChange={(e) => up((d) => void (d.investment.riskTolerance = e.target.value as typeof inv.riskTolerance))}><option value="low">baja</option><option value="moderate">moderada</option><option value="high">alta</option></select>
            </Field>
            <Field label="Estrategia"><input className={input} value={inv.strategy} onChange={(e) => up((d) => void (d.investment.strategy = e.target.value))} /></Field>
            <Field label="Monedas"><input className={input} value="USD (presentación) · EUR (alternativa)" disabled /></Field>
          </div>
          <fieldset className="mt-3">
            <legend className="text-xs font-semibold text-ink-2">Sectores excluidos</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {SECTOR_EXCLUSIONS.map((x) => (
                <label key={x} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={inv.excludedSectors.includes(x)} onChange={(e) => up((d) => void (d.investment.excludedSectors = e.target.checked ? [...d.investment.excludedSectors, x] : d.investment.excludedSectors.filter((y) => y !== x)))} />{EXCL_LABEL[x]}</label>
              ))}
            </div>
          </fieldset>
        </Card>
        <Card title="Universo y descubrimiento">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bolsas (campo exchange de la SEC)" hint="Separadas por comas: NYSE, Nasdaq, CBOE"><input className={input} value={inv.exchanges.join(", ")} onChange={(e) => up((d) => void (d.investment.exchanges = e.target.value.split(",").map((x) => x.trim()).filter(Boolean)))} /></Field>
            <Field label="Segmentos">
              <div className="flex gap-3 pt-1">{(["large", "mid", "small"] as const).map((c) => <label key={c} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={inv.capSegments.includes(c)} onChange={(e) => up((d) => void (d.investment.capSegments = e.target.checked ? [...d.investment.capSegments, c] : d.investment.capSegments.filter((y) => y !== c)))} />{c}</label>)}</div>
            </Field>
            <Field label="Candidatas para la ronda 1"><Num value={inv.maxCandidates} min={1} max={30} onChange={(n) => up((d) => void (d.investment.maxCandidates = n))} /></Field>
            <Field label="Empresas en el debate"><Num value={inv.maxDebateCompanies} min={1} max={10} onChange={(n) => up((d) => void (d.investment.maxDebateCompanies = n))} /></Field>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={inv.userTickersOnly} onChange={(e) => up((d) => void (d.investment.userTickersOnly = e.target.checked))} /> Analizar solo los tickers importados (sin descubrimiento automático)</label>
          <div className="mt-3 space-y-2">
            <Field label="Importar tickers desde CSV" hint="Una fila por ticker. Columnas opcionales: precio, fecha (AAAA-MM-DD) — esos precios quedan NO VERIFICADOS.">
              <textarea className={`${input} h-24 font-mono`} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"ticker,price,price_date\nTICKER1\nTICKER2,100.00,2026-10-15"} />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => importCsv(csv)}>Importar texto</Button>
              <input type="file" accept=".csv,text/csv" aria-label="Archivo CSV" className="text-xs" onChange={async (e) => { const f = e.target.files?.[0]; if (f) importCsv(await f.text()); }} />
              {inv.userTickers.length > 0 && <Button variant="danger" onClick={() => up((d) => { d.investment.userTickers = []; d.investment.userPrices = []; })}>Vaciar lista</Button>}
            </div>
            {csvInfo && <p className="text-xs text-ink-2">{csvInfo}</p>}
            <p className="text-xs text-ink-2">Tickers del usuario ({inv.userTickers.length}): {inv.userTickers.join(", ") || "ninguno"}</p>
          </div>
        </Card>
        <Card title="Proveedores de datos">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Fundamentales y universo"><input className={input} value="SEC EDGAR (XBRL companyfacts, frames, submissions)" disabled /></Field>
            <Field label="Precios" hint="Stooq: gratuito, retrasado. Alpha Vantage: requiere clave gratuita.">
              <select className={input} value={s.priceProvider} onChange={(e) => up((d) => void (d.priceProvider = e.target.value as AppSettings["priceProvider"]))}><option value="stooq">Stooq (retrasado)</option><option value="alphavantage">Alpha Vantage + Stooq</option><option value="manual">Solo precios del usuario (no verificados)</option></select>
            </Field>
            <Field label="Divisa EUR/USD"><select className={input} value={s.fxProvider} onChange={(e) => up((d) => void (d.fxProvider = e.target.value as AppSettings["fxProvider"]))}><option value="ecb">BCE (oficial)</option><option value="none">Desactivado</option></select></Field>
            <Field label="Frecuencia de actualización" hint="Las sesiones se lanzan manualmente; la caché de la SEC dura 12 h."><select className={input} value={s.refreshFrequency} onChange={(e) => up((d) => void (d.refreshFrequency = e.target.value as AppSettings["refreshFrequency"]))}><option value="manual">Manual</option><option value="daily">Diaria (caché)</option><option value="weekly">Semanal (caché)</option></select></Field>
          </div>
        </Card>
        <Card title="Tabla de precios de modelos (USD por millón de tokens)">
          <p className="mb-2 text-xs text-ink-2">{s.pricingNote}. Se usa para estimar costes y aplicar el presupuesto; actualícela si cambian las tarifas. Sin precio no se puede iniciar una sesión real con ese modelo.</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead><tr className="text-left text-[11px] uppercase text-ink-3"><th>Modelo</th><th>Entrada</th><th>Salida</th><th>Escritura caché</th><th>Lectura caché</th><th></th></tr></thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m}>
                    <td className="pr-2 font-mono text-xs">{m}</td>
                    {(["inputPerMTok", "outputPerMTok", "cacheWritePerMTok", "cacheReadPerMTok"] as const).map((k) => (
                      <td key={k} className="pr-2"><Num value={s.pricing[m][k]} step={0.01} min={0} onChange={(n) => up((d) => void (d.pricing[m][k] = n))} /></td>
                    ))}
                    <td><button className="text-xs text-ink-3 hover:text-ink" onClick={() => up((d) => void delete d.pricing[m])} disabled={m === s.model || m === s.debateModel} title="Eliminar">✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex gap-2">
            <input className={input} placeholder="id de modelo, p.ej. claude-sonnet-5-5" value={newModel} onChange={(e) => setNewModel(e.target.value)} />
            <Button onClick={() => { if (newModel.trim()) up((d) => void (d.pricing[newModel.trim()] = { inputPerMTok: 0, outputPerMTok: 0, cacheWritePerMTok: 0, cacheReadPerMTok: 0 })); setNewModel(""); }}>Añadir</Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
