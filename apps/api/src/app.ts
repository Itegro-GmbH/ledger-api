// The Hono app (decisions/0001-ledger-api.md): `GET /health`, `GET /openapi.json`,
// `POST /v1/<operation>` for every operation in the catalog, and the same operations as MCP
// tools under `/mcp`. Built by `createApp`, so tests and the deployment bind their own
// dependencies.
import { OPERATION_ERROR, OPERATIONS, type Operation, type OperationOutcome } from "@ledger/operations";
import { Hono } from "hono";

import type { CallerStore } from "./caller";
import { executeOperation, type ExecuteDeps, type IdempotencyStore } from "./execute";
import { httpStatusOf } from "./http-status";
import { createMcpEndpoint } from "./mcp";
import { buildOpenApiDocument } from "./openapi";

export type AppDeps = {
  operations?: readonly Operation[];
  /** `null` while no database is bound: non-public operations answer `unavailable`. */
  callers: CallerStore | null;
  idempotency?: IdempotencyStore | null;
  bindServices?: ExecuteDeps["bindServices"];
  version?: string;
};

export function createApp(deps: AppDeps) {
  const operations = deps.operations ?? OPERATIONS;
  const execute: ExecuteDeps = { callers: deps.callers, idempotency: deps.idempotency ?? null, bindServices: deps.bindServices };
  const mcp = createMcpEndpoint(operations, execute);
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, version: deps.version ?? "dev", database: deps.callers !== null }));

  app.get("/openapi.json", (c) => c.json(buildOpenApiDocument(operations, new URL(c.req.url).origin)));

  app.post("/v1/:operation", async (c) => {
    const operation = operations.find((candidate) => candidate.name === c.req.param("operation"));
    if (!operation) return reply(c, { ok: false, code: OPERATION_ERROR.notFound, details: { operation: c.req.param("operation") } });
    const input = await c.req.json().catch(() => undefined);
    const outcome = await executeOperation(
      operation,
      {
        input,
        authorization: c.req.header("authorization"),
        tenant: c.req.header("ledger-tenant"),
        actor: c.req.header("ledger-actor"),
        idempotencyKey: c.req.header("idempotency-key"),
        requireIdempotencyKey: true,
      },
      execute,
    );
    return reply(c, outcome);
  });

  app.all("/mcp", (c) => mcp(c.req.raw));

  app.notFound((c) => reply(c, { ok: false, code: OPERATION_ERROR.notFound }));
  return app;
}

function reply(c: { json: (body: unknown, status: never) => Response }, outcome: OperationOutcome): Response {
  if (outcome.ok) return c.json({ ok: true, data: outcome.data }, 200 as never);
  return c.json({ ok: false, error: { code: outcome.code, ...(outcome.details ? { details: outcome.details } : {}) } }, httpStatusOf(outcome.code) as never);
}
