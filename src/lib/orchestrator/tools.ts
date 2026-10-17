import { z } from "zod";
import type { AppSettings } from "../config";
import { addAgentNote, insertCalculation, listCandidates } from "../db/repo";
import { addEvidence, getEvidence, listEvidence, shortId, type Evidence } from "../evidence/registry";
import { deriveMetrics, type AnnualFinancials, type DerivedMetric } from "../finance/fundamentals";
import { computeScenarios, dcf, dcfSensitivity, multiples } from "../finance/valuation";
import type { ToolUnion } from "../llm/adapter";
import { pointOnOrBefore, type CompanyRef, type MarketData, type PriceHistory, type Quote } from "../market-data/types";
import { extractSection, htmlToParagraphs, rankPassages, SECTIONS, type SectionKey } from "../market-data/filings";
import { assertPublicHttpsUrl, fetchText } from "../security/net";
import type { AgentRole } from "../types";
import { toInputSchema } from "../agents/schemas";

export interface ToolContext {
  sessionId: string;
  role: AgentRole;
  phase: string;
  /** true while round 1 is open: evidence created by other agents is hidden. */
  round1: boolean;
  md: MarketData;
  settings: AppSettings;
  fetchImpl?: typeof fetch;
}

interface ToolDef<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<string>;
}

const untrusted = (s: string) => `<untrusted_data>\n${s}\n</untrusted_data>`;
const T = z.string().min(1).max(12).transform((s) => s.toUpperCase());

/* ------------------------------ helpers ----------------------------- */

const refCache = new WeakMap<MarketData, Promise<CompanyRef[]>>();

async function resolveTicker(ctx: ToolContext, ticker: string): Promise<CompanyRef | null> {
  const c = listCandidates(ctx.sessionId).find((x) => x.ticker === ticker && x.cik);
  if (c) return { ticker, cik: c.cik!, name: c.name ?? ticker, exchange: c.exchange };
  if (!refCache.has(ctx.md)) refCache.set(ctx.md, ctx.md.reference.listCompanies().then((r) => r.data).catch(() => []));
  const list = await refCache.get(ctx.md)!;
  return list.find((x) => x.ticker === ticker) ?? null;
}

function visibleEvidence(ctx: ToolContext, e: Evidence) {
  if (!ctx.round1) return true;
  return e.createdBy.startsWith("system:") || e.createdBy === `agent:${ctx.role}`;
}

function fmt(v: number | null, unit: string | null) {
  if (v === null) return "n/d";
  if (unit === "ratio") return `${(v * 100).toFixed(1)}%`;
  if (unit === "USD" && Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)} M USD`;
  if (unit === "shares" && v >= 1e6) return `${(v / 1e6).toFixed(2)} M acciones`;
  return `${Number(v.toFixed(4))} ${unit ?? ""}`;
}

function latestVerifiedPrice(ctx: ToolContext, ticker: string): Evidence | null {
  const prices = listEvidence(ctx.sessionId, { ticker, metric: "price" }).filter((e) => e.value !== null);
  const verified = prices.filter((e) => e.verification === "VERIFIED");
  return (verified.length ? verified : []).sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))[0] ?? null;
}

function latestMetric(ctx: ToolContext, ticker: string, metric: string): Evidence | null {
  const list = listEvidence(ctx.sessionId, { ticker, metric }).filter((e) => e.value !== null && e.verification !== "CONFLICT" && visibleEvidence(ctx, e));
  return list.sort((a, b) => (b.fiscalYear ?? 0) - (a.fiscalYear ?? 0) || (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))[0] ?? null;
}

/* ------------------------- shared data loaders ----------------------- */

function defineTool<S extends z.ZodType>(d: ToolDef<S>): ToolDef<S> {
  return d;
}

export function asOfDate(ctx: ToolContext): string | null {
  return ctx.md.asOf ?? ctx.settings.investment.asOfDate ?? null;
}

const historyCache = new WeakMap<MarketData, Map<string, Promise<PriceHistory | null>>>();

export async function priceHistory(ctx: ToolContext, ticker: string): Promise<PriceHistory | null> {
  if (!historyCache.has(ctx.md)) historyCache.set(ctx.md, new Map());
  const m = historyCache.get(ctx.md)!;
  if (!m.has(ticker)) {
    m.set(ticker, (async () => {
      for (const p of ctx.md.history) {
        const h = await p.history(ticker).catch(() => null);
        if (h?.points.length) return h;
      }
      return null;
    })());
  }
  return m.get(ticker)!;
}

/** A second source's quote for the same ticker, used to corroborate the reference price. */
export interface Corroboration {
  source: string;
  price: number;
  asOf: string;
  /** Relative difference vs. the reference price. */
  diff: number;
}

/** Above this relative gap between two sources the price is flagged as a data conflict. */
export const PRICE_TOLERANCE = 0.02;

/**
 * Reference quote: the latest quote (first provider that answers, checked
 * against the next one), or — in point-in-time mode — the historical close
 * on/before the analysis date.
 */
export async function referenceQuote(ctx: ToolContext, ticker: string): Promise<{ q: Quote; providerId: string; corroboration?: Corroboration | null } | null> {
  const asOf = asOfDate(ctx);
  if (asOf) {
    const h = await priceHistory(ctx, ticker);
    const p = h ? pointOnOrBefore(h, asOf, h.frequency === "monthly" ? 35 : 10) : null;
    if (!h || !p) return null;
    return {
      providerId: "history",
      q: { ticker, price: p.close, currency: "USD", asOf: p.date, kind: "CLOSE", delayNote: `Cierre histórico (${h.frequency === "monthly" ? "mensual" : "diario"}) a la fecha de análisis ${asOf}. ${h.note}`, source: h.source, url: h.url, retrievedAt: h.retrievedAt },
    };
  }
  const providers = ctx.md.prices;
  for (let i = 0; i < providers.length; i++) {
    const q = await providers[i].quote(ticker).catch(() => null);
    if (!q) continue;
    if (q.kind === "USER_SUPPLIED") return { q, providerId: providers[i].id, corroboration: null };
    for (const other of providers.slice(i + 1)) {
      const c = await other.quote(ticker).catch(() => null);
      if (!c || c.kind === "USER_SUPPLIED") continue;
      return { q, providerId: providers[i].id, corroboration: { source: c.source, price: c.price, asOf: c.asOf, diff: Math.abs(c.price - q.price) / q.price } };
    }
    return { q, providerId: providers[i].id, corroboration: null };
  }
  return null;
}

export function registerQuote(ctx: ToolContext, ticker: string, r: { q: Quote; providerId: string; corroboration?: Corroboration | null }): Evidence {
  const q = r.q;
  const userSupplied = q.kind === "USER_SUPPLIED";
  const c = r.corroboration;
  // Two independent public sources that agree → high confidence; a gap is kept visible, never averaged away.
  const confidence = userSupplied ? "LOW" : c && c.diff <= PRICE_TOLERANCE ? "HIGH" : c ? "LOW" : "MEDIUM";
  const reason = c
    ? `${q.delayNote} Contrastado con ${c.source}: ${c.price} USD (${c.asOf}), diferencia ${(c.diff * 100).toFixed(2)} %${c.diff > PRICE_TOLERANCE ? " — DISCREPANCIA entre fuentes" : ""}.`
    : `${q.delayNote}${userSupplied ? "" : " Sin segunda fuente para contrastar."}`;
  return addEvidence(ctx.sessionId, {
    ticker, metric: "price", value: q.price, unit: "USD/share", period: q.asOf, periodType: "POINT", publishedAt: q.asOf, retrievedAt: q.retrievedAt,
    source: q.source, url: q.url || null, dataType: userSupplied ? "UNVERIFIED" : "REPORTED", verification: userSupplied || !q.url ? "UNVERIFIED" : "VERIFIED",
    priceKind: q.kind, confidence, confidenceReason: reason, createdBy: userSupplied ? "user:csv" : `system:${r.providerId}`, synthetic: ctx.md.synthetic,
  });
}

const FIN_KEYS = ["revenue", "grossProfit", "operatingIncome", "netIncome", "operatingCashFlow", "capex", "dilutedShares", "epsDiluted", "longTermDebt", "cash", "equity", "dividendsPaid", "buybacks", "acquisitions", "stockComp", "pretaxIncome", "incomeTax"] as const;

export interface LoadedFinancials {
  ref: CompanyRef;
  years: AnnualFinancials[];
  derived: (DerivedMetric & { evidenceId: string })[];
  lines: string[];
}

/** Loads annual 10-K data (point-in-time aware), registers every datapoint and the derived metrics as evidence. */
export async function loadFinancials(ctx: ToolContext, ticker: string): Promise<LoadedFinancials | string> {
  const ref = await resolveTicker(ctx, ticker);
  if (!ref) return `No se encontró ${ticker} en la lista de emisores. No se inventan datos.`;
  const asOf = asOfDate(ctx);
  const facts = await ctx.md.fundamentals.annualFacts(ref.cik, { asOf });
  const years = Array.from(new Set(facts.data.map((f) => f.fiscalYear))).sort((a, b) => b - a).slice(0, 6);
  if (!years.length) return `La SEC no tiene datos XBRL anuales para ${ticker}${asOf ? ` presentados antes de ${asOf}` : ""}.`;
  const recent = new Set(years.slice(0, 3));
  const byYear = new Map<number, AnnualFinancials>();
  const lines: string[] = [`Fuente: ${facts.source} — ${facts.url} (recuperado ${facts.retrievedAt})`, `Ejercicios fiscales (por fecha de cierre): ${years.join(", ")}`];
  for (const f of facts.data) {
    if (!years.includes(f.fiscalYear)) continue;
    const longHistory = ["revenue", "dilutedShares", "epsDiluted", "operatingIncome", "netIncome", "operatingCashFlow", "capex", "longTermDebt", "cash"].includes(f.key);
    if (!recent.has(f.fiscalYear) && !longHistory && f.key !== "acquisitions") continue;
    const ev = addEvidence(ctx.sessionId, {
      ticker, company: ref.name, metric: f.key, value: f.value, unit: f.unit, period: `FY${f.fiscalYear}`, periodType: "FY",
      fiscalYear: f.fiscalYear, basis: "GAAP", publishedAt: f.filed, retrievedAt: facts.retrievedAt,
      source: `${facts.source}; concepto ${f.concept}; ${f.form} acc. ${f.accession}`, url: f.url, dataType: "REPORTED",
      verification: "VERIFIED", confidence: "HIGH", confidenceReason: "Dato XBRL del 10-K obtenido directamente de la SEC por la aplicación",
      createdBy: "system:sec", synthetic: ctx.md.synthetic,
    });
    const af = byYear.get(f.fiscalYear) ?? ({ fiscalYear: f.fiscalYear, periodEnd: f.periodEnd, evidence: {} } as AnnualFinancials);
    if (f.periodStart) af.periodEnd = f.periodEnd; // fiscal-year end comes from duration facts
    (af as unknown as Record<string, unknown>)[f.key] = f.value;
    af.evidence[f.key] = ev.id;
    byYear.set(f.fiscalYear, af);
  }
  const all = [...byYear.values()].map((y) => {
    for (const k of FIN_KEYS) if (!(k in y)) (y as unknown as Record<string, unknown>)[k] = null; // missing ≠ zero
    return y;
  });
  for (const y of [...all].sort((a, b) => b.fiscalYear - a.fiscalYear)) {
    const parts = FIN_KEYS.filter((k) => y[k] !== null).map((k) => `${k}=${fmt(y[k] as number, k === "dilutedShares" ? "shares" : k === "epsDiluted" ? "USD/share" : "USD")} [${shortId(y.evidence[k])}]`);
    const missing = FIN_KEYS.filter((k) => y[k] === null);
    lines.push(`FY${y.fiscalYear}: ${parts.join("; ")}${missing.length ? ` | sin dato: ${missing.join(", ")}` : ""}`);
  }
  const derived: LoadedFinancials["derived"] = [];
  lines.push("Métricas calculadas por la aplicación:");
  for (const d of deriveMetrics(all)) {
    const inputs = d.inputs.map((i) => getEvidence(ctx.sessionId, i)).filter(Boolean) as Evidence[];
    const ev = addEvidence(ctx.sessionId, {
      ticker, company: ref.name, metric: d.metric, value: d.value, unit: d.unit, period: d.fiscalYear ? `FY${d.fiscalYear}` : null, periodType: "FY",
      fiscalYear: d.fiscalYear, basis: "GAAP", source: "Motor de cálculo ATLAS", url: inputs[0]?.url ?? null, dataType: "CALCULATED",
      verification: d.value !== null && inputs.length && inputs.every((i) => i.verification === "VERIFIED") ? "VERIFIED" : "UNVERIFIED",
      formula: d.formula, inputs: d.inputs, confidence: d.confidence, confidenceReason: d.confidenceReason, createdBy: "system:engine", synthetic: ctx.md.synthetic,
    });
    derived.push({ ...d, evidenceId: ev.id });
    lines.push(`- ${d.metric} = ${fmt(d.value, d.unit)} [${shortId(ev.id)}] (${d.formula}; confianza ${d.confidence}: ${d.confidenceReason})`);
  }
  return { ref, years: all.sort((a, b) => a.fiscalYear - b.fiscalYear), derived, lines };
}

/* ------------------------------- tools ------------------------------ */

const getFinancials = defineTool({
  name: "get_company_financials",
  description:
    "Obtiene datos anuales reportados (10-K, XBRL de SEC EDGAR) de los últimos ejercicios y métricas derivadas calculadas por la aplicación. Registra cada dato en el registro de evidencias y devuelve sus identificadores EV-n. En modo histórico solo usa presentaciones anteriores a la fecha de análisis.",
  schema: z.object({ ticker: T }),
  async run({ ticker }, ctx) {
    const r = await loadFinancials(ctx, ticker);
    return typeof r === "string" ? r : r.lines.join("\n");
  },
});

const getPrice = defineTool({
  name: "get_price",
  description: "Obtiene la cotización de referencia verificable (con fecha, hora y tipo: cierre, retrasada o tiempo real; en modo histórico, el cierre a la fecha de análisis) y la registra como evidencia.",
  schema: z.object({ ticker: T }),
  async run({ ticker }, ctx) {
    const r = await referenceQuote(ctx, ticker);
    if (!r) return `No se pudo obtener una cotización verificable para ${ticker} con los proveedores configurados. No uses un precio no verificado como referencia.`;
    const q = r.q;
    const ev = registerQuote(ctx, ticker, r);
    const shares = latestMetric(ctx, ticker, "sharesOutstanding") ?? latestMetric(ctx, ticker, "dilutedShares");
    let mc = "";
    if (shares?.value) {
      const mcEv = addEvidence(ctx.sessionId, {
        ticker, metric: "market_cap", value: q.price * shares.value, unit: "USD", period: q.asOf, periodType: "POINT", publishedAt: q.asOf,
        source: "Motor de cálculo ATLAS", url: q.url || null, dataType: "CALCULATED", verification: ev.verification === "VERIFIED" && shares.verification === "VERIFIED" ? "VERIFIED" : "UNVERIFIED",
        formula: `precio × ${shares.metric}`, inputs: [ev.id, shares.id], confidence: "MEDIUM", confidenceReason: "Acciones de portada o medias diluidas; puede diferir de la capitalización oficial",
        createdBy: "system:engine", synthetic: ctx.md.synthetic,
      });
      mc = `\nCapitalización aproximada: ${fmt(mcEv.value, "USD")} [${shortId(mcEv.id)}]`;
    }
    return `${ticker}: ${q.price} USD (${q.kind}) a ${q.asOf} — ${q.source}. ${ev.confidenceReason} [${shortId(ev.id)}; ${ev.verification}; confianza ${ev.confidence}]${mc}`;
  },
});

const getFx = defineTool({
  name: "get_fx_rate",
  description: "Tipo de cambio EUR/USD de referencia del BCE (USD por 1 EUR), registrado como evidencia. En modo histórico, el de la fecha de análisis.",
  schema: z.object({}),
  async run(_i, ctx) {
    if (!ctx.md.fx) return "Proveedor de divisas desactivado: no se puede convertir a EUR.";
    const asOf = asOfDate(ctx);
    const r = asOf ? await ctx.md.fx.usdPerEurOn?.(asOf) ?? null : await ctx.md.fx.usdPerEur();
    if (!r) return "No se pudo obtener el tipo de cambio: la rentabilidad en EUR no se calculará.";
    const ev = addEvidence(ctx.sessionId, {
      ticker: null, metric: "fx_usd_per_eur", value: r.usdPerEur, unit: "USD/EUR", period: r.date, periodType: "POINT", publishedAt: r.date, retrievedAt: r.retrievedAt,
      source: r.source, url: r.url, dataType: "REPORTED", verification: "VERIFIED", confidence: "HIGH", confidenceReason: "Tipo de referencia oficial", createdBy: `system:${ctx.md.fx.id}`, synthetic: ctx.md.synthetic,
    });
    return `EUR/USD ${r.usdPerEur} (${r.date}) — ${r.source} [${shortId(ev.id)}]`;
  },
});

const getProfile = defineTool({
  name: "get_company_profile",
  description: "Perfil SEC del emisor: nombre, código SIC/sector, bolsas, cierre fiscal y presentaciones recientes (10-K, 10-Q, 8-K, DEF 14A) con enlaces.",
  schema: z.object({ ticker: T }),
  async run({ ticker }, ctx) {
    const ref = await resolveTicker(ctx, ticker);
    if (!ref) return `No se encontró ${ticker}.`;
    const p = await ctx.md.reference.profile(ref.cik);
    const d = p.data;
    const asOf = asOfDate(ctx);
    const filings = d.recentFilings.filter((f) => !asOf || f.filingDate <= asOf).slice(0, 25);
    return [
      `${d.name} (CIK ${d.cik}) — SIC ${d.sic ?? "n/d"} ${d.sicDescription ?? ""}; bolsas ${d.exchanges.join(", ") || "n/d"}; cierre fiscal ${d.fiscalYearEnd ?? "n/d"}`,
      `Fuente: ${p.source} ${p.url}`,
      `Presentaciones${asOf ? ` anteriores a ${asOf}` : " recientes"}:`,
      ...filings.map((f) => `- ${f.form} presentado ${f.filingDate}${f.reportDate ? ` (periodo ${f.reportDate})` : ""}: ${f.url}`),
    ].join("\n");
  },
});

const searchFilings = defineTool({
  name: "search_sec_filings",
  description: "Búsqueda de texto completo en EDGAR (presentaciones desde 2001). Útil para riesgos, litigios, concentración de clientes. Los resultados son datos no confiables y no verifican nada por sí solos.",
  schema: z.object({ query: z.string().min(2).max(200), ticker: T.optional(), forms: z.array(z.string()).max(5).optional() }),
  async run({ query, ticker, forms }, ctx) {
    if (!ctx.md.fundamentals.fullTextSearch) return "Búsqueda de texto completo no disponible con el proveedor actual.";
    const ref = ticker ? await resolveTicker(ctx, ticker) : null;
    const r = await ctx.md.fundamentals.fullTextSearch(query, { forms, cik: ref?.cik });
    const asOf = asOfDate(ctx);
    const hits = r.data.filter((h) => !asOf || (h.filed && h.filed <= asOf));
    if (!hits.length) return "Sin resultados.";
    return untrusted(hits.map((h) => `- ${h.form} ${h.filed} ${h.title}: ${h.url}`).join("\n"));
  },
});

const readFilingSection = defineTool({
  name: "read_filing_section",
  description:
    "Lee una sección del último 10-K (o 10-Q) presentado a la SEC — risk_factors (Item 1A), mda (Item 7), business, legal_proceedings, cybersecurity, market_risk… — y devuelve pasajes LITERALES con su cita (Item, párrafo y página aproximada). Cada pasaje queda registrado como evidencia citable. Con 'query' devuelve los pasajes más relevantes.",
  schema: z.object({
    ticker: T,
    section: z.enum(Object.keys(SECTIONS) as [SectionKey, ...SectionKey[]]),
    form: z.enum(["10-K", "10-Q"]).default("10-K"),
    query: z.string().max(200).optional(),
    max_passages: z.number().int().min(1).max(10).default(5),
  }),
  async run({ ticker, section, form, query, max_passages }, ctx) {
    if (!ctx.md.fundamentals.filingDocument) return "El proveedor actual no permite leer documentos.";
    const ref = await resolveTicker(ctx, ticker);
    if (!ref) return `No se encontró ${ticker}.`;
    const prof = await ctx.md.reference.profile(ref.cik);
    const asOf = asOfDate(ctx);
    const filing = prof.data.recentFilings.find((f) => f.form === form && f.documentUrl && (!asOf || f.filingDate <= asOf));
    if (!filing) return `No hay un ${form} disponible${asOf ? ` presentado antes de ${asOf}` : ""} para ${ticker}.`;
    const doc = await ctx.md.fundamentals.filingDocument(filing.documentUrl!);
    const paras = htmlToParagraphs(doc.data);
    const body = extractSection(paras, section);
    if (!body.length) return `No se localizó la sección ${SECTIONS[section].label} en ${filing.documentUrl}. No se inventa su contenido.`;
    const picks = rankPassages(body, query, max_passages);
    if (!picks.length) return `La sección ${SECTIONS[section].label} no contiene pasajes que coincidan con la consulta.`;
    const out = [`${form} presentado ${filing.filingDate}${filing.reportDate ? ` (periodo ${filing.reportDate})` : ""} — ${SECTIONS[section].label} — ${doc.url}`];
    for (const p of picks) {
      const rel = p.index - body[0].index + 1;
      const cite = `${form} ${filing.reportDate ?? filing.filingDate} · ${SECTIONS[section].label} ¶${rel} · pág. ≈${p.page}`;
      const ev = addEvidence(ctx.sessionId, {
        ticker, company: ref.name, metric: `filing:${section}`, value: null, valueText: p.text.slice(0, 1500), unit: null, period: cite, periodType: "NA",
        publishedAt: filing.filingDate, retrievedAt: doc.retrievedAt, source: `${doc.source}: ${form} acc. ${filing.accession}`, url: doc.url, dataType: "REPORTED",
        verification: "VERIFIED", confidence: "HIGH", confidenceReason: "Texto literal del documento presentado a la SEC; la página es aproximada (marcas de salto de página del HTML)",
        createdBy: "system:sec-filing", synthetic: ctx.md.synthetic,
      });
      out.push(`[${shortId(ev.id)}] ${cite}\n${p.text.slice(0, 1500)}`);
    }
    return untrusted(out.join("\n\n"));
  },
});

const getHistoricalValuation = defineTool({
  name: "get_historical_valuation",
  description:
    "Múltiplos históricos calculados por la aplicación al cierre de cada ejercicio fiscal (PER, EV/EBIT, P/FCF) con precios históricos públicos y datos del 10-K, más rango mín/mediana/máx. Útil para comparar la valoración actual con la propia historia de la empresa.",
  schema: z.object({ ticker: T }),
  async run({ ticker }, ctx) {
    const fin = await loadFinancials(ctx, ticker);
    if (typeof fin === "string") return fin;
    const h = await priceHistory(ctx, ticker);
    if (!h) return `No hay histórico de precios disponible para ${ticker}: no se calculan múltiplos históricos.`;
    const rows: string[] = [];
    const series: Record<string, number[]> = { pe: [], ev_ebit: [], p_fcf: [] };
    for (const y of fin.years) {
      if (!y.periodEnd) continue;
      const p = pointOnOrBefore(h, y.periodEnd, h.frequency === "monthly" ? 35 : 10);
      if (!p) {
        rows.push(`FY${y.fiscalYear}: sin precio de cierre cercano a ${y.periodEnd}`);
        continue;
      }
      const priceEv = addEvidence(ctx.sessionId, {
        ticker, metric: "price_history_close", value: p.close, unit: "USD/share", period: p.date, periodType: "POINT", publishedAt: p.date, retrievedAt: h.retrievedAt,
        source: h.source, url: h.url, dataType: "REPORTED", verification: "VERIFIED", priceKind: "CLOSE", confidence: h.adjustment === "unknown" ? "MEDIUM" : "HIGH",
        confidenceReason: h.note, createdBy: `system:${h.source.startsWith("DATOS SINT") ? "synthetic" : "history"}`, synthetic: ctx.md.synthetic,
      });
      const mcap = y.dilutedShares !== null ? p.close * y.dilutedShares : null;
      const fcf = y.operatingCashFlow !== null && y.capex !== null ? y.operatingCashFlow - Math.abs(y.capex) : null;
      const ev = mcap !== null && y.longTermDebt !== null && y.cash !== null ? mcap + y.longTermDebt - y.cash : null;
      const vals = {
        pe: multiples.pe(p.close, y.epsDiluted),
        ev_ebit: multiples.evToEbit(ev, y.operatingIncome),
        p_fcf: mcap !== null && fcf !== null && fcf > 0 ? mcap / fcf : null,
      };
      const parts: string[] = [];
      for (const [k, v] of Object.entries(vals)) {
        if (v === null) {
          parts.push(`${k}=n/d`);
          continue;
        }
        series[k].push(v);
        const e = addEvidence(ctx.sessionId, {
          ticker, metric: `hist_${k}`, value: v, unit: "x", period: `FY${y.fiscalYear}`, periodType: "FY", fiscalYear: y.fiscalYear, basis: "GAAP", source: "Motor de cálculo ATLAS",
          url: h.url, dataType: "CALCULATED", verification: "VERIFIED",
          formula: k === "pe" ? "cierre al fin del ejercicio / BPA diluido" : k === "ev_ebit" ? "(cierre × acciones diluidas + deuda LP − efectivo) / resultado operativo" : "(cierre × acciones diluidas) / (FCO − capex)",
          inputs: [priceEv.id, ...Object.values(y.evidence)].slice(0, 8), confidence: "MEDIUM", confidenceReason: "Acciones medias diluidas y deuda LP; precio histórico de fuente pública", createdBy: "system:engine", synthetic: ctx.md.synthetic,
        });
        parts.push(`${k}=${v.toFixed(1)}x [${shortId(e.id)}]`);
      }
      rows.push(`FY${y.fiscalYear} (cierre ${p.date}: ${p.close} USD [${shortId(priceEv.id)}]): ${parts.join(", ")}`);
    }
    const stats = Object.entries(series).map(([k, v]) => {
      if (!v.length) return `${k}: sin datos`;
      const s = [...v].sort((a, b) => a - b);
      return `${k}: mín ${s[0].toFixed(1)}x · mediana ${s[Math.floor(s.length / 2)].toFixed(1)}x · máx ${s[s.length - 1].toFixed(1)}x (n=${s.length})`;
    });
    return [`Fuente de precios: ${h.source} — ${h.note}`, ...rows, "Rango histórico:", ...stats].join("\n");
  },
});

const getPeerComparables = defineTool({
  name: "get_peer_comparables",
  description:
    "Tabla de comparables calculada por la aplicación con los mismos criterios para la empresa y los competidores que indiques (máx. 6): margen operativo, crecimiento de ingresos 3a, ROIC aprox., PER, EV/EBIT y rentabilidad FCF, más la mediana de los competidores. Señala comparaciones con ejercicios fiscales desalineados.",
  schema: z.object({ ticker: T, peers: z.array(T).min(1).max(6) }),
  async run({ ticker, peers }, ctx) {
    const all = [ticker, ...peers.filter((p) => p !== ticker)];
    const rows: { t: string; endMonth: number | null; m: Record<string, number | null>; ids: string[] }[] = [];
    const notes: string[] = [];
    for (const t of all) {
      const fin = await loadFinancials(ctx, t);
      if (typeof fin === "string") {
        notes.push(`${t}: ${fin}`);
        continue;
      }
      const last = fin.years[fin.years.length - 1];
      const d = (k: string) => fin.derived.find((x) => x.metric === k);
      const qr = await referenceQuote(ctx, t);
      const priceEv = qr ? registerQuote(ctx, t, qr) : null;
      const price = priceEv?.verification === "VERIFIED" ? priceEv.value : null;
      const mcap = price !== null && last.dilutedShares !== null ? price * last.dilutedShares : null;
      const ev = mcap !== null && last.longTermDebt !== null && last.cash !== null ? mcap + last.longTermDebt - last.cash : null;
      const fcf = d("free_cash_flow")?.value ?? null;
      rows.push({
        t,
        endMonth: last.periodEnd ? new Date(last.periodEnd).getUTCMonth() + 1 : null,
        ids: [priceEv ? shortId(priceEv.id) : "sin precio", ...["operating_margin", "revenue_cagr_3y", "roic_approx"].map((k) => (d(k) ? shortId(d(k)!.evidenceId) : "-"))],
        m: {
          fy: last.fiscalYear,
          operating_margin: d("operating_margin")?.value ?? null,
          revenue_cagr_3y: d("revenue_cagr_3y")?.value ?? null,
          roic_approx: d("roic_approx")?.value ?? null,
          pe: multiples.pe(price, last.epsDiluted),
          ev_ebit: multiples.evToEbit(ev, last.operatingIncome),
          fcf_yield: multiples.fcfYield(fcf, mcap),
        },
      });
    }
    if (!rows.length) return notes.join("\n");
    const base = rows.find((r) => r.t === ticker);
    const pct = (v: number | null) => (v === null ? "n/d" : `${(v * 100).toFixed(1)}%`);
    const x = (v: number | null) => (v === null ? "n/d" : `${v.toFixed(1)}x`);
    const line = (r: (typeof rows)[number]) => `${r.t} (FY${r.m.fy}, cierre mes ${r.endMonth ?? "?"}): margen op. ${pct(r.m.operating_margin)} · CAGR ingresos 3a ${pct(r.m.revenue_cagr_3y)} · ROIC≈ ${pct(r.m.roic_approx)} · PER ${x(r.m.pe)} · EV/EBIT ${x(r.m.ev_ebit)} · FCF yield ${pct(r.m.fcf_yield)} [${r.ids.join(", ")}]`;
    const peersRows = rows.filter((r) => r.t !== ticker);
    const median = (k: string) => {
      const v = peersRows.map((r) => r.m[k]).filter((y): y is number => y !== null).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    };
    const misaligned = base?.endMonth ? peersRows.filter((r) => r.endMonth && Math.min(Math.abs(r.endMonth - base.endMonth!), 12 - Math.abs(r.endMonth - base.endMonth!)) > 2).map((r) => r.t) : [];
    insertCalculation({ sessionId: ctx.sessionId, ticker, kind: `peer_comparables:${ctx.role}`, formula: "Mismas fórmulas para todas las empresas: último FY reportado y precio de referencia verificado", inputs: { peers }, outputs: rows });
    return [
      ...rows.map(line),
      `Mediana de competidores: margen op. ${pct(median("operating_margin"))} · CAGR 3a ${pct(median("revenue_cagr_3y"))} · PER ${x(median("pe"))} · EV/EBIT ${x(median("ev_ebit"))} · FCF yield ${pct(median("fcf_yield"))}`,
      misaligned.length ? `AVISO: ejercicios fiscales desalineados (>2 meses) en ${misaligned.join(", ")}: compare con cautela.` : "",
      ...notes,
      "La elección de competidores es tuya: justifícala en tu informe.",
    ].filter(Boolean).join("\n");
  },
});

function normalise(s: string) {
  return s.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").toLowerCase().trim();
}

const verifySource: ToolDef<z.ZodObject<{
  url: z.ZodString; quote: z.ZodString; ticker: z.ZodNullable<typeof T>; metric: z.ZodString; value: z.ZodNullable<z.ZodNumber>; unit: z.ZodNullable<z.ZodString>; period: z.ZodNullable<z.ZodString>;
}>> = {
  name: "verify_source",
  description:
    "Abre una URL pública https y comprueba que contiene literalmente el fragmento citado (quote). Solo si lo encuentra registra la afirmación como VERIFIED. Si no puede abrirla queda UNREACHABLE; si no encuentra el texto, UNVERIFIED.",
  schema: z.object({
    url: z.string().url(), quote: z.string().min(8).max(400), ticker: T.nullable(), metric: z.string().min(1), value: z.number().nullable(), unit: z.string().nullable(), period: z.string().nullable(),
  }),
  async run(i, ctx) {
    const base = { ticker: i.ticker, metric: i.metric, value: i.value, unit: i.unit, period: i.period, periodType: "NA" as const, url: i.url, dataType: "REPORTED" as const, valueText: i.quote.slice(0, 400), synthetic: ctx.md.synthetic };
    if (ctx.md.synthetic) return "Modo demostración: verify_source no abre páginas reales. Usa las evidencias sintéticas existentes.";
    try {
      await assertPublicHttpsUrl(i.url);
    } catch (e) {
      const ev = addEvidence(ctx.sessionId, { ...base, source: "verify_source (URL rechazada)", verification: "UNREACHABLE", confidence: "LOW", confidenceReason: (e as Error).message, createdBy: `agent:${ctx.role}` });
      return `URL rechazada: ${(e as Error).message} [${shortId(ev.id)}; UNREACHABLE]`;
    }
    const ua = process.env.SEC_USER_AGENT?.trim();
    const res = await fetchText(i.url, { fetchImpl: ctx.fetchImpl, headers: ua ? { "User-Agent": ua } : {} });
    if (!res.ok) {
      const ev = addEvidence(ctx.sessionId, { ...base, source: `verify_source HTTP ${res.status}`, verification: "UNREACHABLE", confidence: "LOW", confidenceReason: res.error ?? `HTTP ${res.status}`, createdBy: `agent:${ctx.role}` });
      return `No se pudo abrir la fuente (${res.error ?? "HTTP " + res.status}). Estado: UNREACHABLE [${shortId(ev.id)}]`;
    }
    const found = normalise(res.text).includes(normalise(i.quote));
    let numberNote = "";
    if (found && i.value !== null) {
      const digits = String(Math.abs(i.value)).replace(/\D/g, "").replace(/0+$/, "").slice(0, 4);
      numberNote = digits && i.quote.replace(/\D/g, "").includes(digits) ? " El número aparece en la cita." : " AVISO: el valor numérico no aparece en la cita; confianza baja.";
    }
    const ev = addEvidence(ctx.sessionId, {
      ...base,
      source: `verify_source: ${new URL(i.url).hostname}`,
      verification: found ? "VERIFIED" : "UNVERIFIED",
      confidence: found ? (numberNote.includes("AVISO") ? "LOW" : "MEDIUM") : "LOW",
      confidenceReason: found ? `Fragmento localizado en la fuente.${numberNote}` : "El fragmento citado no aparece en la página recuperada",
      createdBy: found ? "system:verify-source" : `agent:${ctx.role}`,
      publishedAt: null,
    });
    return `${found ? "VERIFICADO: el fragmento aparece en la fuente." + numberNote : "NO VERIFICADO: el fragmento no aparece en la página."}${res.truncated ? " (página truncada)" : ""} [${shortId(ev.id)}]`;
  },
};

const recordClaim: ToolDef<z.ZodObject<{
  ticker: z.ZodNullable<typeof T>; metric: z.ZodString; value: z.ZodNullable<z.ZodNumber>; unit: z.ZodString; period: z.ZodString; period_type: z.ZodEnum<{ FY: "FY"; Q: "Q"; TTM: "TTM"; POINT: "POINT"; NA: "NA" }>;
  basis: z.ZodEnum<{ GAAP: "GAAP"; NON_GAAP: "NON_GAAP"; NA: "NA" }>; data_type: z.ZodEnum<{ ESTIMATED: "ESTIMATED"; UNVERIFIED: "UNVERIFIED" }>; source: z.ZodString; url: z.ZodNullable<z.ZodString>; note: z.ZodString;
}>> = {
  name: "record_claim",
  description: "Registra una estimación propia o un dato que no has podido verificar. Siempre queda como NO VERIFICADO; úsalo para que la cifra sea trazable.",
  schema: z.object({
    ticker: T.nullable(), metric: z.string().min(1), value: z.number().nullable(), unit: z.string(), period: z.string(), period_type: z.enum(["FY", "Q", "TTM", "POINT", "NA"]),
    basis: z.enum(["GAAP", "NON_GAAP", "NA"]), data_type: z.enum(["ESTIMATED", "UNVERIFIED"]), source: z.string(), url: z.string().nullable(), note: z.string(),
  }),
  async run(i, ctx) {
    const ev = addEvidence(ctx.sessionId, {
      ticker: i.ticker, metric: i.metric, value: i.value, unit: i.unit, period: i.period, periodType: i.period_type, basis: i.basis, source: `${ctx.role}: ${i.source}`, url: i.url,
      dataType: i.data_type, verification: "UNVERIFIED", confidence: "LOW", confidenceReason: i.note, createdBy: `agent:${ctx.role}`, synthetic: ctx.md.synthetic,
    });
    return `Registrado como ${i.data_type}/UNVERIFIED [${shortId(ev.id)}]`;
  },
};

const getEvidenceTool: ToolDef<z.ZodObject<{ ticker: z.ZodOptional<typeof T>; metric: z.ZodOptional<z.ZodString> }>> = {
  name: "get_evidence",
  description: "Consulta el registro de evidencias (id, valor, periodo, fuente, estado de verificación).",
  schema: z.object({ ticker: T.optional(), metric: z.string().optional() }),
  async run(i, ctx) {
    const list = listEvidence(ctx.sessionId, { ticker: i.ticker, metric: i.metric }).filter((e) => visibleEvidence(ctx, e)).slice(-60);
    if (!list.length) return "Sin evidencias para ese filtro.";
    return list.map((e) => `${shortId(e.id)} ${e.ticker ?? "-"} ${e.metric}=${fmt(e.value, e.unit)} ${e.period ?? ""} ${e.dataType}/${e.verification} ${e.source}${e.formula ? ` (fórmula: ${e.formula})` : ""}`).join("\n");
  },
};

const ScenarioIn = z.object({
  metric: z.enum(["EPS", "FCF_PER_SHARE"]), metric_year_n: z.number().nullable(), exit_multiple: z.number().nullable(), cumulative_dividends_per_share: z.number().nullable(), rationale: z.string().default(""),
});

const computeValuation: ToolDef<z.ZodObject<{ ticker: typeof T; discount_rate: z.ZodNumber; scenarios: z.ZodObject<{ bear: typeof ScenarioIn; base: typeof ScenarioIn; bull: typeof ScenarioIn }> }>> = {
  name: "compute_valuation",
  description:
    "Motor determinista: a partir de tus hipótesis por escenario calcula valor en el año N, CAGR (precio y total con dividendos), valor razonable actual, precio máximo compatible con el objetivo, precio de entrada y margen de seguridad, usando el último precio VERIFICADO del registro.",
  schema: z.object({ ticker: T, discount_rate: z.number().min(0.03).max(0.25), scenarios: z.object({ bear: ScenarioIn, base: ScenarioIn, bull: ScenarioIn }) }),
  async run(i, ctx) {
    const inv = ctx.settings.investment;
    const price = latestVerifiedPrice(ctx, i.ticker);
    const map = (s: z.infer<typeof ScenarioIn>) => ({ metric: s.metric, metricYearN: s.metric_year_n, exitMultiple: s.exit_multiple, cumulativeDividendsPerShare: s.cumulative_dividends_per_share, rationale: s.rationale });
    const r = computeScenarios({
      referencePrice: price?.value ?? null, years: inv.horizonYears, discountRate: i.discount_rate, target: inv.targetAnnualReturn, requiredMos: inv.requiredMarginOfSafety,
      scenarios: { bear: map(i.scenarios.bear), base: map(i.scenarios.base), bull: map(i.scenarios.bull) },
    });
    insertCalculation({ sessionId: ctx.sessionId, ticker: i.ticker, kind: `scenario_valuation:${ctx.role}`, formula: r.formula, inputs: { ...i, priceEvidence: price?.id ?? null }, outputs: r });
    return JSON.stringify({ ...r, referencePriceEvidence: price ? shortId(price.id) : null, note: price ? undefined : "Sin precio verificado: no hay CAGR ni margen de seguridad" }, null, 1);
  },
};

const computeDcf: ToolDef<z.ZodObject<{ ticker: typeof T; growth: z.ZodNumber; terminal_growth: z.ZodNumber; discount_rate: z.ZodNumber; years: z.ZodDefault<z.ZodNumber> }>> = {
  name: "compute_dcf",
  description: "DCF determinista con el último FCF, deuda neta y acciones del registro de evidencias, más una tabla de sensibilidad (tasa de descuento ±1 pp, crecimiento ±2 pp).",
  schema: z.object({ ticker: T, growth: z.number().min(-0.3).max(0.5), terminal_growth: z.number().min(-0.02).max(0.05), discount_rate: z.number().min(0.03).max(0.25), years: z.number().int().min(3).max(15).default(10) }),
  async run(i, ctx) {
    const fcf = latestMetric(ctx, i.ticker, "free_cash_flow");
    const nd = latestMetric(ctx, i.ticker, "net_debt");
    const sh = latestMetric(ctx, i.ticker, "dilutedShares");
    const missing = [!fcf && "free_cash_flow", !nd && "net_debt", !sh && "dilutedShares"].filter(Boolean);
    if (missing.length) return `Faltan datos para el DCF (${missing.join(", ")}). Llama antes a get_company_financials. No se devuelve una cifra.`;
    const input = { fcf0: fcf!.value, growth: i.growth, years: i.years, terminalGrowth: i.terminal_growth, discountRate: i.discount_rate, netDebt: nd!.value, sharesOutstanding: sh!.value };
    const r = dcf(input);
    if (!r) return "El DCF no es aplicable con estos datos (FCF ≤ 0 o tasa ≤ crecimiento terminal).";
    const sens = dcfSensitivity(input);
    insertCalculation({ sessionId: ctx.sessionId, ticker: i.ticker, kind: `dcf:${ctx.role}`, formula: r.formula, inputs: { ...input, evidence: [fcf!.id, nd!.id, sh!.id] }, outputs: { ...r, sensitivity: sens } });
    return JSON.stringify({ ...r, inputsEvidence: [shortId(fcf!.id), shortId(nd!.id), shortId(sh!.id)], sensitivity: sens }, null, 1);
  },
};

const saveNote: ToolDef<z.ZodObject<{ note: z.ZodString }>> = {
  name: "save_note",
  description: "Guarda una nota en tu memoria de trabajo privada (no la ven los demás agentes).",
  schema: z.object({ note: z.string().min(1).max(2000) }),
  async run({ note }, ctx) {
    addAgentNote(ctx.sessionId, ctx.role, note);
    return "Nota guardada.";
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DATA_TOOLS: ToolDef<any>[] = [getFinancials, getPrice, getFx, getProfile, searchFilings, readFilingSection, getHistoricalValuation, getPeerComparables, verifySource, recordClaim, getEvidenceTool, computeValuation, computeDcf, saveNote];

export function toolDefinitions(names?: string[]): ToolUnion[] {
  return DATA_TOOLS.filter((t) => !names || names.includes(t.name)).map((t) => ({ name: t.name, description: t.description, input_schema: toInputSchema(t.schema) }));
}

export function webSearchTool(settings: AppSettings): ToolUnion[] {
  return settings.enableWebSearch ? [{ type: "web_search_20260209", name: "web_search", max_uses: settings.webSearchMaxUses } as unknown as ToolUnion] : [];
}

/** Execute a data tool. Errors are returned to the model as text (never thrown into the orchestrator). */
export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<{ content: string; isError: boolean }> {
  const t = DATA_TOOLS.find((x) => x.name === name);
  if (!t) return { content: `Herramienta desconocida: ${name}`, isError: true };
  const parsed = t.schema.safeParse(input);
  if (!parsed.success) return { content: `Entrada inválida para ${name}: ${parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.map(String).join(".")}: ${i.message}`).join("; ")}`, isError: true };
  try {
    const out = await t.run(parsed.data, ctx);
    return { content: out.slice(0, 30_000), isError: false };
  } catch (e) {
    return { content: `Error en ${name}: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
}
