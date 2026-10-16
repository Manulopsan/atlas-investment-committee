/**
 * Pure helpers to read the text of SEC filings (10-K / 10-Q HTML).
 * - htmlToParagraphs keeps paragraph boundaries and page-break markers, so a
 *   passage can be cited as "Item 1A ¶12 · pág. ≈23".
 * - extractSection finds the real section body (not the table of contents) by
 *   choosing the heading occurrence that spans the most text.
 * Page numbers are approximate: they count page-break markers in the HTML.
 */
export const SECTIONS = {
  business: { item: "1", label: "Item 1 — Business" },
  risk_factors: { item: "1A", label: "Item 1A — Risk Factors" },
  cybersecurity: { item: "1C", label: "Item 1C — Cybersecurity" },
  properties: { item: "2", label: "Item 2 — Properties" },
  legal_proceedings: { item: "3", label: "Item 3 — Legal Proceedings" },
  mda: { item: "7", label: "Item 7 — MD&A" },
  market_risk: { item: "7A", label: "Item 7A — Market Risk" },
  financial_statements: { item: "8", label: "Item 8 — Financial Statements" },
} as const;
export type SectionKey = keyof typeof SECTIONS;

export interface Paragraph {
  index: number;
  page: number;
  text: string;
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", mdash: "—", ndash: "–", bull: "•", hellip: "…" };

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

export function htmlToParagraphs(html: string): Paragraph[] {
  const PAGE = "\u000c";
  const text = decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, " ")
      .replace(/<[^>]+page-break-(?:before|after)\s*:\s*always[^>]*>/gi, `\n${PAGE}\n`)
      .replace(/<hr[^>]*>/gi, `\n${PAGE}\n`)
      .replace(/<\/(p|div|tr|li|h[1-6]|table|section)>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\r/g, "");
  const out: Paragraph[] = [];
  let page = 1;
  for (const raw of text.split("\n")) {
    if (raw.includes(PAGE)) {
      page += raw.split(PAGE).length - 1;
      continue;
    }
    const t = raw.replace(/[ \t ]+/g, " ").trim();
    if (t) out.push({ index: out.length, page, text: t });
  }
  return out;
}

const HEADING = /^item\s*(1a|1b|1c|7a|9a|9b|1|2|3|4|5|6|7|8|9|10|11|12|13|14|15|16)\b\.?/i;

export function extractSection(paras: Paragraph[], key: SectionKey): Paragraph[] {
  const item = SECTIONS[key].item.toUpperCase();
  const headings = paras.filter((p) => p.text.length < 220 && HEADING.test(p.text));
  let best: Paragraph[] = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (HEADING.exec(h.text)![1].toUpperCase() !== item) continue;
    const next = headings.slice(i + 1).find((x) => HEADING.exec(x.text)![1].toUpperCase() !== item);
    const body = paras.slice(h.index + 1, next ? next.index : paras.length);
    const chars = body.reduce((a, p) => a + p.text.length, 0);
    if (chars > best.reduce((a, p) => a + p.text.length, 0)) best = body;
  }
  return best;
}

function terms(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);
}

/** Top passages of a section for a query (keyword frequency), returned in document order. */
export function rankPassages(section: Paragraph[], query: string | undefined, k: number): Paragraph[] {
  const body = section.filter((p) => p.text.length >= 60);
  if (!query?.trim()) return body.slice(0, k);
  const q = new Set(terms(query));
  const scored = body.map((p) => {
    const ws = terms(p.text);
    const score = ws.reduce((a, w) => a + (q.has(w) ? 1 : 0), 0) / Math.sqrt(ws.length + 1);
    return { p, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.p)
    .sort((a, b) => a.index - b.index);
}
