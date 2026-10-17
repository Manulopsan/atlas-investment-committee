/**
 * Evaluation CLI.
 *   npm run eval -- --demo                                  # synthetic, free, validates the harness
 *   npm run eval -- --file evals/cases.example.json         # prints the cost estimate only
 *   npm run eval -- --file evals/cases.example.json --confirm-cost   # PAID: runs the real committee per case
 */
import fs from "node:fs";
import path from "node:path";

for (const f of [".env.local", ".env"]) {
  const p = path.join(process.cwd(), f);
  if (fs.existsSync(p)) process.loadEnvFile(p);
}

async function main() {
  const { EvalFileSchema, DEMO_EVAL, estimateEval, runEval, writeEvalReport, evalMarkdown } = await import("../src/lib/evals/index");
  const { getSettings } = await import("../src/lib/db/repo");
  const { buildDeps, liveCredentialsError } = await import("../src/lib/orchestrator/manager");

  const args = process.argv.slice(2);
  const has = (f: string) => args.includes(f);
  const val = (f: string) => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const settings = getSettings();
  const demo = has("--demo");
  const file = demo ? DEMO_EVAL : EvalFileSchema.parse(JSON.parse(fs.readFileSync(val("--file") ?? "evals/cases.example.json", "utf8")));
  const mode = demo ? "demo" : "live";

  if (mode === "live") {
    const est = estimateEval(settings, file);
    console.log(`Evaluación "${file.name}": ${file.cases.length} casos.`);
    for (const c of est.perCase) console.log(`  - ${c.name}: ~${c.estimate.totalCalls} llamadas, ~${c.estimate.estCostUsd?.toFixed(2) ?? "n/d"} USD (modelo ${c.estimate.model})`);
    console.log(`Total estimado: ~${est.totalCalls} llamadas, ~${est.estCostUsd?.toFixed(2) ?? "n/d"} USD. Presupuesto máximo (límite por sesión × casos): ${est.maxBudgetUsd} USD.`);
    console.log("El coste real depende de los tokens y herramientas utilizados; cada sesión respeta su presupuesto.");
    if (!has("--confirm-cost")) {
      console.log("\nNo se ha hecho ninguna llamada. Repita con --confirm-cost para ejecutar (de pago).");
      process.exit(0);
    }
    const credErr = liveCredentialsError(settings.llmProvider);
    if (credErr) {
      console.error(credErr);
      process.exit(1);
    }
  }

  const run = await runEval(file, mode, settings, (s) => buildDeps(s), {
    onCase: (r) => console.log(`Caso "${r.case.name}" → ${r.status} (${r.outcomes.filter((o) => o.realizedCagr !== null).length}/${r.outcomes.length} con resultado realizado)`),
  });
  const out = writeEvalReport(run);
  console.log("\n" + evalMarkdown(run));
  console.log(`\nInforme guardado en ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
