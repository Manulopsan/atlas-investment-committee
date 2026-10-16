import { AppSettingsSchema, serverEnv } from "@/lib/config";
import { getSettings, saveSettings } from "@/lib/db/repo";
import { fail, json, sameOrigin } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function envStatus() {
  const e = serverEnv();
  // Only booleans leave the server — never the secret values.
  return { anthropicKeyConfigured: e.anthropicKeyConfigured, secUserAgentConfigured: Boolean(e.secUserAgent), alphaVantageKeyConfigured: e.alphaVantageKeyConfigured };
}

export async function GET() {
  return json({ settings: getSettings(), env: envStatus() });
}

export async function PUT(req: Request) {
  if (!sameOrigin(req)) return fail("Origen no permitido", 403);
  const body = await req.json().catch(() => null);
  const parsed = AppSettingsSchema.safeParse(body?.settings);
  if (!parsed.success) return fail(`Configuración inválida: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return json({ settings: saveSettings(parsed.data), env: envStatus() });
}
