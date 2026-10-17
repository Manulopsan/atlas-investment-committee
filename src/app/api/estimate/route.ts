import { AppSettingsSchema } from "@/lib/config";
import { getSettings } from "@/lib/db/repo";
import { planEstimate } from "@/lib/llm/cost";
import { subscriptionEstimate } from "@/lib/llm/subscription";
import { json } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pre-session cost estimate. Makes no model calls. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const parsed = AppSettingsSchema.safeParse(body?.settings);
  const settings = parsed.success ? parsed.data : getSettings();
  const est = planEstimate(settings, settings.investment.maxCandidates);
  if (settings.llmProvider === "subscription") est.subscription = await subscriptionEstimate(settings, est);
  return json(est);
}
