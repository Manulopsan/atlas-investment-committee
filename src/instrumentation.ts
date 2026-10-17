/** Server start-up hook (Next.js): the in-process runner also resumes sessions paused by the subscription limit. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./instrumentation-node");
}
