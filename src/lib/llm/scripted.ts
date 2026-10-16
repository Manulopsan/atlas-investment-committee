import type Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, ModelAdapter, ModelRequest, ModelResponse } from "./adapter";
import { PROFILES } from "../agents/profiles";
import { SYN_COMPANIES } from "../market-data/synthetic";
import type { AgentRole } from "../types";
import { listEvidence, shortId } from "../evidence/registry";

/**
 * SCRIPTED ADAPTER — demo mode and automated tests only.
 * Produces deterministic, schema-valid agent outputs from the synthetic
 * companies' parameters. It makes real tool calls through the orchestrator
 * (so the tool loop, evidence registry and validation are exercised), but its
 * "opinions" are synthetic and every session using it is labelled DEMO.
 * It never produces evidence about real companies.
 */
export interface ScriptedOptions {
  /** Called for every request (tests capture prompts and count calls). */
  onRequest?: (req: ModelRequest) => void;
  /** Throw for specific task keys (failure injection in tests). */
  failOn?: (req: ModelRequest) => Error | null;
  usage?: { input: number; output: number };
}

type Json = Record<string, unknown>;

function textOf(req: ModelRequest): string {
  return req.messages
    .map((m) => (typeof m.content === "string" ? m.content : (m.content as Anthropic.Beta.BetaContentBlockParam[]).map((b) => ("text" in b ? b.text : "content" in b && typeof b.content === "string" ? b.content : "")).join("\n")))
    .join("\n");
}

function tickersIn(text: string): string[] {
  return Array.from(new Set(text.match(/DEMO-[A-Z]{1,2}\b/g) ?? []));
}

/** Demo only: looks up synthetic evidence ids in the registry for this session. */
let currentSession = "";
function evIdsFor(_text: string, ticker: string, metric?: string): string[] {
  return listEvidence(currentSession, { ticker, metric })
    .filter((e) => e.synthetic && e.verification === "VERIFIED")
    .sort((a, b) => (b.fiscalYear ?? 0) - (a.fiscalYear ?? 0))
    .map((e) => shortId(e.id));
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

function scoresFor(role: AgentRole, t: string, round: number): Record<string, number> {
  const c = SYN_COMPANIES.find((x) => x.ticker === t);
  const profile = PROFILES[role];
  const q = c ? clamp((c.opMargin * 2 + c.growth * 2.5 + c.ocfMargin + (c.cash - c.debt) / (c.revenue0 * 4)) / 1.3, 0.1, 0.97) : 0.5;
  const pe = c ? c.price / ((c.revenue0 * c.opMargin * 0.78) / c.shares) : 20;
  const cheap = clamp(1.25 - pe / 28, 0.05, 0.95);
  const lev = c ? clamp(c.debt / Math.max(c.revenue0 * c.opMargin, 1) / 6, 0, 1) : 0.5;
  const out: Record<string, number> = {};
  for (const k of profile.criteria) {
    let f: number;
    if (role === "QUALITY") f = q;
    else if (role === "VALUATION") f = cheap;
    else if (role === "RISK") f = clamp(0.25 + lev * 0.6 + (1 - q) * 0.25 + (k.key === "valuation_risk" ? (1 - cheap) * 0.4 : 0), 0.05, 0.98);
    else f = k.key === "quality" ? q : k.key === "valuation" ? cheap : k.key === "return_potential" ? cheap * 0.9 : k.key === "risk_solidity" ? 1 - lev : 0.5;
    // Revisions move slightly toward the committee's mean (synthetic "opinion change").
    if (round >= 3 && role !== "CIO") f = f * 0.9 + 0.05;
    out[k.key] = Math.round(f * k.max * 10) / 10;
  }
  return out;
}

function qualityFactor(t: string) {
  return scoresFor("QUALITY", t, 1).competitive_advantages / 20;
}

function valuationFor(t: string, text: string) {
  const c = SYN_COMPANIES.find((x) => x.ticker === t);
  if (!c) return null;
  const fairMultiple = 14 + 12 * qualityFactor(t);
  const eps = (c.revenue0 * c.opMargin * 0.78) / c.shares;
  const g = c.growth;
  const epsY3 = (k: number) => Math.round(eps * Math.pow(1 + g * k, 3) * 100) / 100;
  const divs = Math.round(eps * c.payout * 3 * 100) / 100;
  const priceId = evIdsFor(text, t, "price")[0] ?? null;
  const pe = c.price / eps;
  return {
    discount_rate: 0.09,
    reference_price_evidence_id: priceId,
    scenarios: {
      bear: { metric: "EPS", metric_year_n: epsY3(0.3), exit_multiple: Math.round(Math.min(pe, fairMultiple) * 0.75 * 10) / 10, cumulative_dividends_per_share: divs * 0.8, rationale: "Crecimiento muy inferior y compresión del múltiplo (sintético)" },
      base: { metric: "EPS", metric_year_n: epsY3(1), exit_multiple: Math.round(fairMultiple * 10) / 10, cumulative_dividends_per_share: divs, rationale: "Crecimiento histórico y múltiplo acorde a la calidad (sintético)" },
      bull: { metric: "EPS", metric_year_n: epsY3(1.4), exit_multiple: Math.round(fairMultiple * 1.15 * 10) / 10, cumulative_dividends_per_share: divs * 1.1, rationale: "Aceleración y expansión moderada del múltiplo (sintético)" },
    },
    valuation_view: pe < 15 ? "UNDERVALUED" : pe > 28 ? "OVERVALUED" : "FAIR",
    flags: pe > 28 ? ["EXCELLENT_BUT_EXPENSIVE"] : c.opMargin < 0.06 ? ["CHEAP_LOW_QUALITY"] : [],
  };
}

function metricsFor(t: string, text: string) {
  const ids = (m: string) => evIdsFor(text, t, m)[0] ?? null;
  return [
    { name: "operating_margin", value: null, unit: "ratio", period: "FY2025", evidence_id: ids("operating_margin"), note: "ver registro" },
    { name: "free_cash_flow", value: null, unit: "USD", period: "FY2025", evidence_id: ids("free_cash_flow"), note: "ver registro" },
    { name: "price", value: null, unit: "USD/share", period: "2026-01-02", evidence_id: ids("price"), note: "ver registro" },
  ];
}

function initialReport(role: AgentRole, tickers: string[], text: string): Json {
  const sel = tickers.filter((t) => t !== "DEMO-BK");
  const companies = sel.map((t) => ({
    ticker: t,
    thesis: `[DEMO] Tesis sintética de ${PROFILES[role].name} para ${t}, basada en datos ficticios.`,
    metrics: metricsFor(t, text),
    scores: scoresFor(role, t, 1),
    provisional_conclusion: `[DEMO] Conclusión provisional sintética sobre ${t}.`,
    uncertainties: ["Datos sintéticos de demostración"],
    key_points: [],
    ...(role === "VALUATION" ? { valuation: valuationFor(t, text) } : {}),
  }));
  return {
    executive_summary: `[DEMO] Resumen sintético del ${PROFILES[role].name}. No es un análisis real.`,
    companies,
    sources: [{ title: "Datos sintéticos", url: "synthetic://demo", evidence_id: null }],
    uncertainties: ["Modo demostración"],
    provisional_conclusions: "[DEMO] Conclusiones provisionales sintéticas.",
    ...(role === "RISK"
      ? { vetoes: sel.filter((t) => t === "DEMO-C").map((t) => ({ ticker: t, reason: "Apalancamiento excesivo (deuda / EBIT > 10x) [DEMO]", evidence: "Deuda a largo plazo frente a resultado operativo", source_url: "synthetic://demo", evidence_ids: evIdsFor(text, t, "longTermDebt").slice(0, 1), severity: "critical", status: "upheld" })) }
      : {}),
    ...(role === "CIO" ? { critical_questions: ["[DEMO] ¿Es sostenible el margen operativo?", "[DEMO] ¿El precio descuenta ya el crecimiento?"] } : {}),
  };
}

function lastMessageId(text: string): number | null {
  const ids = Array.from(text.matchAll(/#(\d+) \[R/g)).map((m) => Number(m[1]));
  return ids.length ? ids[ids.length - 1] : null;
}

function submission(name: string, req: ModelRequest, text: string): Json {
  const role = req.meta.role;
  const tickers = tickersIn(text);
  const t = tickers[0] ?? "DEMO-A";
  const others = (["QUALITY", "VALUATION", "RISK", "CIO"] as AgentRole[]).filter((r) => r !== role);
  switch (name) {
    case "submit_initial_report":
      return initialReport(role, tickers, text);
    case "submit_cross_review":
      return {
        strong_arguments: others.map((r) => ({ about_role: r, ticker: t, summary: `[DEMO] Argumento sólido del ${PROFILES[r].name}` })),
        objections: others.map((r, i) => ({ target_role: r, ticker: tickers[i] ?? t, claim: `[DEMO] Objeción sintética al ${PROFILES[r].name}`, evidence: "Registro de evidencias", evidence_ids: [], severity: i === 0 ? "major" : "minor" })),
        potential_factual_errors: role === "RISK" ? [{ target_role: "QUALITY", ticker: "DEMO-A", explanation: "[DEMO] Ingresos FY2025 discutidos", evidence_ids: [], dispute: { metric: "revenue", period: "FY2025", unit: "USD", reported_value: 4.2e9, alternative_value: 4.0e9 } }] : [],
        questionable_assumptions: [],
        open_questions: [{ ticker: t, question: "[DEMO] ¿Qué parte del crecimiento es orgánica?", addressed_to: others[0] }],
        list_changes: { add: [], remove: [] },
        debate_priority: tickers.slice(0, 2),
      };
    case "submit_debate_turn":
      return {
        messages: [{
          to: role === "QUALITY" ? "ALL" : role === "VALUATION" ? "QUALITY" : role === "RISK" ? "VALUATION" : "ALL",
          type: /Paso 4/.test(text) ? "RESPONSE" : role === "QUALITY" ? "ARGUMENT" : "OBJECTION",
          claim: `[DEMO] Intervención sintética del ${PROFILES[role].name} sobre ${t}`,
          evidence: "Datos sintéticos",
          evidence_ids: evIdsFor(text, t, "operating_margin").slice(0, 1),
          question: role === "QUALITY" ? null : "[DEMO] ¿Puede justificarlo con evidencia?",
          expected_outcome: "[DEMO] Aclaración en la revisión",
          in_reply_to: /Paso 4/.test(text) ? lastMessageId(text) : null,
          factual_dispute: null,
        }],
      };
    case "submit_cio_turn":
      return {
        messages: [{ to: "ALL", type: "EVIDENCE_REQUEST", claim: `[DEMO] El CIO resume las controversias de ${t}`, evidence: "Hilo del debate", evidence_ids: [], question: "[DEMO] ¿Se confirma el margen?", expected_outcome: "Verificación documental", in_reply_to: null, factual_dispute: null }],
        controversies: [
          { description: `[DEMO] Crecimiento futuro de ${t}`, kind: "FORECAST", critical: false, assigned_to: "VALUATION", action: "RECALCULATE", dispute: null, alternatives: [{ label: "Hipótesis prudente", proposed_by: "RISK", metric_year_n: 4, exit_multiple: 14, cumulative_dividends_per_share: 1 }, { label: "Hipótesis optimista", proposed_by: "QUALITY", metric_year_n: 6, exit_multiple: 20, cumulative_dividends_per_share: 1 }] },
          { description: `[DEMO] Sostenibilidad de la ventaja competitiva de ${t}`, kind: "JUDGEMENT", critical: false, assigned_to: "QUALITY", action: "RESPOND", dispute: null, alternatives: [] },
        ],
      };
    case "submit_verification": {
      const id = Number(/incidencia #(\d+)/i.exec(text)?.[1] ?? 0);
      const ev = evIdsFor(text, t, "revenue")[0];
      return { issue_id: id, outcome: ev ? "RESOLVED" : "UNRESOLVABLE", corrected_value: null, unit: "USD", evidence_ids: ev ? [ev] : [], explanation: "[DEMO] Comprobado con el registro de evidencias sintético." };
    }
    case "submit_revision": {
      const debated = /EMPRESAS DEBATIDAS: ([^\n]+)/.exec(text)?.[1].split(",").map((x) => x.trim()).filter(Boolean) ?? tickers;
      return {
        executive_summary: `[DEMO] Revisión sintética del ${PROFILES[role].name}`,
        companies: debated.map((tk) => ({
          ticker: tk,
          revised_scores: scoresFor(role, tk, 3),
          revised_conclusion: `[DEMO] Conclusión revisada sobre ${tk}`,
          accepted_arguments: [{ message_id: null, summary: "[DEMO] Argumento aceptado" }],
          rejected_arguments: [],
          new_data: [],
          unresolved: [],
          change_reason: "[DEMO] Ajuste moderado tras el debate",
          ...(role === "VALUATION" ? { valuation: valuationFor(tk, text) } : {}),
        })),
        ...(role === "RISK" ? { vetoes: debated.filter((tk) => tk === "DEMO-C").map((tk) => ({ ticker: tk, reason: "Apalancamiento excesivo [DEMO]", evidence: "Deuda/EBIT", source_url: "synthetic://demo", evidence_ids: evIdsFor(text, tk, "longTermDebt").slice(0, 1), severity: "critical", status: "upheld" })) } : {}),
      };
    }
    case "submit_selective_agenda":
      return { controversies: tickers.slice(0, 1).map((tk) => ({ ticker: tk, question: `[DEMO] ¿El CIO considera que ${tk} cumple el objetivo con prudencia?`, addressed_to: ["VALUATION", "RISK"], category: "NEAR_THRESHOLD", why_decision_relevant: "[DEMO] Retorno cercano al umbral" })) };
    case "submit_selective_answer":
      return { answers: [{ controversy_index: 0, answer: `[DEMO] Respuesta sintética del ${PROFILES[role].name}`, evidence_ids: [], position_changed: false }], revised_companies: [], vetoes: [] };
    case "submit_final_decision":
      return {
        executive_summary: "[DEMO] Decisión final sintética del comité. No constituye una recomendación real.",
        companies: tickers.map((tk) => ({ ticker: tk, catalysts_score: 50, catalysts: [{ description: "[DEMO] Catalizador sintético", verifiable: false, evidence_ids: [] }], proposed_verdict: "POTENTIAL_BUY", rationale: "[DEMO] El motor limitará este veredicto si la evidencia no lo permite.", consensus: ["[DEMO] Consenso sintético"], dissent: ["[DEMO] Discrepancia sintética"], conditions_for_target: ["[DEMO] Mantener el crecimiento histórico"] })),
        portfolio_note: "[DEMO]",
        limitations: ["Sesión de demostración con datos y agentes sintéticos."],
      };
    default:
      return {};
  }
}

export class ScriptedAdapter implements ModelAdapter {
  id = "scripted-demo";
  kind = "scripted" as const;
  calls = 0;
  constructor(private opts: ScriptedOptions = {}) {}

  async create(req: ModelRequest): Promise<ModelResponse> {
    this.calls++;
    currentSession = req.meta.sessionId;
    this.opts.onRequest?.(req);
    const err = this.opts.failOn?.(req);
    if (err) throw err;
    const text = textOf(req);
    const toolNames = req.tools.map((t) => ("name" in t ? t.name : ""));
    const submit = toolNames.find((n) => n.startsWith("submit_"))!;
    const content: ContentBlock[] = [];
    const id = () => `toolu_demo_${Math.random().toString(36).slice(2, 10)}`;
    // Round 1 first iteration: gather data through the real tools.
    if (req.meta.phase === "ROUND_1" && req.meta.iteration === 0 && toolNames.includes("get_company_financials")) {
      for (const t of tickersIn(text).filter((x) => x !== "DEMO-BK")) {
        content.push({ type: "tool_use", id: id(), name: "get_company_financials", input: { ticker: t } } as ContentBlock);
        content.push({ type: "tool_use", id: id(), name: "get_price", input: { ticker: t } } as ContentBlock);
      }
      if (req.meta.role === "VALUATION") content.push({ type: "tool_use", id: id(), name: "get_fx_rate", input: {} } as ContentBlock);
    } else {
      content.push({ type: "tool_use", id: id(), name: submit, input: submission(submit, req, text) } as ContentBlock);
    }
    return {
      content,
      stopReason: "tool_use",
      usage: { input_tokens: this.opts.usage?.input ?? Math.ceil(text.length / 3), output_tokens: this.opts.usage?.output ?? 800, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      model: req.model,
      requestId: null,
    };
  }
}
