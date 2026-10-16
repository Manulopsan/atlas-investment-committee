import { AppSettingsSchema, serverEnv } from "@/lib/config";
import { getSettings, saveSettings } from "@/lib/db/repo";
import { fail, json, sameOrigin } from "@/lib/api";
import { claudeCodeStatus, type ClaudeCodeStatus } from "@/lib/llm/claudeCode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let ccCache: { at: number; bin: string; v: ClaudeCodeStatus } | null = null;
function ccStatus(bin: string) {
  if (!ccCache || ccCache.bin !== bin || Date.now() - ccCache.at > 60_000) ccCache = { at: Date.now(), bin, v: claudeCodeStatus(bin) };
  return ccCache.v;
}

function envStatus(bin: string) {
  const e = serverEnv();
  // Only booleans / status flags leave the server — never secret values.
  return { anthropicKeyConfigured: e.anthropicKeyConfigured, secUserAgentConfigured: Boolean(e.secUserAgent), alphaVantageKeyConfigured: e.alphaVantageKeyConfigured, claudeCode: ccStatus(bin) };
}

export async function GET() {
  const settings = getSettings();
  return json({ settings, env: envStatus(settings.claudeCodePath) });
}

export async function PUT(req: Request) {
  if (!sameOrigin(req)) return fail("Origen no permitido", 403);
  const body = await req.json().catch(() => null);
  const parsed = AppSettingsSchema.safeParse(body?.settings);
  if (!parsed.success) return fail(`Configuración inválida: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const saved = saveSettings(parsed.data);
  ccCache = null;
  return json({ settings: saved, env: envStatus(saved.claudeCodePath) });
}
