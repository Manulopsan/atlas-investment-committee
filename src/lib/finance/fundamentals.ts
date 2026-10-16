import type { AccountingBasis, PeriodType } from "../types";
import { isNum } from "./returns";

/** A single datapoint with the metadata needed to prevent invalid comparisons. */
export interface DataPoint {
  value: number | null;
  unit: string; // "USD", "EUR", "shares", "USD/share", "ratio"
  periodType: PeriodType;
  fiscalYear: number | null;
  periodEnd: string | null;
  basis: AccountingBasis;
  evidenceId?: string;
}

export class IncompatibleDataError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "IncompatibleDataError";
  }
}

/** Throws if two datapoints cannot be combined in one formula. */
export function assertCompatible(a: DataPoint, b: DataPoint, opts: { samePeriod: boolean; sameUnit: boolean }): void {
  if (a.periodType !== b.periodType) {
    throw new IncompatibleDataError(`Periodos incompatibles: ${a.periodType} vs ${b.periodType} (no se mezclan cifras trimestrales y anuales)`);
  }
  if (opts.samePeriod && (a.fiscalYear !== b.fiscalYear || (a.periodEnd && b.periodEnd && a.periodEnd !== b.periodEnd))) {
    throw new IncompatibleDataError(`Ejercicios fiscales distintos: ${a.fiscalYear}/${a.periodEnd} vs ${b.fiscalYear}/${b.periodEnd}`);
  }
  if (opts.sameUnit && a.unit !== b.unit) {
    throw new IncompatibleDataError(`Unidades/monedas distintas: ${a.unit} vs ${b.unit} (no se mezclan USD y EUR sin conversión)`);
  }
  if (a.basis !== "NA" && b.basis !== "NA" && a.basis !== b.basis) {
    throw new IncompatibleDataError(`No se mezclan cifras GAAP y non-GAAP (${a.basis} vs ${b.basis})`);
  }
}

export function ratio(num: DataPoint, den: DataPoint): number | null {
  assertCompatible(num, den, { samePeriod: true, sameUnit: true });
  if (!isNum(num.value) || !isNum(den.value) || den.value === 0) return null;
  return num.value / den.value;
}

export function difference(a: DataPoint, b: DataPoint): number | null {
  assertCompatible(a, b, { samePeriod: true, sameUnit: true });
  if (!isNum(a.value) || !isNum(b.value)) return null;
  return a.value - b.value;
}

/** Growth CAGR between two annual datapoints of the same metric, N fiscal years apart. */
export function growthCagr(start: DataPoint, end: DataPoint): number | null {
  assertCompatible(start, end, { samePeriod: false, sameUnit: true });
  if (start.periodType !== "FY") throw new IncompatibleDataError("El crecimiento plurianual requiere datos anuales (FY)");
  if (!isNum(start.value) || !isNum(end.value) || !isNum(start.fiscalYear) || !isNum(end.fiscalYear)) return null;
  const years = end.fiscalYear - start.fiscalYear;
  if (years <= 0 || start.value <= 0 || end.value < 0) return null;
  return Math.pow(end.value / start.value, 1 / years) - 1;
}

export interface AnnualFinancials {
  fiscalYear: number;
  periodEnd: string | null;
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  operatingCashFlow: number | null;
  capex: number | null;
  dilutedShares: number | null;
  longTermDebt: number | null;
  cash: number | null;
  equity: number | null;
  incomeTax: number | null;
  pretaxIncome: number | null;
  dividendsPaid: number | null;
  buybacks: number | null;
  acquisitions: number | null;
  stockComp: number | null;
  epsDiluted: number | null;
  evidence: Record<string, string>;
}

export interface DerivedMetric {
  metric: string;
  value: number | null;
  unit: string;
  fiscalYear: number | null;
  formula: string;
  inputs: string[]; // evidence ids
  confidence: "HIGH" | "MEDIUM" | "LOW";
  confidenceReason: string;
}

function ev(f: AnnualFinancials, ...keys: string[]): string[] {
  return keys.map((k) => f.evidence[k]).filter(Boolean);
}

/** Derived metrics from consecutive annual (10-K) financials, sorted ascending by fiscal year. */
export function deriveMetrics(years: AnnualFinancials[]): DerivedMetric[] {
  const out: DerivedMetric[] = [];
  if (!years.length) return out;
  const sorted = [...years].sort((a, b) => a.fiscalYear - b.fiscalYear);
  const last = sorted[sorted.length - 1];
  const fy = last.fiscalYear;
  const push = (m: Omit<DerivedMetric, "fiscalYear"> & { fiscalYear?: number | null }) =>
    out.push({ fiscalYear: fy, ...m });

  const safeDiv = (a: number | null, b: number | null) => (isNum(a) && isNum(b) && b !== 0 ? a / b : null);

  push({
    metric: "gross_margin", value: safeDiv(last.grossProfit, last.revenue), unit: "ratio",
    formula: "Beneficio bruto / Ingresos (mismo FY)", inputs: ev(last, "grossProfit", "revenue"),
    confidence: "HIGH", confidenceReason: "Ambos datos reportados en el mismo 10-K",
  });
  push({
    metric: "operating_margin", value: safeDiv(last.operatingIncome, last.revenue), unit: "ratio",
    formula: "Resultado operativo / Ingresos (mismo FY)", inputs: ev(last, "operatingIncome", "revenue"),
    confidence: "HIGH", confidenceReason: "Ambos datos reportados en el mismo 10-K",
  });
  const fcf = isNum(last.operatingCashFlow) && isNum(last.capex) ? last.operatingCashFlow - Math.abs(last.capex) : null;
  push({
    metric: "free_cash_flow", value: fcf, unit: "USD",
    formula: "Flujo de caja operativo − inversiones en inmovilizado (capex)", inputs: ev(last, "operatingCashFlow", "capex"),
    confidence: "HIGH", confidenceReason: "Calculado con datos GAAP reportados del mismo ejercicio",
  });
  push({
    metric: "fcf_margin", value: safeDiv(fcf, last.revenue), unit: "ratio",
    formula: "FCF / Ingresos", inputs: ev(last, "operatingCashFlow", "capex", "revenue"),
    confidence: "HIGH", confidenceReason: "Datos del mismo 10-K",
  });
  push({
    metric: "fcf_per_share", value: safeDiv(fcf, last.dilutedShares), unit: "USD/share",
    formula: "FCF / acciones diluidas medias", inputs: ev(last, "operatingCashFlow", "capex", "dilutedShares"),
    confidence: "MEDIUM", confidenceReason: "Acciones medias ponderadas, no acciones a cierre",
  });
  push({
    metric: "net_debt", value: isNum(last.longTermDebt) && isNum(last.cash) ? last.longTermDebt - last.cash : null, unit: "USD",
    formula: "Deuda a largo plazo − efectivo y equivalentes", inputs: ev(last, "longTermDebt", "cash"),
    confidence: "MEDIUM", confidenceReason: "No incluye deuda a corto plazo ni arrendamientos si no se reportan en la etiqueta usada",
  });
  // ROIC approximation (documented, MEDIUM/LOW confidence).
  const taxRate = safeDiv(last.incomeTax, last.pretaxIncome);
  const effTax = isNum(taxRate) && taxRate >= 0 && taxRate <= 0.5 ? taxRate : null;
  const investedCapital = isNum(last.equity) && isNum(last.longTermDebt) && isNum(last.cash)
    ? last.equity + last.longTermDebt - last.cash : null;
  const roic = isNum(last.operatingIncome) && isNum(effTax) && isNum(investedCapital) && investedCapital > 0
    ? (last.operatingIncome * (1 - effTax)) / investedCapital : null;
  push({
    metric: "roic_approx", value: roic, unit: "ratio",
    formula: "EBIT × (1 − tasa fiscal efectiva) / (patrimonio + deuda LP − efectivo)",
    inputs: ev(last, "operatingIncome", "incomeTax", "pretaxIncome", "equity", "longTermDebt", "cash"),
    confidence: roic === null ? "LOW" : "MEDIUM",
    confidenceReason: "Aproximación: no ajusta fondo de comercio, arrendamientos ni partidas extraordinarias",
  });

  const findYear = (y: number) => sorted.find((s) => s.fiscalYear === y);
  for (const n of [3, 5]) {
    const start = findYear(fy - n);
    const g = start && isNum(start.revenue) && isNum(last.revenue) && start.revenue > 0
      ? Math.pow(last.revenue / start.revenue, 1 / n) - 1 : null;
    push({
      metric: `revenue_cagr_${n}y`, value: g, unit: "ratio",
      formula: `(Ingresos FY${fy} / Ingresos FY${fy - n})^(1/${n}) − 1`,
      inputs: [...(start ? ev(start, "revenue") : []), ...ev(last, "revenue")],
      confidence: g === null ? "LOW" : "HIGH",
      confidenceReason: g === null ? `Falta el ingreso de FY${fy - n}` : "Ingresos anuales reportados en 10-K",
    });
    const sStart = start?.dilutedShares;
    const dil = isNum(sStart) && isNum(last.dilutedShares) && sStart > 0 ? last.dilutedShares / sStart - 1 : null;
    push({
      metric: `share_count_change_${n}y`, value: dil, unit: "ratio",
      formula: `Acciones diluidas FY${fy} / FY${fy - n} − 1 (positivo = dilución)`,
      inputs: [...(start ? ev(start, "dilutedShares") : []), ...ev(last, "dilutedShares")],
      confidence: dil === null ? "LOW" : "HIGH", confidenceReason: dil === null ? "Datos insuficientes" : "Datos reportados",
    });
  }
  const acq = sorted.slice(-3).map((s) => s.acquisitions).filter(isNum);
  const rev3 = sorted.slice(-3).map((s) => s.revenue).filter(isNum);
  push({
    metric: "acquisitions_to_revenue_3y", value: acq.length && rev3.length === 3 ? acq.reduce((a, b) => a + b, 0) / rev3.reduce((a, b) => a + b, 0) : null,
    unit: "ratio", formula: "Σ pagos por adquisiciones 3 años / Σ ingresos 3 años (proxy de crecimiento inorgánico)",
    inputs: sorted.slice(-3).flatMap((s) => ev(s, "acquisitions", "revenue")),
    confidence: "LOW", confidenceReason: "Proxy: la ausencia de la etiqueta no implica cero adquisiciones",
  });
  return out;
}
