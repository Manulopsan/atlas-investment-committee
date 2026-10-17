import { describe, it, expect, beforeEach } from "vitest";
import { freshDb, demoSession, testSettings } from "./helpers";
import { prepareResume, runSession } from "@/lib/orchestrator/runner";
import { ScriptedAdapter } from "@/lib/llm/scripted";
import { syntheticMarketData } from "@/lib/market-data/synthetic";
import { BudgetExceededError, checkBudget, planEstimate, priceFor } from "@/lib/llm/cost";
import { getFinalReport, getLimitPause, getSession, insertUsage, listTasks, listUsage, usageTotals } from "@/lib/db/repo";
import type { ModelRequest } from "@/lib/llm/adapter";
import { rememberSubscriptionStatus } from "@/lib/llm/usageWindow";

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
      s.llmProvider = "api";
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
      s.llmProvider = "api";
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
    const e = planEstimate(testSettings((s) => void (s.llmProvider = "api")), 6);
    expect(e.agents).toBe(4);
    expect(e.totalCalls).toBeGreaterThan(10);
    expect(e.model).toBe("claude-opus-5-5");
    expect(e.rounds.length).toBeGreaterThanOrEqual(4);
    expect(e.estCostUsd).not.toBeNull();
    expect(e.warnings.join(" ")).toMatch(/coste real depende/);
  });

  it("subscription mode stops at the 5-hour window cap, keeping a reserve for the verdict", () => {
    const settings = testSettings((s) => {
      s.llmProvider = "subscription";
      s.subscriptionStopAtPct = 90;
      s.subscriptionFinalReservePct = 5;
      s.limits.maxBudgetUsd = 0.01; // the USD budget does not apply to the subscription
    });
    const sess = demoSession(settings);
    const call = (isFinal: boolean) => () => checkBudget(sess.id, settings, { model: "claude-opus-5-5", estInputTokens: 1000, maxOutputTokens: 16000, isFinal });
    rememberSubscriptionStatus({ status: "allowed", fiveHour: { utilization: 0.5, resetsAt: null } });
    expect(call(false)).not.toThrow();
    rememberSubscriptionStatus({ fiveHour: { utilization: 0.87, resetsAt: null } });
    expect(call(false)).toThrow(/ventana de 5 h/);
    expect(call(true)).not.toThrow();
    rememberSubscriptionStatus({ fiveHour: { utilization: 0.9, resetsAt: null } });
    expect(call(true)).toThrow(BudgetExceededError);
    rememberSubscriptionStatus({ status: "rejected", fiveHour: { utilization: 0.1, resetsAt: null } });
    expect(call(true)).toThrow(/suscripción/);
  });
});

describe("subscription limit pauses and resumes", () => {
  it("the API call cap does not apply on the subscription (only the runaway guard)", () => {
    const settings = testSettings((s) => {
      s.llmProvider = "subscription";
      s.limits.maxCallsPerSession = 3;
      s.subscriptionMaxCalls = 50;
    });
    const sess = demoSession(settings);
    rememberSubscriptionStatus({ status: "allowed", fiveHour: { utilization: 0.1, resetsAt: null } });
    for (let i = 0; i < 10; i++) insertUsage(sess.id, { taskKey: `x${i}`, agentRole: "QUALITY", phase: "DEBATE", model: "claude-opus-5-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0, costBasis: "test", stopReason: null, requestId: null });
    expect(() => checkBudget(sess.id, settings, { model: "claude-opus-5-5", estInputTokens: 10, maxOutputTokens: 10, isFinal: false })).not.toThrow();
    for (let i = 10; i < 48; i++) insertUsage(sess.id, { taskKey: `x${i}`, agentRole: "QUALITY", phase: "DEBATE", model: "claude-opus-5-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0, costBasis: "test", stopReason: null, requestId: null });
    expect(() => checkBudget(sess.id, settings, { model: "claude-opus-5-5", estInputTokens: 10, maxOutputTokens: 10, isFinal: false })).toThrow(/48\/50/);
  });

  it("pauses at the window cap keeping completed work, and resumes into the same phase", async () => {
    const settings = testSettings((s) => {
      s.llmProvider = "subscription";
      s.subscriptionStopAtPct = 90;
    });
    const sess = demoSession(settings);
    const deps = { adapter: new ScriptedAdapter(), md: syntheticMarketData(), settings };
    rememberSubscriptionStatus({ status: "allowed", fiveHour: { utilization: 0.99, resetsAt: "2030-01-01T00:00:00.000Z" } });
    const paused = await runSession(sess.id, deps);
    expect(paused.status).toBe("PAUSED_LIMIT");
    expect(paused.resumeStatus).toBe("ROUND_1_RUNNING");
    expect(paused.budgetExhausted).toBe(false);
    expect(getLimitPause(sess.id)).toMatchObject({ resetsAt: "2030-01-01T00:00:00.000Z", autoResume: true });
    expect(listTasks(sess.id).find((t) => t.taskKey === "discovery")?.status).toBe("SUCCEEDED");

    rememberSubscriptionStatus({ fiveHour: { utilization: 0.05, resetsAt: null } });
    prepareResume(sess.id);
    expect(getLimitPause(sess.id)).toBeNull();
    const done = await runSession(sess.id, deps);
    expect(done.status).toBe("COMPLETED");
  });
});
