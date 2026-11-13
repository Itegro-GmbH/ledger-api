// Creates a platform and its first API key against the database of `DATABASE_URL`, and prints
// the key's secret once (it is stored only as a hash). An owner's tool, not an operation:
// platforms are not self-service.
//
//   DATABASE_URL=... pnpm --filter @ledger/api create-platform --name "reserwirt" --environment test [--id <uuid>]
import { parseArgs } from "node:util";

import { createDb, createDrizzleRepositories } from "@ledger/db";
import { Pool } from "pg";

const { values } = parseArgs({ options: { name: { type: "string" }, environment: { type: "string", default: "test" }, id: { type: "string" }, scopes: { type: "string", default: "read,write" } } });
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !values.name || (values.environment !== "test" && values.environment !== "live")) {
  console.error('usage: DATABASE_URL=... create-platform --name <name> --environment test|live [--id <uuid>] [--scopes read,write,filing]');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const repos = createDrizzleRepositories(createDb(pool));
  const platform = (values.id ? await repos.platform.findById(values.id) : null) ?? (await repos.platform.create({ id: values.id, name: values.name }));
  const scopes = values.scopes!.split(",").map((scope) => scope.trim()) as ("read" | "write" | "filing")[];
  const { key, secret } = await repos.apiKey.create({ platformId: platform.id, environment: values.environment, name: `${values.name} ${values.environment}`, scopes });
  console.log(JSON.stringify({ platformId: platform.id, keyId: key.id, environment: key.environment, scopes: key.scopes }, null, 2));
  console.log(`secret (shown once): ${secret}`);
} finally {
  await pool.end();
}
