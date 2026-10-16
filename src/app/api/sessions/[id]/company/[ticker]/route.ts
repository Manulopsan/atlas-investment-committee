import { companyView } from "@/lib/view";
import { fail, json } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; ticker: string }> }) {
  const { id, ticker } = await params;
  if (!/^[A-Za-z0-9.\-]{1,12}$/.test(ticker)) return fail("Ticker inválido");
  const v = companyView(id, ticker);
  return v ? json(v) : fail("Sesión no encontrada", 404);
}
