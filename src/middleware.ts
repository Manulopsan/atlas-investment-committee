import { NextResponse, type NextRequest } from "next/server";
import { basicAuthAllows } from "./lib/security/basicAuth";

export function middleware(req: NextRequest) {
  if (basicAuthAllows(req.headers.get("authorization"), process.env.ATLAS_BASIC_AUTH?.trim() || undefined)) return NextResponse.next();
  return new NextResponse("Autenticación requerida", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="ATLAS", charset="UTF-8"' } });
}

export const config = { matcher: ["/((?!_next/static|_next/image|icon.svg).*)"] };
