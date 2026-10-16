import type { FxProvider, FxRate, PriceProvider, Quote } from "./types";

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
