import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { freshDb, demoSession, testSettings } from "./helpers";
import { runSession } from "@/lib/orchestrator/runner";
import { ScriptedAdapter } from "@/lib/llm/scripted";
import { syntheticMarketData } from "@/lib/market-data/synthetic";
import { createMarketData } from "@/lib/market-data";
import { buildExport, EXPORT_TYPES, DISCLAIMER } from "@/lib/export";
import { insertMessage, listCandidates, listVerdicts, getSession } from "@/lib/db/repo";
import { listEvidence } from "@/lib/evidence/registry";
import { redactSecrets } from "@/lib/security/redact";
import { getDb } from "@/lib/db/index";

const FAKE_KEY = "sk-ant-api03-THISISNOTAREALKEY1234567890";
beforeEach(() => {
  freshDb();
  process.env.ANTHROPIC_API_KEY = FAKE_KEY;
});
afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

async function completedDemo() {
  const settings = testSettings();
  const s = demoSession(settings);
  await runSession(s.id, { adapter: new ScriptedAdapter(), md: syntheticMarketData(), settings });
  return s.id;
}

describe("13. exports", () => {
  it("every export includes cutoff date, model, sources, limitations, verification status and the disclaimer", async () => {
    const id = await completedDemo();
    for (const t of EXPORT_TYPES) {
      const e = buildExport(id, t);
      expect(e.body).toContain("Fecha de corte");
      expect(e.body).toContain("Modelos:");
      expect(e.body).toContain("Fuentes:");
      expect(e.body).toContain("Limitaciones:");
      expect(e.body).toContain("Verificación de evidencias");
      expect(e.body).toContain(DISCLAIMER);
      expect(e.body).toContain("DEMOSTRACIÓN");
    }
    const md = buildExport(id, "final-md").body;
    expect(md).toContain("## Ranking final");
    expect(md).toContain("DEMO-A");
    const csv = buildExport(id, "final-csv").body;
    const header = csv.split("\n").find((l) => l.startsWith("rank,"))!;
    expect(header.split(",")).toContain("max_price_for_target");
    expect(buildExport(id, "evidence-csv").body.split("\n").filter((l) => l.startsWith("EV-")).length).toBe(listEvidence(id).length);
    expect(buildExport(id, "agents-md", "RISK").body).toContain("Risk Analyst");
  });

  it("never exports secrets, even if one leaked into stored content", async () => {
    const id = await completedDemo();
    insertMessage({ sessionId: id, round: 2, phase: "DEBATE", ticker: null, fromRole: "CIO", toRole: "ALL", type: "ARGUMENT", claim: `clave ${FAKE_KEY} y apikey=abc123`, evidenceText: null, evidenceIds: [], question: null, expectedOutcome: "x", inReplyTo: null, taskKey: "leak" });
    for (const t of EXPORT_TYPES) {
      const body = buildExport(id, t).body;
      expect(body).not.toContain(FAKE_KEY);
      expect(body).not.toContain("abc123");
    }
    expect(redactSecrets(`x ${FAKE_KEY} y`)).toBe("x [REDACTED] y");
  });

  it("secrets are not stored in SQLite", async () => {
    await completedDemo();
    const tables = (getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of tables) {
      const rows = getDb().prepare(`SELECT * FROM ${t}`).all();
      expect(JSON.stringify(rows)).not.toContain(FAKE_KEY);
    }
  });
});

describe("14. no invented real data in the interface", () => {
  it("demo data is synthetic, labelled, and limited to DEMO- tickers", async () => {
    const id = await completedDemo();
    expect(listCandidates(id).every((c) => c.synthetic && c.ticker.startsWith("DEMO-"))).toBe(true);
    expect(listEvidence(id).every((e) => e.synthetic && (e.ticker === null || e.ticker.startsWith("DEMO-")))).toBe(true);
    expect(listVerdicts(id).every((v) => (v.content as { synthetic: boolean }).synthetic)).toBe(true);
    expect(getSession(id)!.mode).toBe("demo");
  });
  it("live sessions refuse synthetic data and demo sessions refuse real providers", async () => {
    const settings = testSettings();
    const live = demoSession(settings, "live");
    const out = await runSession(live.id, { adapter: new ScriptedAdapter(), md: syntheticMarketData(), settings });
    expect(out.status).toBe("PAUSED_ERROR");
    expect(out.error).toMatch(/sintéticos/);
    const demo = demoSession(settings, "demo");
    const out2 = await runSession(demo.id, { adapter: new ScriptedAdapter(), md: createMarketData("live", settings), settings });
    expect(out2.status).toBe("PAUSED_ERROR");
    expect(listEvidence(live.id)).toHaveLength(0);
  });
  it("the dashboard source contains no hard-coded quotes or real-company figures", () => {
    const dirs = ["src/app", "src/components"];
    const files = dirs.flatMap((d) => fs.readdirSync(d, { recursive: true, encoding: "utf8" }).filter((f) => /\.tsx?$/.test(f)).map((f) => path.join(d, f)));
    const realTickers = /\b(AAPL|MSFT|GOOGL?|AMZN|NVDA|META|TSLA|BRK\.B|JPM|ADBE|NFLX)\b/;
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      expect(realTickers.test(src), `${f} menciona un ticker real`).toBe(false);
    }
  });
});
