// Local development server: `pnpm dev`, with the database of `DATABASE_URL` if set.
import { serve } from "@hono/node-server";

import { createApp } from "./app";
import { createDatabaseDeps, poolFor } from "./composition";

const port = Number(process.env.PORT ?? 8787);
const databaseUrl = process.env.DATABASE_URL;
serve({ fetch: createApp(databaseUrl ? createDatabaseDeps(poolFor(databaseUrl)) : { callers: null }).fetch, port });
console.log(`ledger-api on http://localhost:${port}${databaseUrl ? "" : " (no database)"}`);
