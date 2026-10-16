"use client";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Bar, BarChart, ReferenceLine, Cell, LabelList } from "recharts";
import { PROFILES } from "@/lib/agents/profiles";
import { ROLE_LABELS, type AgentRole } from "@/lib/types";

const axis = { stroke: "var(--ink-3)", fontSize: 11, tickLine: false };
const tooltipStyle = { background: "var(--surface-1)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--ink)", fontSize: 12 };

export interface ScorePoint {
  stage: string;
  QUALITY?: number | null;
  VALUATION?: number | null;
  RISK?: number | null;
  CIO?: number | null;
}

/** Score evolution per agent (one line per agent, fixed colour per agent). */
export function ScoreEvolution({ data, height = 220 }: { data: ScorePoint[]; height?: number }) {
  const roles = (["QUALITY", "VALUATION", "RISK", "CIO"] as AgentRole[]).filter((r) => data.some((d) => typeof d[r] === "number"));
  return (
    <figure>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="stage" {...axis} />
          <YAxis domain={[0, 100]} {...axis} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v: unknown, name: unknown) => [typeof v === "number" ? v.toFixed(1) : "n/d", ROLE_LABELS[name as AgentRole] + (name === "RISK" ? " (alto = más riesgo)" : "")]} />
          <Legend itemSorter={(item) => ["QUALITY", "VALUATION", "RISK", "CIO"].indexOf(String(item.dataKey))} formatter={(v: string) => <span style={{ color: "var(--ink-2)", fontSize: 12 }}>{ROLE_LABELS[v as AgentRole]}{v === "RISK" ? " (alto = peor)" : ""}</span>} />
          {roles.map((r) => (
            <Line key={r} dataKey={r} stroke={PROFILES[r].color} strokeWidth={2} dot={{ r: 4, strokeWidth: 2, stroke: "var(--surface-1)", fill: PROFILES[r].color }} activeDot={{ r: 6 }} connectNulls isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
      <figcaption className="sr-only">Evolución de las puntuaciones de cada agente por versión del informe</figcaption>
    </figure>
  );
}

/** Annualised total return per scenario against the target (reference line). */
export function ScenarioBars({ bear, base, bull, target, height = 200 }: { bear: number | null; base: number | null; bull: number | null; target: number; height?: number }) {
  const data = [
    { name: "Bajista", v: bear },
    { name: "Base", v: base },
    { name: "Alcista", v: bull },
  ].map((d) => ({ ...d, pct: typeof d.v === "number" ? d.v * 100 : null }));
  if (data.every((d) => d.pct === null)) return <p className="text-sm text-ink-2">Escenarios sin datos suficientes (no se muestra ninguna cifra).</p>;
  return (
    <figure>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 18, right: 16, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="name" {...axis} />
          <YAxis {...axis} unit="%" />
          <Tooltip contentStyle={tooltipStyle} formatter={(v: unknown) => [typeof v === "number" ? `${v.toFixed(1)}%/año` : "n/d", "CAGR total estimado"]} cursor={{ fill: "var(--surface-2)" }} />
          <ReferenceLine y={0} stroke="var(--ink-3)" />
          <ReferenceLine y={target * 100} stroke="var(--ink-2)" strokeDasharray="4 4" />
          <Bar dataKey="pct" radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.name} fill="var(--accent)" />
            ))}
            <LabelList dataKey="pct" position="top" formatter={(v: unknown) => (typeof v === "number" ? `${v.toFixed(1)}%` : "n/d")} style={{ fill: "var(--ink)", fontSize: 11 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <figcaption className="text-[11px] text-ink-3">Línea discontinua: objetivo {(target * 100).toFixed(0)}% anual. CAGR total (precio + dividendos) calculado por el motor a partir de las hipótesis del Valuation Analyst. No es una garantía.</figcaption>
    </figure>
  );
}
