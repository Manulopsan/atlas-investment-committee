import { runnerMode, startAutoResumeLoop } from "./lib/orchestrator/manager";

if (runnerMode() === "inprocess") startAutoResumeLoop((m) => console.log(`[atlas] ${m}`));
