// Local development server: `pnpm dev`.
import { serve } from "@hono/node-server";

import { createApp } from "./app";

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp({ callers: null }).fetch, port });
console.log(`ledger-api on http://localhost:${port}`);
