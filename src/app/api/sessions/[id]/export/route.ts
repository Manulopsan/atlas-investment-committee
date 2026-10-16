import { buildExport, EXPORT_TYPES, type ExportType } from "@/lib/export";
import { getSession } from "@/lib/db/repo";
import { AGENT_ROLES, type AgentRole } from "@/lib/types";
import { fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getSession(id)) return fail("Sesión no encontrada", 404);
  const url = new URL(req.url);
  const type = url.searchParams.get("type") as ExportType;
  if (!EXPORT_TYPES.includes(type)) return fail("Tipo de exportación inválido");
  const roleParam = url.searchParams.get("role");
  const role = roleParam && (AGENT_ROLES as readonly string[]).includes(roleParam) ? (roleParam as AgentRole) : undefined;
  const out = buildExport(id, type, role);
  return new Response(out.body, { headers: { "Content-Type": out.contentType, "Content-Disposition": `attachment; filename="${out.filename}"`, "Cache-Control": "no-store" } });
}
