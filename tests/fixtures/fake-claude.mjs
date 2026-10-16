#!/usr/bin/env node
// Fake Claude Code CLI for tests: checks the isolation flags and writes a canned submission.
import fs from "node:fs";
const args = process.argv.slice(2);
const val = (f) => args[args.indexOf(f) + 1];
const fail = (msg, code = 3) => { process.stdout.write(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: msg, num_turns: 0 })); process.exit(code); };
if (process.env.ANTHROPIC_API_KEY) fail("API key leaked into the CLI environment");
if (!args.includes("-p") || val("--output-format") !== "json") fail("expected -p --output-format json");
if (val("--tools") !== "") fail("built-in tools must be disabled");
if (!args.includes("--strict-mcp-config") || !args.includes("--no-session-persistence")) fail("missing isolation flags");
const mcp = JSON.parse(fs.readFileSync(val("--mcp-config"), "utf8"));
const ctx = JSON.parse(fs.readFileSync(mcp.mcpServers.atlas.env.ATLAS_MCP_CONTEXT_FILE, "utf8"));
const allowed = val("--allowedTools").split(",");
if (!allowed.includes(`mcp__atlas__${ctx.submitName}`)) fail("submit tool not allowed");
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  const mode = process.env.FAKE_MODE ?? "ok";
  if (mode === "ok") fs.writeFileSync(ctx.outputFile, process.env.FAKE_OUTPUT);
  const result = mode === "limit" ? "Claude AI usage limit reached|1760000000" : mode === "nosubmit" ? "No he podido completar la tarea" : `ok:${stdin.length}`;
  process.stdout.write(JSON.stringify({ type: "result", subtype: mode === "ok" ? "success" : "error_max_turns", is_error: mode !== "ok", result, num_turns: 2, total_cost_usd: 0.0123, usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 } }));
});
