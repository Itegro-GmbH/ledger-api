// `TEST_DATABASE_URL` (CI: a throwaway Postgres 17 service container; locally: a throwaway Docker
// container). Refuses any host but a local one, so a test run can never reach a shared database.
// No vitest import: the global setup uses it too.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (CI sets it; locally point it at a throwaway Postgres).");
  const host = new URL(url).hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host)) throw new Error(`TEST_DATABASE_URL points at "${host}", not a local host. Refusing to run against a non-local database.`);
  return url;
}
