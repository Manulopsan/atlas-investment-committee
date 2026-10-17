/**
 * ATLAS worker: executes queued committee sessions outside the web server.
 *   1) set ATLAS_RUNNER=worker in .env.local (so the web app only enqueues)
 *   2) npm run worker   (in a second terminal, next to `npm run dev` / `npm start`)
 * Sessions whose runner died are picked up again once their lease expires;
 * completed tasks are never re-executed.
 */
import fs from "node:fs";
import path from "node:path";

for (const f of [".env.local", ".env"]) {
  const p = path.join(process.cwd(), f);
  if (fs.existsSync(p)) process.loadEnvFile(p);
}

async function main() {
  const { listRunnable, getSession } = await import("../src/lib/db/repo");
  const { ownerId, runWithLease, startAutoResumeLoop } = await import("../src/lib/orchestrator/manager");
  const { prepareResume } = await import("../src/lib/orchestrator/runner");

  const owner = ownerId("worker");
  const maxParallel = Math.max(1, Number(process.env.ATLAS_WORKER_CONCURRENCY ?? 1));
  const active = new Set<string>();
  let stopping = false;

  function log(msg: string) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
  }

  async function tick() {
    if (stopping) return;
    for (const s of listRunnable(maxParallel * 2)) {
      if (active.size >= maxParallel) break;
      if (active.has(s.id)) continue;
      active.add(s.id);
      log(`Ejecutando sesión ${s.id} (${s.mode}, ${s.status})`);
      prepareResume(s.id);
      runWithLease(s.id, owner)
        .then((ran) => log(ran ? `Sesión ${s.id} → ${getSession(s.id)?.status}` : `Sesión ${s.id} ocupada por otro proceso`))
        .catch((e) => log(`Error en ${s.id}: ${e instanceof Error ? e.message : e}`))
        .finally(() => active.delete(s.id));
    }
  }

  log(`Worker ${owner} iniciado (paralelo máx. ${maxParallel}). Ctrl+C para salir.`);
  const timer = setInterval(() => void tick(), 2_000);
  // Sessions paused by the Claude subscription limit are re-queued once the usage window resets.
  startAutoResumeLoop(log);
  void tick();

  function shutdown() {
    if (stopping) process.exit(1);
    stopping = true;
    clearInterval(timer);
    log(active.size ? `Esperando a ${active.size} sesión(es) en curso… (Ctrl+C otra vez para forzar; la sesión se podrá reanudar)` : "Detenido.");
    if (!active.size) process.exit(0);
    const wait = setInterval(() => {
      if (!active.size) {
        clearInterval(wait);
        process.exit(0);
      }
    }, 500);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
