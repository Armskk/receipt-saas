// Which browser origins may call the API. The dashboard is the only browser client; the
// LINE/Telegram webhooks are server-to-server and send no Origin header, so CORS never applies to them.
const DEV_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

/**
 * Allowed origins from CORS_ORIGINS (comma-separated, e.g. `https://app.example.com`).
 * - set: exactly those origins — each must be a bare origin (scheme + host [+ port]); `*` is refused.
 * - unset in production: refuses to start (an open API is not a sane default, and neither is a silent lock-out).
 * - unset elsewhere: the local dashboard on port 3000.
 */
export function resolveCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.CORS_ORIGINS?.trim();
  if (!raw) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'Missing required environment variable: CORS_ORIGINS (the dashboard origin(s), e.g. https://app.example.com)',
      );
    }
    return DEV_ORIGINS;
  }

  const origins = raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  for (const origin of origins) {
    let normalized: string | null = null;
    try {
      normalized = new URL(origin).origin;
    } catch {
      /* falls through to the error below */
    }
    if (origin === '*' || normalized !== origin) {
      throw new Error(
        `Invalid CORS_ORIGINS entry "${origin}": use explicit origins like https://app.example.com (no "*", paths or missing scheme)`,
      );
    }
  }
  return origins;
}
