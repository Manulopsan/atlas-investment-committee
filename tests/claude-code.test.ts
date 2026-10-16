import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { freshDb, demoSession, testSettings } from "./helpers";
import { ClaudeCodeAdapter, checkTurnBudget, subscriptionEnv, SUBSCRIPTION_BASIS } from "@/lib/llm/claudeCode";
import { VerificationSchema } from "@/lib/agents/schemas";
import { insertUsage, listUsage, createSession } from "@/lib/db/repo";
import { BudgetExceededError, planEstimate } from "@/lib/llm/cost";
import { runAgentTask } from "@/lib/orchestrator/agentTask";
import { syntheticMarketData } from "@/lib/market-data/synthetic";
import { openDb, setDbForTesting } from "@/lib/db/index";
import { defaultSettings } from "@/lib/config";

const FAKE = path.resolve("tests/fixtures/fake-claude.mjs");
const VALID = { issue_id: 1, outcome: "UNRESOLVABLE", corrected_value: null, unit: null, evidence_ids: [], explanation: "prueba con CLI simulada" };
const spec = (sessionId: string) => ({
  sessionId, taskKey: "t1", phase: "VERIFICATION", role: "RISK" as const, model: "claude-haiku-5-5", prompt: "hola",
  dataTools: ["get_price"], submit: { name: "submit_verification", description: "d", schema: VerificationSchema }, maxIterations: 3, ticker: "DEMO-A",
});

beforeEach(() => {
  freshDb();
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-never-reach-the-cli";
  process.env.FAKE_OUTPUT = JSON.stringify(VALID);
  delete process.env.FAKE_MODE;
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

describe("subscription provider (Claude Code)", () => {
  it("never passes an API key to the CLI", () => {
    const env = subscriptionEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("runs a task in an isolated CLI process and records usage as subscription", async () => {
    const settings = testSettings((s) => void (s.claudeCodePath = FAKE));
    const s = demoSession(settings);
    const r = await new ClaudeCodeAdapter(settings).runTask(spec(s.id), { isStopRequested: () => false });
    expect(r.output).toEqual(VALID);
    const u = listUsage(s.id);
    expect(u).toHaveLength(1);
    expect(u[0].turns).toBe(2);
    expect(u[0].costBasis).toBe(SUBSCRIPTION_BASIS);
    expect(u[0].ticker).toBe("DEMO-A");
    expect(u[0].cacheWriteTokens).toBe(40);
  });

  it("a task that ends without submitting fails as AgentOutputError (retryable), never as success", async () => {
    process.env.FAKE_MODE = "nosubmit";
    const settings = testSettings((s) => void (s.claudeCodePath = FAKE));
    const s = demoSession(settings);
    await expect(new ClaudeCodeAdapter(settings).runTask(spec(s.id), { isStopRequested: () => false })).rejects.toMatchObject({ name: "AgentOutputError" });
  });

  it("hitting the plan's usage limit pauses (UsageLimitError) instead of stopping the session", async () => {
    process.env.FAKE_MODE = "limit";
    const settings = testSettings((s) => void (s.claudeCodePath = FAKE));
    const s = demoSession(settings);
    await expect(new ClaudeCodeAdapter(settings).runTask(spec(s.id), { isStopRequested: () => false })).rejects.toMatchObject({ name: "UsageLimitError" });
  });

  it("the turn limit stops new tasks and keeps a reserve for the CIO", () => {
    const settings = testSettings((s) => void (s.limits.maxCallsPerSession = 20));
    const s = demoSession(settings);
    insertUsage(s.id, { taskKey: "x", agentRole: "QUALITY", phase: "ROUND_1", model: "m", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estCostUsd: 0, costBasis: SUBSCRIPTION_BASIS, stopReason: null, requestId: null, turns: 12 });
    expect(() => checkTurnBudget(s.id, settings, 5, false)).toThrow(BudgetExceededError);
    expect(() => checkTurnBudget(s.id, settings, 5, true)).not.toThrow();
  });

  it("the orchestrator delegates to runTask and re-validates the output", async () => {
    const settings = testSettings();
    const s = demoSession(settings);
    const adapter = { id: "x", kind: "claude_code" as const, create: async () => { throw new Error("no"); }, runTask: async () => ({ output: { issue_id: "bad" }, model: "m", iterations: 1 }) };
    await expect(runAgentTask(spec(s.id), { adapter, md: syntheticMarketData(), settings, isStopRequested: () => false })).rejects.toMatchObject({ name: "AgentOutputError" });
  });

  it("the estimate is labelled as subscription usage", () => {
    const e = planEstimate(testSettings((s) => void (s.provider = "claude_code")), 3);
    expect(e.subscription).toBe(true);
    expect(e.warnings.join(" ")).toMatch(/límites de uso/);
    expect(planEstimate(testSettings((s) => void (s.provider = "anthropic_api")), 3).subscription).toBe(false);
  });
});

describe("ATLAS MCP server (real process, stdio JSON-RPC)", () => {
  it("lists only the authorised tools, runs them and validates the submission", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-mcp-test-"));
    const dbPath = path.join(dir, "t.db");
    setDbForTesting(openDb(dbPath));
    const s = createSession({ mode: "demo", settings: defaultSettings() });
    const out = path.join(dir, "out.json");
    const ctxFile = path.join(dir, "task.json");
    fs.writeFileSync(ctxFile, JSON.stringify({ sessionId: s.id, taskKey: "t", role: "QUALITY", phase: "ROUND_1", round1: true, dataTools: ["get_price"], submitName: "submit_verification", submitDescription: "d", outputFile: out }));
    const child = spawn(path.resolve("node_modules/.bin/tsx"), [path.resolve("scripts/mcp-atlas.ts")], { env: { ...process.env, ATLAS_MCP_CONTEXT_FILE: ctxFile, ATLAS_APP_DIR: process.cwd(), ATLAS_DB_PATH: dbPath }, stdio: ["pipe", "pipe", "pipe"] });
    const replies = new Map<number, Record<string, unknown>>();
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) {
          const m = JSON.parse(line);
          replies.set(m.id, m);
        }
      }
    });
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + "\n");
    const wait = async (id: number) => {
      for (let k = 0; k < 200 && !replies.has(id); k++) await new Promise((r) => setTimeout(r, 50));
      return replies.get(id) as { result: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } };
    };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await wait(2)).result.tools!.map((t) => t.name)).toEqual(["get_price", "submit_verification"]);
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_company_financials", arguments: { ticker: "DEMO-A" } } });
    expect((await wait(3)).result.isError).toBe(true);
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_price", arguments: { ticker: "DEMO-A" } } });
    expect((await wait(4)).result.content![0].text).toMatch(/DEMO-A: 70 USD/);
    send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "submit_verification", arguments: { issue_id: 1 } } });
    expect((await wait(5)).result.isError).toBe(true);
    expect(fs.existsSync(out)).toBe(false);
    send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "submit_verification", arguments: VALID } });
    expect((await wait(6)).result.isError).toBeFalsy();
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual(VALID);
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30000);
});
