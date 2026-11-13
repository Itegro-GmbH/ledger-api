// Resolving who calls (decisions/0001-ledger-api.md, "Request conventions"): the platform from
// its key, the tenant from `Ledger-Tenant` (checked to belong to that platform, in this one
// place), the actor from `Ledger-Actor`. The key store is a port, bound to the database by the
// composition root; without one, every non-public operation answers `unavailable`.
import type { KeyScope, OperationContext } from "@ledger/operations";

export type ResolvedKey = { platform: { id: string; name: string }; environment: "test" | "live"; scopes: readonly KeyScope[] };

export type CallerStore = {
  /** The key's platform, environment and scopes, or `null` for an unknown or revoked key. */
  resolveKey(secret: string): Promise<ResolvedKey | null>;
  /** The tenant, only if it belongs to that platform and environment. */
  findTenant(platformId: string, environment: "test" | "live", tenantId: string): Promise<{ id: string; name: string } | null>;
};

export type CallerHeaders = { authorization: string | undefined; tenant: string | undefined; actor: string | undefined };

export function bearerSecret(authorization: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  return match?.[1] ?? null;
}

export function anonymousContext(actor: string | undefined): OperationContext {
  return { platform: null, tenant: null, actor: actor?.trim().slice(0, 200) || null, environment: null };
}
