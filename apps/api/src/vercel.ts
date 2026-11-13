// The Vercel function's entry (bundled by scripts/build.mjs into one file): a Node request
// listener around the Hono app, so the platform's Node runtime serves it unchanged. Without
// `DATABASE_URL` only public operations work; the rest answer `unavailable`.
import { getRequestListener } from "@hono/node-server";

import { createApp } from "./app";
import { createDatabaseDeps, poolFor } from "./composition";

const databaseUrl = process.env.DATABASE_URL;
const version = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7);

export default getRequestListener(createApp(databaseUrl ? { ...createDatabaseDeps(poolFor(databaseUrl)), version } : { callers: null, version }).fetch);
