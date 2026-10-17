import { z } from "zod";
import { createSession, getSettings } from "@/lib/db/repo";
import { planEstimate, priceFor } from "@/lib/llm/cost";
import { liveCredentialsError, startSession } from "@/lib/orchestrator/manager";
import { sessionSummaries } from "@/lib/view";
import { fail, json, sameOrigin } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return json({ sessions: sessionSummaries() });
}

const Body = z.object({ mode: z.enum(["live", "dry_run", "demo"]), consent: z.boolean().optional() });

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail("Origen no permitido", 403);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Solicitud inválida");
  const { mode, consent } = parsed.data;
  const settings = getSettings();
  const estimate = planEstimate(settings, settings.investment.maxCandidates);
  if (mode === "live") {
    const credErr = liveCredentialsError(settings.llmProvider);
    if (credErr) return fail(`${credErr}. Mientras tanto puede usar el modo demostración o el análisis en seco.`, 412);
    if (settings.llmProvider === "api" && (!priceFor(settings, settings.model) || !priceFor(settings, settings.debateModel))) return fail("Configure el precio de los modelos seleccionados antes de iniciar: sin precio no se puede controlar el presupuesto.", 412);
    if (consent !== true) return fail(settings.llmProvider === "subscription" ? "Se requiere consentimiento explícito para consumir el uso de su suscripción de Claude." : "Se requiere consentimiento explícito para iniciar llamadas de pago al modelo.", 412);
  }
  const s = createSession({ mode, settings, estimate });
  try {
    startSession(s.id);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 500);
  }
  return json({ id: s.id }, 201);
}
