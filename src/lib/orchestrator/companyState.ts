import type { InvestmentConfig } from "../config";
import { listCandidates, listIssues, listReports } from "../db/repo";
import { citationStatus, listEvidence, shortId, type Evidence } from "../evidence/registry";
import { computeScenarios, type ScenarioSetResult } from "../finance/valuation";
import type { VetoState } from "../finance/scoring";
import { totalScore } from "../agents/profiles";
import type { StoredReport, StoredRevision, VetoT } from "../agents/schemas";
import type { z } from "zod";
import type { ValuationBlock } from "../agents/schemas";
import type { AgentRole } from "../types";

type Valuation = z.infer<typeof ValuationBlock>;

export interface RoleView {
  role: AgentRole;
  version: number;
  scores: Record<string, number>;
  total: number;
  conclusion: string;
  valuation: Valuation | null;
}

/** Latest view of one company from one agent (revision if any, otherwise initial report). */
export function latestRoleView(sessionId: string, role: AgentRole, ticker: string): RoleView | null {
  const reps = listReports(sessionId, role).sort((a, b) => b.version - a.version);
  for (const r of reps) {
    if (r.kind === "REVISION") {
      const c = (r.content as StoredRevision).companies.find((x) => x.ticker === ticker);
      if (c) return { role, version: r.version, scores: c.revised_scores, total: c.revised_total, conclusion: c.revised_conclusion, valuation: c.valuation ?? findInitialValuation(sessionId, ticker, role) };
    } else {
      const c = (r.content as StoredReport).companies.find((x) => x.ticker === ticker);
      if (c) return { role, version: r.version, scores: c.scores, total: totalScore(role, c.scores), conclusion: c.provisional_conclusion, valuation: c.valuation ?? null };
    }
  }
  return null;
}

function findInitialValuation(sessionId: string, ticker: string, role: AgentRole): Valuation | null {
  if (role !== "VALUATION") return null;
  const reps = listReports(sessionId, "VALUATION").sort((a, b) => b.version - a.version);
  for (const r of reps) {
    const comps = (r.content as StoredReport | StoredRevision).companies as { ticker: string; valuation?: Valuation | null }[];
    const c = comps.find((x) => x.ticker === ticker && x.valuation);
    if (c?.valuation) return c.valuation;
  }
  return null;
}

/** Current veto state for a ticker: the latest version that mentions it wins; withdrawals must be explicit. */
export function vetoState(sessionId: string, ticker: string): (VetoState & { raw: VetoT; downgraded: boolean })[] {
  const reps = listReports(sessionId, "RISK").sort((a, b) => b.version - a.version);
  for (const r of reps) {
    const vetoes = ((r.content as { vetoes?: VetoT[] }).vetoes ?? []).filter((v) => v.ticker === ticker);
    if (!vetoes.length) continue;
    return vetoes.map((v) => {
      const cites = citationStatus(sessionId, v.evidence_ids);
      const unsupported = v.severity === "critical" && cites.verified.length === 0;
      return {
        severity: unsupported ? "high" : v.severity,
        upheld: v.status === "upheld",
        reason: unsupported ? `${v.reason} (veto crítico degradado a 'alto': sin evidencia verificada)` : v.reason,
        raw: v,
        downgraded: unsupported,
      };
    });
  }
  return [];
}

export function latestVerifiedPriceEvidence(sessionId: string, ticker: string): Evidence | null {
  return listEvidence(sessionId, { ticker, metric: "price" })
    .filter((e) => e.value !== null && e.verification === "VERIFIED")
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))[0] ?? null;
}

const CRITICAL_METRICS = ["revenue", "operatingIncome", "operatingCashFlow", "capex", "dilutedShares"];

export function dataConfidence(sessionId: string, ticker: string): { score: number; critical: Record<string, boolean>; citations: { verified: number; total: number } } {
  const ev = listEvidence(sessionId, { ticker });
  const critical: Record<string, boolean> = { price: Boolean(latestVerifiedPriceEvidence(sessionId, ticker)) };
  for (const m of CRITICAL_METRICS) critical[m] = ev.some((e) => e.metric === m && e.verification === "VERIFIED" && e.value !== null);
  const critFrac = Object.values(critical).filter(Boolean).length / Object.keys(critical).length;
  let verified = 0;
  let total = 0;
  for (const role of ["QUALITY", "VALUATION"] as AgentRole[]) {
    const r = listReports(sessionId, role).find((x) => x.version === 1);
    const c = (r?.content as StoredReport | undefined)?.companies.find((x) => x.ticker === ticker);
    for (const m of c?.metrics ?? []) {
      total++;
      if (m.evidence_id && citationStatus(sessionId, [m.evidence_id]).verified.length) verified++;
    }
  }
  const citeFrac = total ? verified / total : 0;
  return { score: 0.7 * critFrac + 0.3 * citeFrac, critical, citations: { verified, total } };
}

export interface CompanySnapshot {
  ticker: string;
  name: string | null;
  sector: string | null;
  synthetic: boolean;
  views: Partial<Record<AgentRole, RoleView>>;
  price: { value: number; asOf: string | null; kind: string | null; evidenceId: string; source: string } | null;
  scenarios: ScenarioSetResult | null;
  vetoes: ReturnType<typeof vetoState>;
  confidence: ReturnType<typeof dataConfidence>;
  issues: { open: number; criticalOpen: number; resolved: number; documented: number };
}

export function companySnapshot(sessionId: string, ticker: string, config: InvestmentConfig): CompanySnapshot {
  const cand = listCandidates(sessionId).find((c) => c.ticker === ticker);
  const views: Partial<Record<AgentRole, RoleView>> = {};
  for (const role of ["QUALITY", "VALUATION", "RISK", "CIO"] as AgentRole[]) {
    const v = latestRoleView(sessionId, role, ticker);
    if (v) views[role] = v;
  }
  const priceEv = latestVerifiedPriceEvidence(sessionId, ticker);
  const val = views.VALUATION?.valuation ?? null;
  const scenarios = val
    ? computeScenarios({
        referencePrice: priceEv?.value ?? null,
        years: config.horizonYears,
        discountRate: val.discount_rate,
        target: config.targetAnnualReturn,
        requiredMos: config.requiredMarginOfSafety,
        scenarios: Object.fromEntries((["bear", "base", "bull"] as const).map((k) => [k, {
          metric: val.scenarios[k].metric,
          metricYearN: val.scenarios[k].metric_year_n,
          exitMultiple: val.scenarios[k].exit_multiple,
          cumulativeDividendsPerShare: val.scenarios[k].cumulative_dividends_per_share,
          rationale: val.scenarios[k].rationale,
        }])),
      })
    : null;
  const issues = listIssues(sessionId, { ticker });
  const openSt = ["OPEN", "VERIFYING", "PENDING"];
  return {
    ticker,
    name: cand?.name ?? null,
    sector: cand?.sector ?? null,
    synthetic: cand?.synthetic ?? false,
    views,
    price: priceEv ? { value: priceEv.value!, asOf: priceEv.publishedAt, kind: priceEv.priceKind, evidenceId: shortId(priceEv.id), source: priceEv.source } : null,
    scenarios,
    vetoes: vetoState(sessionId, ticker),
    confidence: dataConfidence(sessionId, ticker),
    issues: {
      open: issues.filter((i) => openSt.includes(i.status) && (i.kind === "FACTUAL_DISPUTE" || i.kind === "DATA_CONFLICT")).length,
      criticalOpen: issues.filter((i) => openSt.includes(i.status) && i.critical && (i.kind === "FACTUAL_DISPUTE" || i.kind === "DATA_CONFLICT")).length,
      resolved: issues.filter((i) => i.status === "RESOLVED").length,
      documented: issues.filter((i) => i.status === "DOCUMENTED").length,
    },
  };
}
