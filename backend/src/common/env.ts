/**
 * Reads a required environment variable, throwing at startup if it's missing.
 * Use this for secrets and connection strings the app can't safely run without,
 * so a misconfigured deploy fails fast instead of issuing tokens signed with
 * `undefined` or connecting nowhere.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
