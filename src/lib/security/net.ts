import dns from "node:dns/promises";
import net from "node:net";

/** Basic SSRF guard: only public https hosts may be fetched on behalf of an agent. */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
}

export class UnsafeUrlError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "UnsafeUrlError";
  }
}

export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeUrlError("URL no válida");
  }
  if (u.protocol !== "https:") throw new UnsafeUrlError("Solo se permiten URLs https");
  if (u.username || u.password) throw new UnsafeUrlError("URL con credenciales no permitida");
  const host = u.hostname;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new UnsafeUrlError("Host local no permitido");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new UnsafeUrlError("IP privada no permitida");
    return u;
  }
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (addrs.some((a) => isPrivateIp(a.address))) throw new UnsafeUrlError("El host resuelve a una IP privada");
  } catch (e) {
    if (e instanceof UnsafeUrlError) throw e;
    // DNS failures are reported by the fetch itself.
  }
  return u;
}

export interface FetchTextResult {
  ok: boolean;
  status: number;
  url: string;
  contentType: string | null;
  text: string;
  truncated: boolean;
  error?: string;
}

/** Fetch with timeout and size limit. The body is untrusted data. */
export async function fetchText(raw: string, opts: { headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch } = {}): Promise<FetchTextResult> {
  const f = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? 3_000_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await f(raw, { headers: opts.headers, signal: ctrl.signal, redirect: "follow" });
    const buf = new Uint8Array(await res.arrayBuffer());
    const truncated = buf.byteLength > maxBytes;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(truncated ? buf.slice(0, maxBytes) : buf);
    return { ok: res.ok, status: res.status, url: res.url || raw, contentType: res.headers.get("content-type"), text, truncated };
  } catch (e) {
    return { ok: false, status: 0, url: raw, contentType: null, text: "", truncated: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}
