// The Vercel function's entry (bundled by scripts/build.mjs into one file): a Node request
// listener around the Hono app, so the platform's Node runtime serves it unchanged.
import { getRequestListener } from "@hono/node-server";

import { createApp } from "./app";

export default getRequestListener(createApp({ callers: null, version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) }).fetch);
