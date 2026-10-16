import type { FxProvider, FxRate, PriceHistory, PriceHistoryProvider, PriceProvider, Quote } from "./types";

/**
 * Stooq public CSV quote (free, no key). Quotes are delayed and may be the
 * previous close. Stooq does not document the timezone of the time field, so
 * the raw date/time is kept and the delay is stated explicitly.
 */
export class StooqPriceProvider implements PriceProvider {
  id = "stooq";
  constructor(private fetchImpl: typeof fetch = fetch) {}

  static url(ticker: string) {
    const sym = ticker.toLowerCase().replace(/\./g, "-") + ".us";
    return `https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`;
  }

  static parse(ticker: string, csv: string, url: string, retrievedAt: string): Quote | null {
    const lines = csv.trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
    const row = lines[1].split(",").map((v) => v.trim());
    const get = (k: string) => row[header.indexOf(k)];
    const close = Number(get("close"));
    const date = get("date");
    if (!date || date === "N/D" || !Number.isFinite(close) || close <= 0) return null;
    const time = get("time");
    return {
      ticker,
      price: close,
      currency: "USD",
      asOf: time && time !== "N/D" ? `${date}T${time}` : date,
      kind: "DELAYED",
      delayNote: "Stooq: cotización retrasada (puede corresponder al último cierre); zona horaria no documentada por la fuente.",
      source: "Stooq (público, gratuito)",
      url,
      retrievedAt,
    };
  }

  async quote(ticker: string): Promise<Quote | null> {
    const url = StooqPriceProvider.url(ticker);
    try {
      const res = await this.fetchImpl(url, { headers: { Accept: "text/csv" } });
      if (!res.ok) return null;
      return StooqPriceProvider.parse(ticker, await res.text(), url, new Date().toISOString());
    } catch {
      return null;
    }
  }
}

/** Alpha Vantage GLOBAL_QUOTE (free tier key). The API key is never stored: the recorded URL is redacted. */
export class AlphaVantagePriceProvider implements PriceProvider {
  id = "alphavantage";
  constructor(private apiKey: string, private fetchImpl: typeof fetch = fetch) {}

  static publicUrl(ticker: string) {
    return `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(ticker)}&apikey=REDACTED`;
  }

  static parse(ticker: string, json: unknown, retrievedAt: string): Quote | null {
    const q = (json as { "Global Quote"?: Record<string, string> })?.["Global Quote"];
    if (!q) return null;
    const price = Number(q["05. price"]);
    const day = q["07. latest trading day"];
    if (!Number.isFinite(price) || price <= 0 || !day) return null;
    return {
      ticker,
      price,
      currency: "USD",
      asOf: day,
      kind: "CLOSE",
      delayNote: "Alpha Vantage (plan gratuito): último precio del día de negociación indicado; no es tiempo real.",
      source: "Alpha Vantage GLOBAL_QUOTE",
      url: AlphaVantagePriceProvider.publicUrl(ticker),
      retrievedAt,
    };
  }

  async quote(ticker: string): Promise<Quote | null> {
    if (!this.apiKey) return null;
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(this.apiKey)}`;
    try {
      const res = await this.fetchImpl(url);
      if (!res.ok) return null;
      return AlphaVantagePriceProvider.parse(ticker, await res.json(), new Date().toISOString());
    } catch {
      return null;
    }
  }
}

/** Prices typed in / imported by the user. Always UNVERIFIED in the evidence registry. */
export class ManualPriceProvider implements PriceProvider {
  id = "manual";
  constructor(private prices: { ticker: string; price: number; date: string }[]) {}
  async quote(ticker: string): Promise<Quote | null> {
    const p = this.prices.find((x) => x.ticker.toUpperCase() === ticker.toUpperCase());
    if (!p || !(p.price > 0) || !p.date) return null;
    return {
      ticker,
      price: p.price,
      currency: "USD",
      asOf: p.date,
      kind: "USER_SUPPLIED",
      delayNote: "Precio introducido por el usuario; no verificado por la aplicación.",
      source: "Usuario (CSV)",
      url: "",
      retrievedAt: new Date().toISOString(),
    };
  }
}

/** ECB euro foreign exchange reference rates (official, free). */
export class EcbFxProvider implements FxProvider {
  id = "ecb";
  static URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
  constructor(private fetchImpl: typeof fetch = fetch) {}

  static parse(xml: string, retrievedAt: string): FxRate | null {
    const date = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
    const rate = /currency=['"]USD['"]\s+rate=['"]([\d.]+)['"]/.exec(xml)?.[1];
    if (!date || !rate) return null;
    const v = Number(rate);
    if (!(v > 0)) return null;
    return { pair: "EURUSD", usdPerEur: v, date, source: "BCE — tipos de cambio de referencia del euro", url: EcbFxProvider.URL, retrievedAt };
  }

  async usdPerEurOn(date: string): Promise<FxRate | null> {
    const url = ecbHistoryUrl(date);
    try {
      const res = await this.fetchImpl(url, { headers: { Accept: "text/csv" } });
      if (!res.ok) return null;
      return parseEcbCsv(await res.text(), url, new Date().toISOString());
    } catch {
      return null;
    }
  }

  async usdPerEur(): Promise<FxRate | null> {
    try {
      const res = await this.fetchImpl(EcbFxProvider.URL);
      if (!res.ok) return null;
      return EcbFxProvider.parse(await res.text(), new Date().toISOString());
    } catch {
      return null;
    }
  }
}

/** Stooq daily history (CSV). Stooq does not document its adjustment policy: marked "unknown". */
export class StooqHistoryProvider implements PriceHistoryProvider {
  id = "stooq-history";
  constructor(private fetchImpl: typeof fetch = fetch) {}
  static url(ticker: string) {
    return `https://stooq.com/q/d/l/?s=${encodeURIComponent(ticker.toLowerCase().replace(/\./g, "-") + ".us")}&i=d`;
  }
  static parse(ticker: string, csv: string, url: string, retrievedAt: string): PriceHistory | null {
    const lines = csv.trim().split(/\r?\n/);
    const header = lines[0]?.toLowerCase().split(",") ?? [];
    const di = header.indexOf("date");
    const ci = header.indexOf("close");
    if (di < 0 || ci < 0) return null;
    const points = lines.slice(1).map((l) => l.split(",")).map((c) => ({ date: c[di], close: Number(c[ci]) })).filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && p.close > 0);
    if (!points.length) return null;
    points.sort((a, b) => a.date.localeCompare(b.date));
    return { ticker, points, adjustment: "unknown", frequency: "daily", source: "Stooq (histórico diario, público)", url, retrievedAt, note: "Stooq no documenta si la serie está ajustada por splits/dividendos: compare múltiplos históricos con cautela." };
  }
  async history(ticker: string): Promise<PriceHistory | null> {
    const url = StooqHistoryProvider.url(ticker);
    try {
      const res = await this.fetchImpl(url);
      if (!res.ok) return null;
      return StooqHistoryProvider.parse(ticker, await res.text(), url, new Date().toISOString());
    } catch {
      return null;
    }
  }
}

/** Alpha Vantage TIME_SERIES_MONTHLY_ADJUSTED (free tier): raw close + total-return adjusted close. */
export class AlphaVantageHistoryProvider implements PriceHistoryProvider {
  id = "alphavantage-history";
  constructor(private apiKey: string, private fetchImpl: typeof fetch = fetch) {}
  static parse(ticker: string, json: unknown, retrievedAt: string): PriceHistory | null {
    const series = (json as Record<string, Record<string, Record<string, string>>>)?.["Monthly Adjusted Time Series"];
    if (!series) return null;
    const points = Object.entries(series)
      .map(([date, v]) => ({ date, close: Number(v["4. close"]), totalReturnClose: Number(v["5. adjusted close"]) || null }))
      .filter((p) => p.close > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!points.length) return null;
    return {
      ticker, points, adjustment: "none", frequency: "monthly", source: "Alpha Vantage TIME_SERIES_MONTHLY_ADJUSTED",
      url: `https://www.alphavantage.co/query?function=TIME_SERIES_MONTHLY_ADJUSTED&symbol=${encodeURIComponent(ticker)}&apikey=REDACTED`, retrievedAt,
      note: "Cierre mensual sin ajustar (para múltiplos) y cierre ajustado por dividendos y splits (para rentabilidad total).",
    };
  }
  async history(ticker: string): Promise<PriceHistory | null> {
    if (!this.apiKey) return null;
    try {
      const res = await this.fetchImpl(`https://www.alphavantage.co/query?function=TIME_SERIES_MONTHLY_ADJUSTED&symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(this.apiKey)}`);
      if (!res.ok) return null;
      return AlphaVantageHistoryProvider.parse(ticker, await res.json(), new Date().toISOString());
    } catch {
      return null;
    }
  }
}

/** ECB Data Portal (official SDMX API) for historical EUR/USD reference rates. */
export function ecbHistoryUrl(date: string) {
  const end = new Date(Date.parse(date));
  const start = new Date(end.getTime() - 10 * 86_400_000);
  const f = (d: Date) => d.toISOString().slice(0, 10);
  return `https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?startPeriod=${f(start)}&endPeriod=${f(end)}&format=csvdata`;
}

export function parseEcbCsv(csv: string, url: string, retrievedAt: string): FxRate | null {
  const lines = csv.trim().split(/\r?\n/);
  const h = lines[0]?.split(",") ?? [];
  const ti = h.indexOf("TIME_PERIOD");
  const vi = h.indexOf("OBS_VALUE");
  if (ti < 0 || vi < 0) return null;
  const rows = lines.slice(1).map((l) => l.split(",")).filter((c) => Number(c[vi]) > 0).sort((a, b) => a[ti].localeCompare(b[ti]));
  const last = rows[rows.length - 1];
  if (!last) return null;
  return { pair: "EURUSD", usdPerEur: Number(last[vi]), date: last[ti], source: "BCE — Data Portal (EXR)", url, retrievedAt };
}
