// The shape every operation is declared in (decisions/0001-ledger-api.md, "One operation
// catalog, three surfaces"). One definition becomes `POST /v1/<name>`, an OpenAPI path and an
// MCP tool with the same name, description and input schema. Neutral: no I/O, no HTTP.
import { z } from "zod";

/** How an operation changes data: drives the MCP annotations and the idempotency rule. */
export const OPERATION_EFFECTS = ["read", "write", "destructive"] as const;
export type OperationEffect = (typeof OPERATION_EFFECTS)[number];

/**
 * Who may call an operation:
 * - `public`: reference data (tax codes, chart templates), no key needed;
 * - `platform`: a platform key, no tenant (creating and listing tenants);
 * - `tenant`: a platform key and a `Ledger-Tenant` header naming one of its tenants.
 */
export const OPERATION_AUDIENCES = ["public", "platform", "tenant"] as const;
export type OperationAudience = (typeof OPERATION_AUDIENCES)[number];

/** Key scopes. `filing` is separate because submitting a filing locks a period for good. */
export const KEY_SCOPES = ["read", "write", "filing"] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

/** Stable error codes every surface returns; operations add their own (the ledger's codes). */
export const OPERATION_ERROR = {
  invalidInput: "invalid_input",
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  tenantRequired: "tenant_required",
  tenantNotFound: "tenant_not_found",
  notFound: "not_found",
  idempotencyKeyRequired: "idempotency_key_required",
  idempotencyConflict: "idempotency_conflict",
  unavailable: "unavailable",
  unknown: "unknown",
} as const;

export type OperationOutcome = { ok: true; data: Record<string, unknown> } | { ok: false; code: string; details?: Record<string, unknown> };

/** The caller as an operation sees it, resolved before `run`. */
export type OperationContext = {
  platform: { id: string; name: string } | null;
  tenant: { id: string; name: string } | null;
  /** `Ledger-Actor`: who acted on the platform's side, recorded in revisions. */
  actor: string | null;
  environment: "test" | "live" | null;
};

export type OperationInput = z.ZodObject;

export type Operation<S extends OperationInput = OperationInput> = {
  name: string;
  title: string;
  /** English, for developers and models: what it does, when to use it, what it returns. A
   * destructive operation says that it cannot be undone. */
  description: string;
  input: S;
  audience: OperationAudience;
  /** The key scope required; `null` only for `public` operations. */
  scope: KeyScope | null;
  effect: OperationEffect;
  run(input: z.output<S>, ctx: OperationContext): Promise<OperationOutcome>;
};

export function defineOperation<S extends OperationInput>(operation: Operation<S>): Operation<S> {
  if (operation.audience === "public" && operation.scope !== null) throw new Error(`${operation.name}: a public operation needs no scope`);
  if (operation.audience !== "public" && operation.scope === null) throw new Error(`${operation.name}: needs a key scope`);
  if (!/^[a-z][a-z0-9_]*$/.test(operation.name)) throw new Error(`${operation.name}: names are snake_case`);
  return operation;
}

export function ok(data: Record<string, unknown>): OperationOutcome {
  return { ok: true, data };
}

export function fail(code: string, details?: Record<string, unknown>): OperationOutcome {
  return details ? { ok: false, code, details } : { ok: false, code };
}
