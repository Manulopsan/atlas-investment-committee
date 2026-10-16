import { describe, it, expect, beforeEach } from "vitest";
import { freshDb, demoSession, testSettings } from "./helpers";
import { runSession } from "@/lib/orchestrator/runner";
import { ScriptedAdapter } from "@/lib/llm/scripted";
import { syntheticMarketData } from "@/lib/market-data/synthetic";
import { BudgetExceededError, checkBudget, planEstimate, priceFor } from "@/lib/llm/cost";
import { getFinalReport, getSession, insertUsage, listUsage, usageTotals } from "@/lib/db/repo";
import type { ModelRequest } from "@/lib/llm/adapter";

/** Behaves like a paid adapter (costs are computed from usage) but returns scripted content. */
class PaidLikeAdapter extends ScriptedAdapter {
  kind = "anthropic" as unknown as "scripted";
  phases: string[] = [];
  constructor() {
    super({ usage: { input: 20000, output: 2000 } });
  }
  async create(req: ModelRequest) {
    this.phases.push(req.meta.phase);
    return super.create(req);
  }
}

beforeEach(() => freshDb());

describe("10. cost limits stop new calls", () => {
  it("checkBudget refuses a call that could exceed the budget or the call limit", () => {
    const settings = testSettings((s) => {
      s.limits.maxBudgetUsd = 1;
      s.limits.maxCallsPerSession = 3;
    });
    const sess = demoSession(settings);
    expect(() => checkBudget(sess.id, settings, { model: "claude-opus-5-5", estInputTokens: 1000, maxOutputTokens: 1000, isFinal: false })).not.toThrow();
    insertUsage(sess.id, { taskKey: "x", agentRole: "QUALITY", phase: "ROUND_1", model: "claude-opus-5-5", inputTokens: 100000, outputTokens: 20000, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0.8, costBasis: "test", stopReason: null, requestId: null });
    expect(() => checkBudget(sess.id, settings, { model: "claude-opus-5-5", estInputTokens: 1000, maxOutputTokens: 16000, isFinal: false })).toThrow(BudgetExceededError);
    // The final decision may use the reserve.
    expect(() => checkBudget(sess.id, settings, { model: "claude-opus-5-5", estInputTokens: 1000, maxOutputTokens: 1000, isFinal: true })).not.toThrow();
    insertUsage(sess.id, { taskKey: "y", agentRole: "QUALITY", phase: "ROUND_1", model: "claude-opus-5-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0, costBasis: "test", stopReason: null, requestId: null });
    expect(() => checkBudget(sess.id, settings, { model: "claude-opus-5-5", estInputTokens: 10, maxOutputTokens: 10, isFinal: false })).toThrow(/llamadas/);
    expect(() => checkBudget(sess.id, settings, { model: "unknown-model", estInputTokens: 10, maxOutputTokens: 10, isFinal: true })).toThrow(/precio/);
  });

  it("a zero price counts as not configured (budget must stay enforceable)", () => {
    const s = testSettings((x) => void (x.pricing["free-model"] = { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 }));
    expect(priceFor(s, "free-model")).toBeNull();
  });

  it("a session stops the debate in a controlled way when the budget is reached and never overspends", async () => {
    const settings = testSettings((s) => {
      s.limits.maxBudgetUsd = 3;
      s.limits.maxOutputTokensPerCall = 4000;
    });
    const sess = demoSession(settings);
    const adapter = new PaidLikeAdapter();
    const out = await runSession(sess.id, { adapter, md: syntheticMarketData(), settings });
    const fresh = getSession(sess.id)!;
    expect(fresh.budgetExhausted).toBe(true);
    expect(["COMPLETED", "STOPPED_BY_BUDGET"]).toContain(out.status);
    expect(fresh.convergence).toBe("STOPPED_BY_BUDGET");
    expect(usageTotals(sess.id).estCostUsd).toBeLessThanOrEqual(settings.limits.maxBudgetUsd);
    // After the controlled stop, the only further call allowed is the CIO's final decision.
    const firstStopIdx = adapter.phases.findIndex((p, i) => i > 0 && p === "FINAL_DECISION");
    if (firstStopIdx >= 0) expect(adapter.phases.slice(firstStopIdx).every((p) => p === "FINAL_DECISION")).toBe(true);
    expect(getFinalReport(sess.id)).not.toBeNull();
    expect(listUsage(sess.id).every((u) => u.costBasis.startsWith("ESTIMADO"))).toBe(true);
  });

  it("the pre-session estimate lists calls, agents, rounds, model and budget", () => {
    const e = planEstimate(testSettings(), 6);
    expect(e.agents).toBe(4);
    expect(e.totalCalls).toBeGreaterThan(10);
    expect(e.model).toBe("claude-opus-5-5");
    expect(e.rounds.length).toBeGreaterThanOrEqual(4);
    expect(e.estCostUsd).not.toBeNull();
    expect(e.warnings.join(" ")).toMatch(/coste real depende/);
  });
});
