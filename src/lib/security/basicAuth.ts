/** Constant-time string comparison (works in the edge runtime). */
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/**
 * Optional protection when the app is exposed beyond localhost:
 * ATLAS_BASIC_AUTH="user:password". Returns true when access is allowed.
 */
export function basicAuthAllows(header: string | null, expected: string | undefined): boolean {
  if (!expected) return true;
  if (!header?.startsWith("Basic ")) return false;
  try {
    return safeEqual(atob(header.slice(6).trim()), expected);
  } catch {
    return false;
  }
}
