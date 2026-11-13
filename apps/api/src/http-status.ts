// The HTTP status of an error code. The body always carries the code itself; the status only
// helps generic HTTP tooling (retries, logs).
import { OPERATION_ERROR } from "@ledger/operations";

const STATUS: Record<string, number> = {
  [OPERATION_ERROR.invalidInput]: 400,
  [OPERATION_ERROR.tenantRequired]: 400,
  [OPERATION_ERROR.idempotencyKeyRequired]: 400,
  [OPERATION_ERROR.unauthenticated]: 401,
  [OPERATION_ERROR.forbidden]: 403,
  [OPERATION_ERROR.notFound]: 404,
  [OPERATION_ERROR.tenantNotFound]: 404,
  [OPERATION_ERROR.idempotencyConflict]: 409,
  [OPERATION_ERROR.unavailable]: 503,
  [OPERATION_ERROR.unknown]: 500,
};

/** Any other code is a domain refusal (unbalanced, locked, ...): 422. */
export function httpStatusOf(code: string): number {
  return STATUS[code] ?? 422;
}
