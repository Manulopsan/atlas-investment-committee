import { describe, it, expect, beforeEach } from "vitest";
import { freshDb, demoSession, testSettings } from "./helpers";
import { runSession } from "@/lib/orchestrator/runner";
import { ScriptedAdapter } from "@/lib/llm/scripted";
import { syntheticMarketData } from "@/lib/market-data/synthetic";
import { getFinalReport, getSession, listErrors, listMessages, listReports, listTasks, listVerdicts, listIssues } from "@/lib/db/repo";

describe("full committee flow (scripted adapter, synthetic data)", () => {
  beforeEach(() => freshDb());
  it("runs all phases to COMPLETED", async () => {
    const settings = testSettings((x) => void (x.investment.maxDebateCompanies = 5));
    const s = demoSession(settings);
    const adapter = new ScriptedAdapter();
    const out = await runSession(s.id, { adapter, md: syntheticMarketData(), settings });
    expect(listErrors(s.id)).toHaveLength(0);
    expect(listTasks(s.id).every((t) => t.status === "SUCCEEDED")).toBe(true);
    expect(out.status).toBe("COMPLETED");
    expect(listReports(s.id).length).toBeGreaterThanOrEqual(8);
    expect(listMessages(s.id).length).toBeGreaterThan(10);
    const fr = getFinalReport(s.id);
    expect(fr?.validated).toBe(true);
    const verdicts = Object.fromEntries(listVerdicts(s.id).map((v) => [v.ticker, v.verdict]));
    // The synthetic universe exercises every engine rule: buy, too expensive, watchlist and a critical veto.
    expect(verdicts["DEMO-A"]).toBe("POTENTIAL_BUY");
    expect(verdicts["DEMO-B"]).toBe("EXCELLENT_TOO_EXPENSIVE");
    expect(verdicts["DEMO-C"]).toBe("EXCLUDE");
    expect(listVerdicts(s.id).filter((v) => v.rank !== null).length).toBeLessThanOrEqual(5);
    expect(getSession(s.id)?.convergence).toBeTruthy();
    expect(listIssues(s.id).length).toBeGreaterThan(0);
  });
});
