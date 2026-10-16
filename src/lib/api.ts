import { NextResponse } from "next/server";
import { redactDeep } from "./security/redact";

export function json(data: unknown, status = 200) {
  return NextResponse.json(redactDeep(data), { status, headers: { "Cache-Control": "no-store" } });
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

/** Mutations are only accepted from the app's own origin (basic CSRF protection for a local app). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.get("x-forwarded-host") ?? req.headers.get("host"));
  } catch {
    return false;
  }
}
