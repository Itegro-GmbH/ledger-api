import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import type { CallerStore } from "../src/caller";
import { defineOperation, ok } from "@ledger/operations";
import { z } from "zod";

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const tenantEcho = defineOperation({
  name: "tenant_echo",
  title: "Echo",
  description: "Test only.",
  input: z.object({ value: z.number() }),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return ok({ value: input.value, tenant: ctx.tenant?.id, platform: ctx.platform?.id, actor: ctx.actor });
  },
});

const callers: CallerStore = {
  async resolveKey(secret) {
    if (secret === "sk_test_good") return { platform: { id: "p1", name: "Platform" }, environment: "test", scopes: ["read", "write"] };
    if (secret === "sk_test_readonly") return { platform: { id: "p1", name: "Platform" }, environment: "test", scopes: ["read"] };
    return null;
  },
  async findTenant(platformId, environment, tenantId) {
    return platformId === "p1" && environment === "test" && tenantId === "t1" ? { id: "t1", name: "Tenant" } : null;
  },
};

describe("the HTTP surface", () => {
  it("serves public reference data without a key", async () => {
    const response = await post(createApp({ callers: null }), "/v1/list_tax_codes", {});
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; data: { taxCodes: { code: string }[] } };
    expect(body.ok).toBe(true);
    expect(body.data.taxCodes.map((code) => code.code)).toContain("rc13b");
  });

  it("answers an unknown operation and invalid input with stable codes", async () => {
    const app = createApp({ callers: null });
    expect(await (await post(app, "/v1/nope", {})).json()).toEqual({ ok: false, error: { code: "not_found", details: { operation: "nope" } } });
    const invalid = await post(app, "/v1/get_chart_template", { chart: "skr99" });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe("invalid_input");
  });

  it("resolves platform, tenant and actor, and refuses everything else", async () => {
    const app = createApp({ callers, operations: [tenantEcho] });
    const good = await post(app, "/v1/tenant_echo", { value: 1 }, { authorization: "Bearer sk_test_good", "ledger-tenant": "t1", "ledger-actor": "erika" });
    expect(await good.json()).toEqual({ ok: true, data: { value: 1, tenant: "t1", platform: "p1", actor: "erika" } });

    const codes = async (headers: Record<string, string>) => ((await (await post(app, "/v1/tenant_echo", { value: 1 }, headers)).json()) as { error: { code: string } }).error.code;
    expect(await codes({})).toBe("unauthenticated");
    expect(await codes({ authorization: "Bearer sk_test_wrong", "ledger-tenant": "t1" })).toBe("unauthenticated");
    expect(await codes({ authorization: "Bearer sk_test_readonly", "ledger-tenant": "t1" })).toBe("forbidden");
    expect(await codes({ authorization: "Bearer sk_test_good" })).toBe("tenant_required");
    expect(await codes({ authorization: "Bearer sk_test_good", "ledger-tenant": "t2" })).toBe("tenant_not_found");
  });

  it("answers unavailable for a keyed operation while no database is bound", async () => {
    const response = await post(createApp({ callers: null, operations: [tenantEcho] }), "/v1/tenant_echo", { value: 1 }, { authorization: "Bearer sk_test_good" });
    expect(response.status).toBe(503);
  });

  it("publishes an OpenAPI document built from the catalog", async () => {
    const doc = (await (await createApp({ callers: null }).request("/openapi.json")).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toEqual(["/v1/list_tax_codes", "/v1/get_chart_template"]);
  });
});
