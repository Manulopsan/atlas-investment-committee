import { openDb, setDbForTesting } from "@/lib/db/index";
import { createSession, getSettings } from "@/lib/db/repo";
import { defaultSettings, type AppSettings } from "@/lib/config";
import { syntheticMarketData } from "@/lib/market-data/synthetic";
import { ScriptedAdapter, type ScriptedOptions } from "@/lib/llm/scripted";
import type { SessionMode } from "@/lib/types";

export function freshDb() {
  const db = openDb(":memory:");
  setDbForTesting(db);
  return db;
}

export function testSettings(over: (s: AppSettings) => void = () => {}): AppSettings {
  const s = defaultSettings();
  s.limits.maxCallsPerSession = 400;
  s.limits.maxBudgetUsd = 50;
  s.investment.maxCandidates = 6;
  s.investment.maxDebateCompanies = 3;
  over(s);
  return s;
}

export function demoSession(settings = testSettings(), mode: SessionMode = "demo") {
  return createSession({ mode, settings });
}

export function demoDeps(opts: ScriptedOptions = {}) {
  const adapter = new ScriptedAdapter(opts);
  return { adapter, md: syntheticMarketData(), settings: getSettings() };
}
