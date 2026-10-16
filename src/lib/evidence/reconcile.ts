import { listEvidence, shortId, type Evidence } from "./registry";

/**
 * Detects figures written in free text by the agents (percentages, money
 * amounts, multiples) and checks whether each one is backed by a value in the
 * evidence registry for the same company. Unmatched figures are not errors per
 * se (they may be explicit assumptions), but they are surfaced as
 * "no conciliadas" so nothing reads as verified when it is not.
 */
export interface ExtractedFigure {
  raw: string;
  kind: "pct" | "money" | "multiple";
  value: number; // pct as ratio (0.24), money in USD, multiple as number
}

export interface Reconciliation {
  matched: { raw: string; evidenceId: string; metric: string; verified: boolean }[];
  unmatched: { raw: string; kind: ExtractedFigure["kind"]; note: string }[];
}

function num(s: string): number {
  // Accept "24,5" / "24.5" / "1,234.5" / "1.234,5".
  const t = s.trim();
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) return Number(t.replace(/\./g, "").replace(",", "."));
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ""));
  return Number(t.replace(",", "."));
}

const SCALES: [RegExp, number][] = [
  [/^(billion|bn|b|mil millones|mm|bill)$/i, 1e9],
  [/^(million|millones|mill|m|mn)$/i, 1e6],
  [/^(thousand|miles|k)$/i, 1e3],
  [/^(trillion|billones)$/i, 1e12],
];

export function extractFigures(text: string): ExtractedFigure[] {
  const out: ExtractedFigure[] = [];
  const seen = new Set<string>();
  const push = (f: ExtractedFigure) => {
    const k = `${f.kind}:${f.raw}`;
    if (!seen.has(k) && Number.isFinite(f.value)) {
      seen.add(k);
      out.push(f);
    }
  };
  for (const m of text.matchAll(/(-?\d+(?:[.,]\d+)?)\s?%/g)) push({ raw: m[0].trim(), kind: "pct", value: num(m[1]) / 100 });
  for (const m of text.matchAll(/(?:US\$|\$|USD\s?)\s?(\d[\d.,]*)\s?(billion|bn|B|mil millones|million|millones|M|mn|thousand|k)?\b/g)) {
    const scale = m[2] ? SCALES.find(([r]) => r.test(m[2]))?.[1] ?? 1 : 1;
    push({ raw: m[0].trim(), kind: "money", value: num(m[1]) * scale });
  }
  for (const m of text.matchAll(/(\d[\d.,]*)\s?(mil millones|millones|billion|million|bn|M)\s?(?:de\s)?(?:USD|dólares|\$)/g)) {
    const scale = SCALES.find(([r]) => r.test(m[2]))?.[1] ?? 1;
    push({ raw: m[0].trim(), kind: "money", value: num(m[1]) * scale });
  }
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s?x\b/gi)) push({ raw: m[0].trim(), kind: "multiple", value: num(m[1]) });
  return out;
}

function close(a: number, b: number, rel: number, abs = 0) {
  return Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));
}

export function reconcileText(evidence: Evidence[], text: string): Reconciliation {
  const res: Reconciliation = { matched: [], unmatched: [] };
  for (const f of extractFigures(text)) {
    let hit: Evidence | undefined;
    if (f.kind === "pct") hit = evidence.find((e) => e.unit === "ratio" && e.value !== null && close(e.value, f.value, 0.03, 0.006));
    else if (f.kind === "money") hit = evidence.find((e) => e.unit === "USD" && e.value !== null && close(e.value, f.value, 0.03));
    else hit = undefined; // multiples are assumptions or engine outputs, never registry facts
    if (hit) res.matched.push({ raw: f.raw, evidenceId: shortId(hit.id), metric: hit.metric, verified: hit.verification === "VERIFIED" });
    else
      res.unmatched.push({
        raw: f.raw,
        kind: f.kind,
        note: f.kind === "multiple" ? "múltiplo: hipótesis o cálculo, sin dato registrado" : "sin respaldo en el registro de evidencias (puede ser una hipótesis)",
      });
  }
  return res;
}

export function reconcileForTicker(sessionId: string, ticker: string, text: string): Reconciliation {
  return reconcileText(listEvidence(sessionId, { ticker }), text);
}
