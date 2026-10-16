import { getSession, sessionSignature } from "@/lib/db/repo";
import { TERMINAL_STATUSES } from "@/lib/state";
import { fail } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events: pushes an "update" event whenever the persisted state of
 * the session changes (status, tasks, messages, evidence, issues, usage). The
 * client then refetches the view. Works across processes because it watches
 * the database, not in-memory state.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getSession(id)) return fail("Sesión no encontrada", 404);
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      let last = "";
      let ticks = 0;
      const send = (chunk: string) => {
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          if (timer) clearInterval(timer);
        }
      };
      const check = () => {
        ticks++;
        const sig = sessionSignature(id);
        if (sig === null) {
          send(`event: gone\ndata: {}\n\n`);
          if (timer) clearInterval(timer);
          controller.close();
          return;
        }
        if (sig !== last) {
          last = sig;
          send(`event: update\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
        } else if (ticks % 15 === 0) {
          send(`: ping\n\n`);
        }
        const s = getSession(id);
        // Close idle streams of finished sessions and long-lived ones (the browser reconnects automatically).
        if ((s && TERMINAL_STATUSES.includes(s.status) && ticks > 3) || ticks > 1800) {
          if (timer) clearInterval(timer);
          controller.close();
        }
      };
      send(`retry: 3000\n\n`);
      check();
      timer = setInterval(check, 1000);
      req.signal.addEventListener("abort", () => {
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}
