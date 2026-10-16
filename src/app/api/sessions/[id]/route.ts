import { deleteSession, getSession } from "@/lib/db/repo";
import { isRunning } from "@/lib/orchestrator/manager";
import { sessionView } from "@/lib/view";
import { fail, json, sameOrigin } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const v = sessionView(id);
  return v ? json(v) : fail("Sesión no encontrada", 404);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return fail("Origen no permitido", 403);
  const { id } = await params;
  if (!getSession(id)) return fail("Sesión no encontrada", 404);
  if (isRunning(id)) return fail("Detenga la sesión antes de eliminarla", 409);
  deleteSession(id);
  return json({ ok: true });
}
