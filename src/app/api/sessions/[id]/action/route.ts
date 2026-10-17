import { z } from "zod";
import { abandonSession, resumeSession, retryTask, setAutoResume, stopSession } from "@/lib/orchestrator/manager";
import { getSession } from "@/lib/db/repo";
import { fail, json, sameOrigin } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ action: z.enum(["stop", "resume", "retry", "abandon", "autoresume_on", "autoresume_off"]), taskKey: z.string().max(200).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return fail("Origen no permitido", 403);
  const { id } = await params;
  if (!getSession(id)) return fail("Sesión no encontrada", 404);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Acción inválida");
  try {
    const { action, taskKey } = parsed.data;
    if (action === "stop") stopSession(id);
    else if (action === "resume") resumeSession(id);
    else if (action === "abandon") abandonSession(id);
    else if (action === "autoresume_on" || action === "autoresume_off") setAutoResume(id, action === "autoresume_on");
    else if (action === "retry") {
      if (!taskKey) return fail("Falta taskKey");
      retryTask(id, taskKey);
    }
    return json({ ok: true });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 409);
  }
}
