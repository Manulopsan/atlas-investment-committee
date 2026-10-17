import path from "node:path";
import type { AppSettings, SectorExclusion } from "../config";
import { SecEdgarProvider } from "./sec";
import { AlphaVantageHistoryProvider, AlphaVantagePriceProvider, EcbFxProvider, ManualPriceProvider, NasdaqPriceProvider, NasdaqSnapshotProvider, StooqHistoryProvider, StooqPriceProvider, YahooHistoryProvider, YahooPriceProvider } from "./prices";
import { syntheticMarketData } from "./synthetic";
import type { MarketData, PriceHistoryProvider, PriceProvider } from "./types";
import type { SessionMode } from "../types";

export * from "./types";

/** Builds the provider set for a session. Demo sessions get synthetic data only; live sessions never do. */
export function createMarketData(mode: SessionMode, settings: AppSettings, opts: { fetchImpl?: typeof fetch; userPrices?: { ticker: string; price: number; date: string }[] } = {}): MarketData {
  const asOf = settings.investment.asOfDate ?? null;
  if (mode === "demo") return { ...syntheticMarketData(), asOf };
  const sec = new SecEdgarProvider({
    userAgent: process.env.SEC_USER_AGENT?.trim() || "",
    fetchImpl: opts.fetchImpl,
    cacheDir: path.join(process.cwd(), "data", "cache", "sec"),
  });
  // Order matters: the first provider that answers is the reference, the second corroborates it.
  const prices: PriceProvider[] = [];
  const av = process.env.ALPHAVANTAGE_API_KEY?.trim() || "";
  if (settings.priceProvider === "alphavantage" && av) prices.push(new AlphaVantagePriceProvider(av, opts.fetchImpl));
  if (settings.priceProvider !== "manual") prices.push(new YahooPriceProvider(opts.fetchImpl), new NasdaqPriceProvider(opts.fetchImpl), new StooqPriceProvider(opts.fetchImpl));
  if (opts.userPrices?.length) prices.push(new ManualPriceProvider(opts.userPrices));
  const history: PriceHistoryProvider[] = [new YahooHistoryProvider(opts.fetchImpl)];
  if (av) history.push(new AlphaVantageHistoryProvider(av, opts.fetchImpl));
  history.push(new StooqHistoryProvider(opts.fetchImpl));
  return {
    synthetic: false,
    snapshot: new NasdaqSnapshotProvider(opts.fetchImpl),
    asOf,
    reference: sec,
    fundamentals: sec,
    prices,
    history,
    fx: settings.fxProvider === "ecb" ? new EcbFxProvider(opts.fetchImpl) : null,
  };
}

/** SIC-code based sector exclusions (SEC Standard Industrial Classification). */
export function classifySic(sic: string | null): SectorExclusion | null {
  if (!sic) return null;
  const n = Number(sic);
  if (!Number.isFinite(n)) return null;
  if (n >= 6000 && n <= 6199) return "BANKS"; // depository & non-depository credit institutions
  if (n >= 6300 && n <= 6411) return "INSURANCE";
  if (n >= 4810 && n <= 4899) return "TELECOM";
  if (n === 6770) return "SHELL_COMPANIES"; // blank checks / SPACs
  if (n === 6798) return "REITS"; // real estate investment trusts: FCF and margins are not comparable
  return null;
}

export const EXCLUSION_LABELS: Record<SectorExclusion, string> = {
  BANKS: "Bancos y entidades de crédito",
  INSURANCE: "Aseguradoras",
  TELECOM: "Telecomunicaciones",
  SHELL_COMPANIES: "Sociedades instrumentales / SPAC",
  REITS: "REIT (sociedades de inversión inmobiliaria)",
};

/**
 * CSV import: header optional. Columns: ticker[,price,price_date].
 * Returns normalised tickers and optional user-supplied prices.
 */
export function parseTickerCsv(csv: string): { tickers: string[]; prices: { ticker: string; price: number; date: string }[]; rejected: string[] } {
  const tickers: string[] = [];
  const prices: { ticker: string; price: number; date: string }[] = [];
  const rejected: string[] = [];
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const cols = line.split(/[;,\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    const t = cols[0]?.toUpperCase();
    if (i === 0 && /^(TICKER|SYMBOL|SÍMBOLO|SIMBOLO)$/i.test(t)) continue;
    if (!t || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)) {
      rejected.push(line.slice(0, 40));
      continue;
    }
    if (!tickers.includes(t)) tickers.push(t);
    const price = Number(cols[1]);
    const date = cols[2];
    if (cols[1] && Number.isFinite(price) && price > 0 && date && /^\d{4}-\d{2}-\d{2}/.test(date)) prices.push({ ticker: t, price, date });
  }
  return { tickers: tickers.slice(0, 200), prices, rejected };
}
