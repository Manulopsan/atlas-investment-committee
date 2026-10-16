/**
 * ATLAS MCP server (stdio, JSON-RPC 2.0, newline-delimited).
 *
 * Launched by Claude Code for ONE agent task. It exposes exactly the data
 * tools authorised for that task plus its submit tool, enforces the same rules
 * as the in-process tool loop (round-1 evidence isolation, Zod validation),
 * and writes the accepted submission to the output file named in the task
 * context. Logs go to stderr; stdout carries protocol messages only.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

// Claude Code starts MCP servers in its own working directory: move to the app directory first.
if (process.env.ATLAS_APP_DIR) process.chdir(process.env.ATLAS_APP_DIR);

for (const f of [".env.local", ".env"]) {
  const p = path.join(process.cwd(), f);
  if (fs.existsSync(p)) process.loadEnvFile(p);
}

interface TaskContext {
  sessionId: string;
  taskKey: string;
  role: "QUALITY" | "VALUATION" | "RISK" | "CIO";
  phase: string;
  round1: boolean;
  dataTools: string[];
  submitName: string;
  submitDescription: string;
  outputFile: string;
}

type Json = Record<string, unknown>;

async function main() {
  const ctxFile = process.env.ATLAS_MCP_CONTEXT_FILE;
  if (!ctxFile || !fs.existsSync(ctxFile)) throw new Error("ATLAS_MCP_CONTEXT_FILE no definido");
  const task = JSON.parse(fs.readFileSync(ctxFile, "utf8")) as TaskContext;

  const { getSession } = await import("../src/lib/db/repo");
  const { runTool, toolDefinitions } = await import("../src/lib/orchestrator/tools");
  const { submitSchema, toInputSchema, formatZodError } = await import("../src/lib/agents/schemas");
  const { createMarketData } = await import("../src/lib/market-data");
  const { syntheticMarketData } = await import("../src/lib/market-data/synthetic");

  const session = getSession(task.sessionId);
  if (!session) throw new Error(`Sesión no encontrada: ${task.sessionId}`);
  const md = session.mode === "demo" ? { ...syntheticMarketData(), asOf: session.config.asOfDate ?? null } : createMarketData(session.mode, session.settings, { userPrices: session.config.userPrices });
  const schema = submitSchema(task.submitName, task.role);
  if (!schema) throw new Error(`Herramienta de envío desconocida: ${task.submitName}`);

  const toolCtx = { sessionId: task.sessionId, role: task.role, phase: task.phase, round1: task.round1, md, settings: session.settings };
  const tools = [
    ...toolDefinitions(task.dataTools).map((t) => ({ name: (t as { name: string }).name, description: (t as { description?: string }).description ?? "", inputSchema: (t as { input_schema: unknown }).input_schema })),
    { name: task.submitName, description: `${task.submitDescription} Llama a esta herramienta UNA vez con el resultado completo; después termina.`, inputSchema: toInputSchema(schema) },
  ];

  const send = (msg: Json) => process.stdout.write(JSON.stringify(msg) + "\n");
  const reply = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
  const error = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

  async function call(name: string, args: unknown) {
    if (name === task.submitName) {
      const parsed = schema!.safeParse(args);
      if (!parsed.success) return { content: [{ type: "text", text: `Resultado rechazado por la validación de la aplicación. Corrige y vuelve a enviar:\n${formatZodError(parsed.error)}` }], isError: true };
      fs.writeFileSync(task.outputFile, JSON.stringify(parsed.data), { mode: 0o600 });
      return { content: [{ type: "text", text: "Resultado aceptado y guardado. Has terminado esta tarea: no llames a más herramientas." }] };
    }
    if (!task.dataTools.includes(name)) return { content: [{ type: "text", text: `Herramienta no autorizada en esta fase: ${name}` }], isError: true };
    const r = await runTool(name, args, toolCtx);
    return { content: [{ type: "text", text: r.content }], isError: r.isError || undefined };
  }

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      return error(null, -32700, "JSON inválido");
    }
    const { id, method, params } = msg as { id?: unknown; method?: string; params?: Json };
    try {
      if (method === "initialize") {
        return reply(id, {
          protocolVersion: (params?.protocolVersion as string) ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "atlas", version: "2.1.0" },
        });
      }
      if (method === "notifications/initialized" || method?.startsWith("notifications/")) return;
      if (method === "ping") return reply(id, {});
      if (method === "tools/list") return reply(id, { tools });
      if (method === "tools/call") return reply(id, await call(String(params?.name), params?.arguments ?? {}));
      if (id !== undefined) return error(id, -32601, `Método no soportado: ${method}`);
    } catch (e) {
      if (id !== undefined) reply(id, { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
    }
  });
  rl.on("close", () => process.exit(0));
  process.stderr.write(`[atlas-mcp] ${task.taskKey} (${task.role}) listo con ${tools.length} herramientas\n`);
}

main().catch((e) => {
  process.stderr.write(`[atlas-mcp] ${e instanceof Error ? e.stack : e}\n`);
  process.exit(1);
});
