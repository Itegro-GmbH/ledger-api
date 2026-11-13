// The Hono app (decisions/0001-ledger-api.md): `GET /health`, `GET /openapi.json` and
// `POST /v1/<operation>` for every operation in the catalog. Built by `createApp`, so tests and
// the deployment bind their own dependencies.
import { OPERATION_ERROR, OPERATIONS, type Operation, type OperationContext, type OperationOutcome } from "@ledger/operations";
import { Hono } from "hono";

import { anonymousContext, bearerSecret, type CallerStore } from "./caller";
import { httpStatusOf } from "./http-status";
import { buildOpenApiDocument } from "./openapi";

export type AppDeps = {
  operations?: readonly Operation[];
  /** `null` while no database is bound: non-public operations answer `unavailable`. */
  callers: CallerStore | null;
  version?: string;
};

export function createApp(deps: AppDeps) {
  const operations = deps.operations ?? OPERATIONS;
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, version: deps.version ?? "dev", database: deps.callers !== null }));

  app.get("/openapi.json", (c) => c.json(buildOpenApiDocument(operations, new URL(c.req.url).origin)));

  app.post("/v1/:operation", async (c) => {
    const operation = operations.find((candidate) => candidate.name === c.req.param("operation"));
    if (!operation) return reply(c, { ok: false, code: OPERATION_ERROR.notFound, details: { operation: c.req.param("operation") } });

    const body = await c.req.json().catch(() => undefined);
    const parsed = operation.input.safeParse(body ?? {});
    if (!parsed.success) return reply(c, { ok: false, code: OPERATION_ERROR.invalidInput, details: { issues: parsed.error.issues } });

    const context = await resolveContext(operation, deps.callers, {
      authorization: c.req.header("authorization"),
      tenant: c.req.header("ledger-tenant"),
      actor: c.req.header("ledger-actor"),
    });
    if ("code" in context) return reply(c, context);

    try {
      return reply(c, await operation.run(parsed.data, context));
    } catch (error) {
      console.error("[api] operation failed", { operation: operation.name, error: error instanceof Error ? error.name : "unknown" });
      return reply(c, { ok: false, code: OPERATION_ERROR.unknown });
    }
  });

  app.notFound((c) => reply(c, { ok: false, code: OPERATION_ERROR.notFound }));
  return app;
}

async function resolveContext(
  operation: Operation,
  callers: CallerStore | null,
  headers: { authorization: string | undefined; tenant: string | undefined; actor: string | undefined },
): Promise<OperationContext | { ok: false; code: string }> {
  if (operation.audience === "public") return anonymousContext(headers.actor);
  if (!callers) return { ok: false, code: OPERATION_ERROR.unavailable };
  const secret = bearerSecret(headers.authorization);
  const key = secret ? await callers.resolveKey(secret) : null;
  if (!key) return { ok: false, code: OPERATION_ERROR.unauthenticated };
  if (operation.scope && !key.scopes.includes(operation.scope)) return { ok: false, code: OPERATION_ERROR.forbidden };
  const base: OperationContext = { ...anonymousContext(headers.actor), platform: key.platform, environment: key.environment };
  if (operation.audience === "platform") return base;
  if (!headers.tenant) return { ok: false, code: OPERATION_ERROR.tenantRequired };
  const tenant = await callers.findTenant(key.platform.id, key.environment, headers.tenant);
  if (!tenant) return { ok: false, code: OPERATION_ERROR.tenantNotFound };
  return { ...base, tenant };
}

function reply(c: { json: (body: unknown, status: never) => Response }, outcome: OperationOutcome): Response {
  if (outcome.ok) return c.json({ ok: true, data: outcome.data }, 200 as never);
  return c.json({ ok: false, error: { code: outcome.code, ...(outcome.details ? { details: outcome.details } : {}) } }, httpStatusOf(outcome.code) as never);
}
