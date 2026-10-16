import { parseTickerCsv } from "@/lib/market-data";
import { fail, json, sameOrigin } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail("Origen no permitido", 403);
  const body = await req.json().catch(() => null);
  if (typeof body?.csv !== "string" || body.csv.length > 200_000) return fail("CSV inválido o demasiado grande");
  return json(parseTickerCsv(body.csv));
}
