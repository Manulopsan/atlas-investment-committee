/** Removes anything that looks like a secret before content leaves the server (exports, API responses, logs). */
const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]{8,}/g, // Anthropic keys
  /(apikey|api_key|x-api-key|authorization)\s*[=:]\s*[^\s&"',]+/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const name of ["ANTHROPIC_API_KEY", "ALPHAVANTAGE_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
    const v = process.env[name]?.trim();
    if (v && v.length >= 6) out = out.split(v).join("[REDACTED]");
  }
  for (const p of PATTERNS) out = out.replace(p, (m) => (m.toLowerCase().startsWith("sk-ant-") ? "[REDACTED]" : m.replace(/([=:]\s*).+$/, "$1[REDACTED]")));
  return out;
}

export function redactDeep<T>(value: T): T {
  return JSON.parse(redactSecrets(JSON.stringify(value))) as T;
}
