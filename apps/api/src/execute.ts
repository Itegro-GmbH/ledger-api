// Runs one operation call, the same way for HTTP and MCP (decisions/0001-ledger-api.md,
// "Request conventions"): validate the input, resolve platform, environment, tenant and actor,
// check the key's scope, replay or record the answer of a write under its idempotency key, run.
import { createHash } from "node:crypto";

import { OPERATION_ERROR, type Operation, type OperationContext, type OperationOutcome } from "@ledger/operations";

import { anonymousContext, bearerSecret, type CallerStore } from "./caller";

/** Stored answers of writes, per platform, environment and key. A port, bound to the database. */
export type IdempotencyStore = {
  get(platformId: string, environment: "test" | "live", key: string): Promise<{ operation: string; requestHash: string; outcome: OperationOutcome } | null>;
  /** Records the answer; a concurrent first write of the same key wins, later ones are ignored. */
  put(platformId: string, environment: "test" | "live", key: string, record: { operation: string; requestHash: string; outcome: OperationOutcome }): Promise<void>;
};

export type ExecuteDeps = { callers: CallerStore | null; idempotency: IdempotencyStore | null; bindServices?: (ctx: OperationContext) => OperationContext };

export type CallRequest = {
  input: unknown;
  authorization: string | undefined;
  tenant: string | undefined;
  actor: string | undefined;
  idempotencyKey: string | undefined;
  /** HTTP requires the key on every write; MCP clients have no header, so it stays optional there. */
  requireIdempotencyKey: boolean;
};

export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export async function executeOperation(operation: Operation, request: CallRequest, deps: ExecuteDeps): Promise<OperationOutcome> {
  const parsed = operation.input.safeParse(request.input ?? {});
  if (!parsed.success) return { ok: false, code: OPERATION_ERROR.invalidInput, details: { issues: parsed.error.issues } };

  const context = await resolveContext(operation, deps.callers, request);
  if ("code" in context) return context;
  const ctx = deps.bindServices ? deps.bindServices(context) : context;

  const key = request.idempotencyKey?.trim();
  const writes = operation.effect !== "read";
  if (writes && key && key.length > MAX_IDEMPOTENCY_KEY_LENGTH) return { ok: false, code: OPERATION_ERROR.invalidInput, details: { header: "Idempotency-Key" } };
  if (writes && !key && request.requireIdempotencyKey && operation.audience !== "public") return { ok: false, code: OPERATION_ERROR.idempotencyKeyRequired };
  if (!writes || !key || !ctx.platform || !ctx.environment || !deps.idempotency) return run(operation, parsed.data, ctx);

  // The tenant is part of the request: the same key for another tenant is a different request.
  const requestHash = hashRequest(operation.name, ctx.tenant?.id ?? null, parsed.data);
  const stored = await deps.idempotency.get(ctx.platform.id, ctx.environment, key);
  if (stored) {
    if (stored.operation !== operation.name || stored.requestHash !== requestHash) return { ok: false, code: OPERATION_ERROR.idempotencyConflict };
    return stored.outcome;
  }
  const outcome = await run(operation, parsed.data, ctx);
  // An unexpected failure is not recorded: the caller may retry with the same key.
  if (outcome.ok || outcome.code !== OPERATION_ERROR.unknown) await deps.idempotency.put(ctx.platform.id, ctx.environment, key, { operation: operation.name, requestHash, outcome });
  return outcome;
}

async function run(operation: Operation, input: unknown, ctx: OperationContext): Promise<OperationOutcome> {
  try {
    return await operation.run(input as never, ctx);
  } catch (error) {
    console.error("[api] operation failed", { operation: operation.name, error: error instanceof Error ? error.name : "unknown" });
    return { ok: false, code: OPERATION_ERROR.unknown };
  }
}

export function hashRequest(operation: string, tenantId: string | null, input: unknown): string {
  return createHash("sha256").update(JSON.stringify([operation, tenantId, input])).digest("hex");
}

async function resolveContext(operation: Operation, callers: CallerStore | null, request: CallRequest): Promise<OperationContext | { ok: false; code: string }> {
  if (operation.audience === "public") return anonymousContext(request.actor);
  if (!callers) return { ok: false, code: OPERATION_ERROR.unavailable };
  const secret = bearerSecret(request.authorization);
  const key = secret ? await callers.resolveKey(secret) : null;
  if (!key) return { ok: false, code: OPERATION_ERROR.unauthenticated };
  if (operation.scope && !key.scopes.includes(operation.scope)) return { ok: false, code: OPERATION_ERROR.forbidden };
  const base: OperationContext = { ...anonymousContext(request.actor), platform: key.platform, environment: key.environment };
  if (operation.audience === "platform") return base;
  if (!request.tenant) return { ok: false, code: OPERATION_ERROR.tenantRequired };
  const tenant = await callers.findTenant(key.platform.id, key.environment, request.tenant);
  if (!tenant) return { ok: false, code: OPERATION_ERROR.tenantNotFound };
  return { ...base, tenant };
}
