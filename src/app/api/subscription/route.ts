import { getSettings } from "@/lib/db/repo";
import { fetchSubscriptionStatus, subscriptionCalibration } from "@/lib/llm/subscription";
import { json } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Current Claude subscription usage windows (no model call; cached for a minute). */
export async function GET() {
  const settings = getSettings();
  if (settings.llmProvider !== "subscription") return json({ provider: settings.llmProvider });
  const st = await fetchSubscriptionStatus();
  return json({
    provider: "subscription",
    loggedIn: st.loggedIn,
    subscriptionType: st.subscriptionType,
    status: st.status,
    fiveHour: st.fiveHour,
    sevenDay: st.sevenDay,
    updatedAt: new Date(st.updatedAt).toISOString(),
    stopAtPct: settings.subscriptionStopAtPct,
    calibration: subscriptionCalibration(),
  });
}
