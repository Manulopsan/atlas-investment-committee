import { z } from "zod";

/**
 * Investment objective. Editable from the dashboard and frozen into each
 * session when it starts, so a session is always reproducible from its config.
 */
export const SECTOR_EXCLUSIONS = ["BANKS", "INSURANCE", "TELECOM", "SHELL_COMPANIES"] as const;
export type SectorExclusion = (typeof SECTOR_EXCLUSIONS)[number];

export const InvestmentConfigSchema = z.object({
  market: z.literal("US").default("US"),
  exchanges: z.array(z.string()).default(["NYSE", "Nasdaq", "CBOE"]),
  capSegments: z.array(z.enum(["large", "mid", "small"])).default(["large", "mid", "small"]),
  horizonYears: z.number().int().min(1).max(10).default(3),
  strategy: z.string().default("Calidad a buen precio (quality at a reasonable price)"),
  /** Selection target, NOT a forecast or a promise. */
  targetAnnualReturn: z.number().min(0).max(1).default(0.15),
  presentationCurrency: z.literal("USD").default("USD"),
  alternativeCurrency: z.literal("EUR").default("EUR"),
  maxFinalists: z.number().int().min(0).max(5).default(5),
  excludedSectors: z.array(z.enum(SECTOR_EXCLUSIONS)).default(["BANKS", "INSURANCE", "TELECOM", "SHELL_COMPANIES"]),
  riskTolerance: z.enum(["low", "moderate", "high"]).default("moderate"),
  /** Required discount of entry price vs. central fair value. */
  requiredMarginOfSafety: z.number().min(0).max(0.8).default(0.2),
  /** Discount rate used to bring year-N scenario values back to today. */
  discountRate: z.number().min(0.03).max(0.25).default(0.09),
  /** Tickers imported by the user (CSV) — merged with discovered candidates. */
  userTickers: z.array(z.string()).default([]),
  /** Optional user-supplied prices from the CSV (always UNVERIFIED). */
  userPrices: z.array(z.object({ ticker: z.string(), price: z.number().positive(), date: z.string() })).default([]),
  /** When true, only user-imported tickers are analysed (no automatic discovery). */
  userTickersOnly: z.boolean().default(false),
  /**
   * Point-in-time (historical) mode, YYYY-MM-DD: only filings filed and prices
   * quoted on or before this date are used. Used by the evaluation harness.
   */
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  /** How many screened companies are handed to the agents in round 1. */
  maxCandidates: z.number().int().min(1).max(30).default(10),
  /** How many companies go through the structured per-company debate. */
  maxDebateCompanies: z.number().int().min(1).max(10).default(5),
  /** Minimum market cap thresholds (USD) used to label cap segments. */
  smallCapMinUsd: z.number().default(300e6),
  midCapMinUsd: z.number().default(2e9),
  largeCapMinUsd: z.number().default(10e9),
});
export type InvestmentConfig = z.infer<typeof InvestmentConfigSchema>;

export const LimitsSchema = z.object({
  /** Full debate rounds: round 2 (debate) and round 4 (selective debate). */
  maxDebateRounds: z.number().int().min(1).max(2).default(2),
  /** Additional revision round allowed during round 4. */
  maxExtraRevisionRounds: z.number().int().min(0).max(1).default(1),
  maxVerificationsPerCompany: z.number().int().min(0).max(10).default(2),
  maxCallsPerSession: z.number().int().min(1).max(1000).default(120),
  maxBudgetUsd: z.number().min(0).max(1000).default(10),
  maxInputTokensPerCall: z.number().int().min(1000).max(1_000_000).default(150_000),
  maxOutputTokensPerCall: z.number().int().min(1000).max(128_000).default(16_000),
  /** Tool-use iterations inside a single agent task. */
  maxToolIterations: z.number().int().min(1).max(30).default(8),
  concurrency: z.number().int().min(1).max(4).default(2),
  /** Fraction of the budget reserved for the CIO's final decision. */
  finalReserveFraction: z.number().min(0).max(0.5).default(0.15),
  taskRetries: z.number().int().min(0).max(3).default(1),
});
export type Limits = z.infer<typeof LimitsSchema>;

export const ModelPriceSchema = z.object({
  inputPerMTok: z.number().min(0),
  outputPerMTok: z.number().min(0),
  cacheWritePerMTok: z.number().min(0),
  cacheReadPerMTok: z.number().min(0),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

/**
 * Default price table (USD per million tokens). This is only a starting point:
 * it is stored in SQLite, editable in Settings, and must be checked against
 * https://www.anthropic.com/pricing — real billing may differ.
 */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 },
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 2.5, cacheReadPerMTok: 0.2 },
  "claude-haiku-5-5": { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheWritePerMTok: 0.125, cacheReadPerMTok: 0.01 },
  "claude-fable-5-1": { inputPerMTok: 10, outputPerMTok: 50, cacheWritePerMTok: 12.5, cacheReadPerMTok: 0.25 },
};

export const AppSettingsSchema = z.object({
  /**
   * How live sessions reach Claude. "subscription": the Claude account logged in
   * to Claude Code on this machine (Claude Agent SDK; consumes the plan's usage
   * windows, no API bill). "api": ANTHROPIC_API_KEY (pay per token).
   */
  llmProvider: z.enum(["subscription", "api"]).default("subscription"),
  /** Subscription mode: stop new calls when the 5-hour usage window reaches this % (0-100). */
  subscriptionStopAtPct: z.number().min(10).max(100).default(95),
  /**
   * Subscription mode: call cap per session. Only a runaway guard — the real
   * limit is the usage window (limits.maxCallsPerSession is for API spend).
   */
  subscriptionMaxCalls: z.number().int().min(50).max(5000).default(600),
  /** Subscription mode: points of the window kept for the CIO's final decision. */
  subscriptionFinalReservePct: z.number().min(0).max(30).default(4),
  /** Main model: initial reports, revisions, CIO decisions. */
  model: z.string().min(1).default("claude-opus-5-5"),
  /** Model for debate turns and verification tasks (the "quality" knob). */
  debateModel: z.string().min(1).default("claude-opus-5-5"),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  /** Server-side refusal fallback (beta). Disabled automatically if rejected. */
  refusalFallback: z.boolean().default(true),
  /** Anthropic server-side web search (extra cost per search). Results are always UNVERIFIED. */
  enableWebSearch: z.boolean().default(false),
  /** Use the (free) token-counting endpoint before each call for a precise budget check. */
  preciseTokenCount: z.boolean().default(true),
  webSearchMaxUses: z.number().int().min(1).max(10).default(3),
  pricing: z.record(z.string(), ModelPriceSchema).default(DEFAULT_PRICING),
  pricingNote: z.string().default("Tabla por defecto — verifique en https://www.anthropic.com/pricing"),
  limits: LimitsSchema.default(LimitsSchema.parse({})),
  investment: InvestmentConfigSchema.default(InvestmentConfigSchema.parse({})),
  priceProvider: z.enum(["stooq", "alphavantage", "manual"]).default("stooq"),
  fxProvider: z.enum(["ecb", "none"]).default("ecb"),
  refreshFrequency: z.enum(["manual", "daily", "weekly"]).default("manual"),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

export function defaultSettings(): AppSettings {
  return AppSettingsSchema.parse({});
}

/** Server-only environment access. Never returned to the browser. */
export function serverEnv() {
  return {
    anthropicKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim()),
    secUserAgent: process.env.SEC_USER_AGENT?.trim() || "",
    alphaVantageKeyConfigured: Boolean(process.env.ALPHAVANTAGE_API_KEY?.trim()),
    dbPath: process.env.ATLAS_DB_PATH?.trim() || "",
  };
}

