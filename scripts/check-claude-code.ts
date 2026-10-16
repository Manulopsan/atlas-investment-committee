/**
 * Connection check for the subscription provider:
 *   npm run check:claude
 * Verifies that Claude Code is installed and signed in with a Claude
 * subscription, then runs ONE tiny agent task (Haiku, synthetic data,
 * ≤ 5 turns) through the ATLAS MCP server. Uses a temporary database.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

for (const f of [".env.local", ".env"]) {
  const p = path.join(process.cwd(), f);
  if (fs.existsSync(p)) process.loadEnvFile(p);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-check-"));
process.env.ATLAS_DB_PATH = path.join(tmp, "check.db");

async function main() {
  const { createSession } = await import("../src/lib/db/repo");
  const { defaultSettings } = await import("../src/lib/config");
  const { ClaudeCodeAdapter, claudeCodeStatus } = await import("../src/lib/llm/claudeCode");
  const { VerificationSchema } = await import("../src/lib/agents/schemas");
  const settings = defaultSettings();
  const st = claudeCodeStatus(settings.claudeCodePath);
  console.log(`Claude Code: ${st.available ? st.version : "NO ENCONTRADO"} · sesión: ${st.loggedIn ? "iniciada" : "no iniciada"} · método: ${st.authMethod ?? "n/d"}`);
  if (st.error || !st.available || !st.loggedIn) {
    console.error(`✗ ${st.error ?? "Claude Code no disponible"}`);
    process.exit(1);
  }
  const s = createSession({ mode: "demo", settings });
  const t0 = Date.now();
  const r = await new ClaudeCodeAdapter(settings).runTask(
    {
      sessionId: s.id, taskKey: "check", phase: "VERIFICATION", role: "RISK", model: process.env.ATLAS_CHECK_MODEL ?? "claude-haiku-5-5",
      prompt: "Prueba técnica de conexión. Llama a get_price con ticker DEMO-A y después a submit_verification con issue_id 1, outcome UNRESOLVABLE, corrected_value null, unit null, evidence_ids con el EV-n devuelto y una explicación breve.",
      dataTools: ["get_price"], submit: { name: "submit_verification", description: "Resultado de la verificación.", schema: VerificationSchema }, maxIterations: 3,
    },
    { isStopRequested: () => false },
  );
  console.log(`✓ Agente ejecutado con su suscripción en ${((Date.now() - t0) / 1000).toFixed(1)} s (${r.iterations} turnos).`);
  console.log(`  Resultado validado: ${JSON.stringify(r.output)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
