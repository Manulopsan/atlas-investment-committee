import { describe, it, expect, beforeEach } from "vitest";
import { parseAnnualFacts, parseFrame, parseTickers, SecEdgarProvider } from "@/lib/market-data/sec";
import { AlphaVantagePriceProvider, EcbFxProvider, StooqPriceProvider } from "@/lib/market-data/prices";
import { classifySic, parseTickerCsv } from "@/lib/market-data";
import { discoverCandidates, screen } from "@/lib/market-data/discovery";
import { syntheticMarketData, SYN_COMPANIES } from "@/lib/market-data/synthetic";
import { InvestmentConfigSchema } from "@/lib/config";
import { freshDb } from "./helpers";

beforeEach(() => freshDb());

describe("SEC EDGAR parsing", () => {
  const facts = {
    facts: {
      "us-gaap": {
        Revenues: {
          units: {
            USD: [
              { val: 1000, start: "2024-01-01", end: "2024-12-31", form: "10-K", fp: "FY", filed: "2025-02-01", accn: "0000000001-25-000001" },
              { val: 1010, start: "2024-01-01", end: "2024-12-31", form: "10-K", fp: "FY", filed: "2026-02-01", accn: "0000000001-26-000001" },
              { val: 260, start: "2024-07-01", end: "2024-09-30", form: "10-Q", fp: "Q3", filed: "2024-11-01", accn: "0000000001-24-000003" },
              { val: 300, start: "2025-10-01", end: "2025-12-31", form: "10-K", fp: "FY", filed: "2026-02-01", accn: "0000000001-26-000001" },
            ],
          },
        },
      },
    },
  };
  it("keeps only full-year 10-K values, latest filing wins, never quarterly values", () => {
    const r = parseAnnualFacts(facts, "0000000001").filter((f) => f.key === "revenue");
    expect(r).toHaveLength(1);
    expect(r[0].value).toBe(1010);
    expect(r[0].fiscalYear).toBe(2024);
    expect(r[0].url).toMatch(/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/1\/000000000126000001\//);
  });
  it("missing concepts produce no record (not zero)", () => {
    expect(parseAnnualFacts(facts, "1").some((f) => f.key === "grossProfit")).toBe(false);
  });
  it("parses tickers and frames", () => {
    const t = parseTickers({ fields: ["cik", "name", "ticker", "exchange"], data: [[320193, "Example Inc", "exm", "Nasdaq"]] });
    expect(t[0]).toEqual({ cik: "0000320193", name: "Example Inc", ticker: "EXM", exchange: "Nasdaq" });
    expect(parseFrame({ data: [{ cik: 1, entityName: "A", val: 5, end: "2025-12-31", accn: "x" }] })[0].cik).toBe("0000000001");
  });
  it("requires a declared User-Agent", async () => {
    await expect(new SecEdgarProvider({ userAgent: "", cacheDir: null }).listCompanies()).rejects.toThrow(/SEC_USER_AGENT/);
  });
  it("sends the User-Agent header", async () => {
    let ua = "";
    const f = (async (_u: string, init?: RequestInit) => {
      ua = (init?.headers as Record<string, string>)["User-Agent"];
      return new Response(JSON.stringify({ fields: ["cik", "name", "ticker", "exchange"], data: [] }));
    }) as unknown as typeof fetch;
    await new SecEdgarProvider({ userAgent: "Atlas test@example.com", fetchImpl: f, cacheDir: null, minIntervalMs: 0 }).listCompanies();
    expect(ua).toBe("Atlas test@example.com");
  });
});

describe("prices and FX", () => {
  it("Stooq CSV: delayed quote with date and time; N/D → null", () => {
    const q = StooqPriceProvider.parse("XYZ", "Symbol,Date,Time,Open,High,Low,Close,Volume\nXYZ.US,2026-10-15,22:00:09,1,2,0.5,1.5,100", "https://stooq.com/x", "2026-10-16T00:00:00Z")!;
    expect(q.price).toBe(1.5);
    expect(q.kind).toBe("DELAYED");
    expect(q.asOf).toBe("2026-10-15T22:00:09");
    expect(StooqPriceProvider.parse("XYZ", "Symbol,Date,Time,Open,High,Low,Close,Volume\nXYZ.US,N/D,N/D,N/D,N/D,N/D,N/D,N/D", "u", "t")).toBeNull();
  });
  it("Alpha Vantage URL never contains the key", () => {
    expect(AlphaVantagePriceProvider.publicUrl("XYZ")).toContain("apikey=REDACTED");
    const q = AlphaVantagePriceProvider.parse("XYZ", { "Global Quote": { "05. price": "10.5", "07. latest trading day": "2026-10-15" } }, "t")!;
    expect(q.kind).toBe("CLOSE");
    expect(q.url).not.toMatch(/apikey=(?!REDACTED)/);
  });
  it("ECB reference rate", () => {
    const r = EcbFxProvider.parse(`<Cube><Cube time='2026-10-15'><Cube currency='USD' rate='1.0921'/></Cube></Cube>`, "t")!;
    expect(r.usdPerEur).toBe(1.0921);
    expect(r.date).toBe("2026-10-15");
    expect(EcbFxProvider.parse("<x/>", "t")).toBeNull();
  });
});

describe("universe and discovery", () => {
  it("CSV import with optional user prices", () => {
    const r = parseTickerCsv("ticker,price,date\nabc\nDEF,10.5,2026-10-01\n???\nabc");
    expect(r.tickers).toEqual(["ABC", "DEF"]);
    expect(r.prices).toEqual([{ ticker: "DEF", price: 10.5, date: "2026-10-01" }]);
    expect(r.rejected).toHaveLength(1);
  });
  it("sector exclusions by SIC", () => {
    expect(classifySic("6022")).toBe("BANKS");
    expect(classifySic("6311")).toBe("INSURANCE");
    expect(classifySic("4813")).toBe("TELECOM");
    expect(classifySic("6770")).toBe("SHELL_COMPANIES");
    expect(classifySic("7372")).toBeNull();
  });
  it("screen never imputes missing metrics", () => {
    const rows = screen({ revenue: [{ cik: "1", entityName: "A", value: 1e9, periodEnd: "", accession: "" }, { cik: "2", entityName: "B", value: 1e9, periodEnd: "", accession: "" }], revenueOld: [{ cik: "1", entityName: "A", value: 7e8, periodEnd: "", accession: "" }], operatingIncome: [{ cik: "1", entityName: "A", value: 2e8, periodEnd: "", accession: "" }, { cik: "2", entityName: "B", value: 2e8, periodEnd: "", accession: "" }], operatingCashFlow: [{ cik: "1", entityName: "A", value: 2e8, periodEnd: "", accession: "" }] }, 2025);
    expect(rows.find((r) => r.cik === "2")!.screenScore).toBeNull();
    expect(rows.find((r) => r.cik === "1")!.screenScore).not.toBeNull();
  });
  it("discovery excludes banks by default and reports coverage honestly", async () => {
    const r = await discoverCandidates(syntheticMarketData(), InvestmentConfigSchema.parse({}), new Date("2026-10-16"));
    const bank = r.candidates.find((c) => c.ticker === "DEMO-BK");
    expect(bank?.included ?? false).toBe(false);
    expect(r.coverage.level).toBe("CANDIDATE_LIST");
    expect(r.candidates.every((c) => c.synthetic)).toBe(true);
    const withBanks = await discoverCandidates(syntheticMarketData(), InvestmentConfigSchema.parse({ excludedSectors: [] }), new Date("2026-10-16"));
    expect(withBanks.candidates.find((c) => c.ticker === "DEMO-BK")?.included).toBe(true);
  });
  it("live discovery without network/User-Agent reports an unverified universe instead of inventing one", async () => {
    const f = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const md = { synthetic: false, reference: new SecEdgarProvider({ userAgent: "x y@z.com", fetchImpl: f, cacheDir: null, minIntervalMs: 0 }), fundamentals: new SecEdgarProvider({ userAgent: "x y@z.com", fetchImpl: f, cacheDir: null, minIntervalMs: 0 }), prices: [], fx: null };
    const r = await discoverCandidates(md, InvestmentConfigSchema.parse({}), new Date("2026-10-16"));
    expect(r.candidates).toHaveLength(0);
    expect(r.coverage.level).toBe("UNVERIFIED_UNIVERSE");
  });
  it("synthetic companies use DEMO- tickers that cannot collide with real symbols", () => {
    expect(SYN_COMPANIES.every((c) => c.ticker.startsWith("DEMO-") && c.name.includes("SINTÉTICO"))).toBe(true);
  });
});
