import type { StoredReport, StoredRevision } from "@/lib/agents/schemas";
import { AGENT_ROLES, type AgentRole } from "@/lib/types";
import type { ScorePoint } from "./charts";
import type { SessionView } from "./types";

type Rep = SessionView["reports"][number];

export function stageOf(r: Rep): string {
  if (r.kind === "INITIAL") return "Inicial";
  return (r.content as StoredRevision).round === 4 ? "R4" : "R3";
}

/** Total score of a ticker in one report version, or null when the agent did not cover it. */
export function totalIn(r: Rep, ticker: string): number | null {
  if (r.kind === "INITIAL") return (r.content as StoredReport).totals?.[ticker] ?? null;
  return (r.content as StoredRevision).companies.find((c) => c.ticker === ticker)?.revised_total ?? null;
}

export function scoreHistory(reports: Rep[], ticker: string): ScorePoint[] {
  const stages = ["Inicial", "R3", "R4"];
  return stages
    .map((stage) => {
      const p: ScorePoint = { stage };
      for (const role of AGENT_ROLES) {
        const r = reports.filter((x) => x.agentRole === role && stageOf(x) === stage).pop();
        if (r) p[role] = totalIn(r, ticker);
      }
      return p;
    })
    .filter((p) => AGENT_ROLES.some((r) => typeof p[r] === "number"));
}

export function tickersOf(v: SessionView): string[] {
  const set = new Set<string>();
  for (const r of v.reports) for (const c of (r.content as { companies?: { ticker: string }[] }).companies ?? []) set.add(c.ticker);
  return [...set].sort();
}

export function opinionChanges(v: SessionView, role: AgentRole) {
  const revs = v.reports.filter((r) => r.agentRole === role && r.kind === "REVISION");
  return revs.flatMap((r) => (r.content as StoredRevision).companies.map((c) => ({ ticker: c.ticker, from: c.original_total, to: c.revised_total, reason: c.change_reason, stage: stageOf(r) })));
}
