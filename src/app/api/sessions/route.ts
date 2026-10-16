import { z } from "zod";
import { createSession, getSettings } from "@/lib/db/repo";
import { planEstimate, priceFor } from "@/lib/llm/cost";
import { startSession } from "@/lib/orchestrator/manager";
import { claudeCodeStatus } from "@/lib/llm/claudeCode";
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
  if (mode === "live" && settings.provider === "claude_code") {
    const st = claudeCodeStatus(settings.claudeCodePath);
    if (!st.available || !st.loggedIn || st.usesApiKey) return fail(st.error ?? "Claude Code no está disponible", 412);
    if (consent !== true) return fail("Se requiere consentimiento explícito: la sesión consumirá límites de uso de su suscripción de Claude.", 412);
  } else if (mode === "live") {
    if (!process.env.ANTHROPIC_API_KEY?.trim()) return fail("Falta ANTHROPIC_API_KEY en el servidor (.env.local). Use el modo demostración o el análisis en seco.", 412);
    if (!priceFor(settings, settings.model) || !priceFor(settings, settings.debateModel)) return fail("Configure el precio de los modelos seleccionados antes de iniciar: sin precio no se puede controlar el presupuesto.", 412);
    if (consent !== true) return fail("Se requiere consentimiento explícito para iniciar llamadas de pago al modelo.", 412);
  }
  const s = createSession({ mode, settings, estimate });
  try {
    startSession(s.id);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 500);
  }
  return json({ id: s.id }, 201);
}
