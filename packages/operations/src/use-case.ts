// Helpers shared by the operations that run the ledger's use cases (`@ledger/db`).
import { UseCaseError } from "@ledger/db";

import { fail, OPERATION_ERROR, ok, type OperationContext, type OperationOutcome, type OperationServices } from "./kit";

type Bound = { services: OperationServices; tenantId: string; actor: string };

/**
 * Runs `work` with the bound services and the resolved tenant. A `UseCaseError` becomes its own
 * stable code (`unbalanced`, `locked`, `not_found`, ...), a failed `strict` parse
 * `invalid_input`; anything else is rethrown and answered `unknown` by the executor.
 */
export async function withTenant(ctx: OperationContext, work: (bound: Bound) => Promise<Record<string, unknown> | OperationOutcome>): Promise<OperationOutcome> {
  const services = ctx.services;
  const tenant = ctx.tenant;
  if (!services) return fail(OPERATION_ERROR.unavailable);
  if (!tenant) return fail(OPERATION_ERROR.tenantRequired);
  return capture(() => work({ services, tenantId: tenant.id, actor: actorOf(ctx) }));
}

/** For platform operations (no tenant): the services, the platform and the actor. */
export async function withPlatform(
  ctx: OperationContext,
  work: (bound: { services: OperationServices; platformId: string; environment: "test" | "live"; actor: string }) => Promise<Record<string, unknown> | OperationOutcome>,
): Promise<OperationOutcome> {
  const { services, platform, environment } = ctx;
  if (!services || !platform || !environment) return fail(OPERATION_ERROR.unavailable);
  return capture(() => work({ services, platformId: platform.id, environment, actor: actorOf(ctx) }));
}

/** Who is recorded in revisions: the `Ledger-Actor` header, else the platform itself. */
export function actorOf(ctx: OperationContext): string {
  return ctx.actor ?? `platform:${ctx.platform?.id ?? "unknown"}`;
}

class InvalidInput extends Error {
  constructor(readonly issues: unknown) {
    super("invalid_input");
  }
}

/** Parses with the full schema, refinements included, that an operation's flat input schema
 * (what JSON Schema and MCP can express) leaves out. Use inside `withTenant`/`withPlatform`. */
export function strict<T>(schema: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: unknown } } }, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new InvalidInput(parsed.error.issues);
  return parsed.data;
}

async function capture(work: () => Promise<Record<string, unknown> | OperationOutcome>): Promise<OperationOutcome> {
  try {
    const result = await work();
    return isOutcome(result) ? result : ok(result);
  } catch (error) {
    if (error instanceof UseCaseError) return fail(error.code);
    if (error instanceof InvalidInput) return fail(OPERATION_ERROR.invalidInput, { issues: error.issues });
    throw error;
  }
}

function isOutcome(value: Record<string, unknown> | OperationOutcome): value is OperationOutcome {
  return (value.ok === true && "data" in value) || (value.ok === false && "code" in value);
}
