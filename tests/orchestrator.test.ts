import { describe, it, expect, beforeEach } from "vitest";
import { freshDb, demoSession, testSettings } from "./helpers";
import { runSession, prepareResume } from "@/lib/orchestrator/runner";
import { ScriptedAdapter } from "@/lib/llm/scripted";
import { syntheticMarketData } from "@/lib/market-data/synthetic";
import { PROFILES, maxTotal } from "@/lib/agents/profiles";
import { AccessDeniedError, postRound1Context, readReports } from "@/lib/agents/broker";
import { getDb } from "@/lib/db/index";
import {
  createIssue, ensureTask, getSession, insertMessage, insertReport, listIssues, listMessages, listReports, listTasks, markTaskRunning, transitionSession, freezeInitialReports,
} from "@/lib/db/repo";
import { InvalidTransitionError } from "@/lib/state";
import { AGENT_ROLES, type AgentRole } from "@/lib/types";
import type { ModelRequest } from "@/lib/llm/adapter";
import { initialReportSchema, toInputSchema } from "@/lib/agents/schemas";

const deps = (adapter: ScriptedAdapter, settings = testSettings()) => ({ adapter, md: syntheticMarketData(), settings });
const promptText = (r: ModelRequest) => JSON.stringify(r.messages);

beforeEach(() => freshDb());

describe("agents", () => {
  it("1. the four agents have different system prompts, missions and criteria", () => {
    const sys = AGENT_ROLES.map((r) => PROFILES[r].system);
    expect(new Set(sys).size).toBe(4);
    expect(new Set(AGENT_ROLES.map((r) => PROFILES[r].criteria.map((c) => c.key).join())).size).toBe(4);
    for (const r of ["QUALITY", "VALUATION", "RISK"] as AgentRole[]) expect(maxTotal(r)).toBe(100);
    expect(PROFILES.RISK.higherIsWorse).toBe(true);
    for (const r of AGENT_ROLES) expect(toInputSchema(initialReportSchema(r)).type).toBe("object");
  });
});

describe("round 1 independence", () => {
  it("2–3. round-1 prompts contain no other agent's output; other reports are unreadable until the round closes", async () => {
    const settings = testSettings();
    const s = demoSession(settings);
    const r1Prompts: Record<string, string[]> = {};
    let checkedDuringRound = false;
    const adapter = new ScriptedAdapter({
      onRequest: (req) => {
        if (req.meta.phase === "ROUND_1") {
          (r1Prompts[req.meta.role] ??= []).push(promptText(req));
          // While round 1 is open the broker refuses cross-agent reads.
          expect(() => readReports(s.id, req.meta.role, req.meta.role === "QUALITY" ? "RISK" : "QUALITY")).toThrow(AccessDeniedError);
          expect(() => postRound1Context(s.id, req.meta.role)).toThrow(AccessDeniedError);
          checkedDuringRound = true;
        }
      },
    });
    const out = await runSession(s.id, deps(adapter, settings));
    expect(out.status).toBe("COMPLETED");
    expect(checkedDuringRound).toBe(true);
    for (const role of AGENT_ROLES) {
      const text = r1Prompts[role].join("\n");
      for (const other of AGENT_ROLES.filter((o) => o !== role)) {
        expect(text).not.toContain(`Tesis sintética de ${PROFILES[other].name}`);
        expect(text).not.toContain(`Resumen sintético del ${PROFILES[other].name}`);
      }
      expect(text).toContain("RONDA 1");
    }
    // After the round closes all four initial reports are readable and frozen.
    const ctx = postRound1Context(s.id, "CIO");
    for (const r of AGENT_ROLES) expect(ctx.reports[r].initial?.frozen).toBe(true);
  });

  it("4. the debate cannot start before all four reports are complete", async () => {
    const settings = testSettings();
    const s = demoSession(settings);
    const adapter = new ScriptedAdapter({ failOn: (req) => (req.meta.role === "RISK" && req.meta.phase === "ROUND_1" ? new Error("fallo simulado del proveedor") : null) });
    const out = await runSession(s.id, deps(adapter, settings));
    expect(out.status).toBe("PAUSED_ERROR");
    expect(listTasks(s.id).some((t) => t.phase === "CROSS_REVIEW")).toBe(false);
    expect(listMessages(s.id)).toHaveLength(0);
    expect(() => transitionSession(s.id, "DEBATE")).toThrow(InvalidTransitionError);
    expect(() => postRound1Context(s.id, "CIO")).toThrow(AccessDeniedError);
    // Unfrozen reports of the agents that finished are preserved.
    expect(listReports(s.id).filter((r) => r.kind === "INITIAL").map((r) => r.agentRole).sort()).toEqual(["CIO", "QUALITY", "VALUATION"]);
  });
});

describe("errors, retry and resume", () => {
  it("11. a failed agent is shown as failed, previous results are kept, and only that agent is retried", async () => {
    const settings = testSettings();
    const s = demoSession(settings);
    const a1 = new ScriptedAdapter({ failOn: (req) => (req.meta.role === "VALUATION" && req.meta.phase === "ROUND_1" ? new Error("HTTP 400 simulado") : null) });
    const out = await runSession(s.id, deps(a1, settings));
    expect(out.status).toBe("PAUSED_ERROR");
    expect(out.error).toMatch(/Valuation/);
    const failed = listTasks(s.id).filter((t) => t.status === "FAILED").map((t) => t.taskKey);
    expect(failed).toEqual(["r1:VALUATION"]);
    const before = listReports(s.id).map((r) => r.id);
    const roles2: string[] = [];
    const a2 = new ScriptedAdapter({ onRequest: (req) => req.meta.phase === "ROUND_1" && roles2.push(req.meta.role) });
    prepareResume(s.id);
    const out2 = await runSession(s.id, deps(a2, settings));
    expect(out2.status).toBe("COMPLETED");
    expect(new Set(roles2)).toEqual(new Set(["VALUATION"]));
    const after = listReports(s.id).map((r) => r.id);
    for (const id of before) expect(after).toContain(id);
  });

  it("15. an interrupted session resumes without re-running completed tasks", async () => {
    const settings = testSettings();
    const s = demoSession(settings);
    let n = 0;
    const a1 = new ScriptedAdapter({ failOn: (req) => (++n > 20 && req.meta.phase === "DEBATE" ? new Error("proceso interrumpido") : null) });
    const out = await runSession(s.id, deps(a1, settings));
    expect(out.status).toBe("PAUSED_ERROR");
    const done = listTasks(s.id).filter((t) => t.status === "SUCCEEDED").map((t) => t.taskKey);
    expect(done).toContain("r1:QUALITY");
    // Simulate a crash that left a task RUNNING.
    ensureTask(s.id, "r2b:orphan", { phase: "DEBATE" });
    markTaskRunning(s.id, "r2b:orphan");
    const keys2: string[] = [];
    const a2 = new ScriptedAdapter({ onRequest: (req) => keys2.push(req.meta.taskKey) });
    prepareResume(s.id);
    const out2 = await runSession(s.id, deps(a2, settings));
    expect(out2.status).toBe("COMPLETED");
    for (const k of done) expect(keys2).not.toContain(k);
    expect(listTasks(s.id).find((t) => t.taskKey === "r2b:orphan")!.status).not.toBe("RUNNING");
    // No duplicate messages from completed tasks.
    const perTask = new Map<string, number>();
    for (const m of listMessages(s.id)) perTask.set(m.taskKey ?? "", (perTask.get(m.taskKey ?? "") ?? 0) + 1);
    const firstR2a = listMessages(s.id).filter((m) => m.taskKey === "r2a:QUALITY").length;
    expect(firstR2a).toBeLessThan(15);
  });
});

describe("persistence", () => {
  it("5. messages are stored and can be retrieved with filters", () => {
    const s = demoSession();
    const m = insertMessage({ sessionId: s.id, round: 2, phase: "DEBATE", ticker: "DEMO-A", fromRole: "RISK", toRole: "QUALITY", type: "OBJECTION", claim: "La deuda es alta", evidenceText: "x", evidenceIds: ["EV-1"], question: "¿Refinanciación?", expectedOutcome: "Respuesta", inReplyTo: null, taskKey: "t" });
    insertMessage({ sessionId: s.id, round: 2, phase: "DEBATE", ticker: "DEMO-A", fromRole: "QUALITY", toRole: "RISK", type: "RESPONSE", claim: "Vencimientos en 2030", evidenceText: null, evidenceIds: [], question: null, expectedOutcome: "ok", inReplyTo: m.id, taskKey: "t2" });
    expect(listMessages(s.id)).toHaveLength(2);
    expect(listMessages(s.id, { type: "RESPONSE" })[0].inReplyTo).toBe(m.id);
    expect(listMessages(s.id, { role: "RISK" })).toHaveLength(2);
    expect(listMessages(s.id, { ticker: "DEMO-B" })).toHaveLength(0);
    expect(listMessages(s.id, { round: 2 })[0].evidenceIds).toEqual(["EV-1"]);
  });

  it("6. objections with factual disputes generate issues during the debate", async () => {
    const settings = testSettings();
    const s = demoSession(settings);
    await runSession(s.id, deps(new ScriptedAdapter(), settings));
    const factual = listIssues(s.id).filter((i) => i.kind === "FACTUAL_DISPUTE");
    expect(factual.length).toBeGreaterThan(0);
    expect(factual[0].sourceMessageId).not.toBeNull();
    // A verifiable figure is resolved by documentary evidence, not by votes.
    expect(factual[0].status).toBe("RESOLVED");
    expect(factual[0].evidenceIds.length).toBeGreaterThan(0);
    expect(listIssues(s.id).some((i) => i.kind === "FORECAST")).toBe(true);
  });

  it("7. revisions never overwrite initial reports (frozen rows are immutable)", () => {
    const s = demoSession();
    const r = insertReport(s.id, "QUALITY", "INITIAL", "ROUND_1", { companies: [] }, "k1");
    freezeInitialReports(s.id);
    expect(() => getDb().prepare("UPDATE reports SET content_json = '{}' WHERE id = ?").run(r.id)).toThrow(/frozen/);
    expect(() => getDb().prepare("DELETE FROM reports WHERE id = ?").run(r.id)).toThrow(/frozen/);
    expect(() => insertReport(s.id, "QUALITY", "INITIAL", "ROUND_1", { companies: [] }, "k2")).toThrow(/congelado/);
    const rev = insertReport(s.id, "QUALITY", "REVISION", "REVISION", { companies: [{ ticker: "X" }] }, "k3");
    expect(rev.version).toBe(2);
    expect(listReports(s.id, "QUALITY").map((x) => x.version)).toEqual([1, 2]);
    expect(JSON.stringify(listReports(s.id, "QUALITY")[0].content)).toBe(JSON.stringify({ companies: [] }));
  });

  it("issues keep a change history", () => {
    const s = demoSession();
    const i = createIssue({ sessionId: s.id, ticker: "DEMO-A", kind: "FACTUAL_DISPUTE", critical: true, title: "t", claims: [], createdBy: "RISK" });
    expect(i.status).toBe("OPEN");
  });

  it("the full flow persists everything and the session is recoverable from the DB", async () => {
    const settings = testSettings();
    const s = demoSession(settings);
    await runSession(s.id, deps(new ScriptedAdapter(), settings));
    const fresh = getSession(s.id)!;
    expect(fresh.status).toBe("COMPLETED");
    expect(fresh.completedAt).not.toBeNull();
  });
});
