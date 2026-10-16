import { getSettings } from "@/lib/db/repo";
import { DEMO_EVAL, listEvalRuns, runEval } from "@/lib/evals";
import { buildDeps } from "@/lib/orchestrator/manager";
import { fail, json, sameOrigin } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return json({ runs: listEvalRuns() });
}

/** Only the synthetic demo evaluation can be started from the browser; paid evaluations run from the CLI. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail("Origen no permitido", 403);
  const body = await req.json().catch(() => ({}));
  if (body?.mode !== "demo") return fail("Las evaluaciones reales se lanzan con `npm run eval -- --file … --confirm-cost` (requieren confirmar el coste).", 400);
  void runEval(DEMO_EVAL, "demo", getSettings(), (s) => buildDeps(s));
  return json({ ok: true }, 202);
}
