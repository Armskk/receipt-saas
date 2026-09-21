// Shared config for integration tests. RLS can't be mocked, so these run
// against a real Postgres: TEST_DATABASE_URL is the owner role (migrates and
// seeds, bypasses RLS) and TEST_APP_DATABASE_URL is the `receipts_app` role
// (what the app uses, subject to RLS). Point both at a dedicated *_test database.

export function testUrls(): { ownerUrl: string; appUrl: string } {
  const ownerUrl = process.env.TEST_DATABASE_URL;
  const appUrl = process.env.TEST_APP_DATABASE_URL;
  if (!ownerUrl || !appUrl) {
    throw new Error(
      'Integration tests need TEST_DATABASE_URL (owner role) and TEST_APP_DATABASE_URL ' +
        '(receipts_app role) pointing at a dedicated test database. ' +
        'Start Postgres with `docker compose up -d postgres` and see docs/decisions.md.',
    );
  }
  return { ownerUrl, appUrl };
}

export function withParam(url: string, key: string, value: string): string {
  const u = new URL(url);
  u.searchParams.set(key, value);
  return u.toString();
}

export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export function databaseName(url: string): string {
  return new URL(url).pathname.slice(1);
}
