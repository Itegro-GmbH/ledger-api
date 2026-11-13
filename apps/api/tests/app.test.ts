import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import type { CallerStore } from "../src/caller";
import type { IdempotencyStore } from "../src/execute";
import { defineOperation, ok, OPERATIONS } from "@ledger/operations";
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
    const good = await post(app, "/v1/tenant_echo", { value: 1 }, { authorization: "Bearer sk_test_good", "ledger-tenant": "t1", "ledger-actor": "erika", "idempotency-key": "k1" });
    const goodBody = await good.json();
    expect(goodBody, JSON.stringify(goodBody)).toEqual({ ok: true, data: { value: 1, tenant: "t1", platform: "p1", actor: "erika" } });

    const codes = async (headers: Record<string, string>) => ((await (await post(app, "/v1/tenant_echo", { value: 1 }, headers)).json()) as { error: { code: string } }).error.code;
    expect(await codes({})).toBe("unauthenticated");
    expect(await codes({ authorization: "Bearer sk_test_wrong", "ledger-tenant": "t1" })).toBe("unauthenticated");
    expect(await codes({ authorization: "Bearer sk_test_readonly", "ledger-tenant": "t1" })).toBe("forbidden");
    expect(await codes({ authorization: "Bearer sk_test_good" })).toBe("tenant_required");
    expect(await codes({ authorization: "Bearer sk_test_good", "ledger-tenant": "t2" })).toBe("tenant_not_found");
    expect(await codes({ authorization: "Bearer sk_test_good", "ledger-tenant": "t1" })).toBe("idempotency_key_required");
  });

  it("answers unavailable for a keyed operation while no database is bound", async () => {
    const response = await post(createApp({ callers: null, operations: [tenantEcho] }), "/v1/tenant_echo", { value: 1 }, { authorization: "Bearer sk_test_good" });
    expect(response.status).toBe(503);
  });

  it("publishes an OpenAPI document built from the catalog", async () => {
    const doc = (await (await createApp({ callers: null }).request("/openapi.json")).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toContain("/v1/list_tax_codes");
    expect(Object.keys(doc.paths)).toContain("/v1/submit_filing");
    expect(Object.keys(doc.paths)).toHaveLength(OPERATIONS.length);
  });
});

function memoryIdempotency(): IdempotencyStore & { size: () => number } {
  const rows = new Map<string, Parameters<IdempotencyStore["put"]>[3]>();
  return {
    async get(platformId, environment, key) {
      return rows.get(`${platformId}:${environment}:${key}`) ?? null;
    },
    async put(platformId, environment, key, record) {
      if (!rows.has(`${platformId}:${environment}:${key}`)) rows.set(`${platformId}:${environment}:${key}`, record);
    },
    size: () => rows.size,
  };
}

describe("idempotency", () => {
  let runs = 0;
  const counting = defineOperation({
    name: "counting_write",
    title: "Count",
    description: "Test only.",
    input: z.object({ value: z.number() }),
    audience: "tenant",
    scope: "write",
    effect: "write",
    async run(input) {
      runs += 1;
      return ok({ value: input.value, run: runs });
    },
  });
  const headers = (key: string, tenant = "t1") => ({ authorization: "Bearer sk_test_good", "ledger-tenant": tenant, "idempotency-key": key });

  it("replays the stored answer for the same key and body, without running again", async () => {
    runs = 0;
    const app = createApp({ callers, operations: [counting], idempotency: memoryIdempotency() });
    const first = await (await post(app, "/v1/counting_write", { value: 5 }, headers("same"))).json();
    const second = await (await post(app, "/v1/counting_write", { value: 5 }, headers("same"))).json();
    expect(first).toEqual({ ok: true, data: { value: 5, run: 1 } });
    expect(second).toEqual(first);
    expect(runs).toBe(1);
  });

  it("refuses the same key with another body", async () => {
    const app = createApp({ callers, operations: [counting], idempotency: memoryIdempotency() });
    await post(app, "/v1/counting_write", { value: 5 }, headers("k"));
    const response = await post(app, "/v1/counting_write", { value: 6 }, headers("k"));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("idempotency_conflict");
  });
});

describe("the MCP surface", () => {
  const rpc = (app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) =>
    app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...headers },
      body: JSON.stringify(body),
    });
  /** The SDK answers legacy (2025-era) requests as one server-sent event. */
  const payload = async (response: Response) => {
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(data ? data.slice(6) : text);
  };

  it("lists every operation as a tool with routing arguments", async () => {
    const app = createApp({ callers, operations: [tenantEcho] });
    const response = await rpc(app, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(response.status).toBe(200);
    const body = (await payload(response)) as { result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] } };
    expect(body.result.tools.map((tool) => tool.name)).toEqual(["tenant_echo"]);
    expect(Object.keys(body.result.tools[0]!.inputSchema.properties)).toEqual(["value", "tenantId", "idempotencyKey"]);
  });

  it("runs a tool with the platform key and the tenantId argument", async () => {
    const app = createApp({ callers, operations: [tenantEcho] });
    const response = await rpc(
      app,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tenant_echo", arguments: { value: 3, tenantId: "t1" } } },
      { authorization: "Bearer sk_test_good" },
    );
    const body = (await payload(response)) as { result: { structuredContent: unknown; isError?: boolean } };
    expect(body.result.isError).toBeFalsy();
    expect(body.result.structuredContent).toEqual({ value: 3, tenant: "t1", platform: "p1", actor: null });
  });

  it("answers a tool call without a key as a tool error", async () => {
    const app = createApp({ callers, operations: [tenantEcho] });
    const response = await rpc(app, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tenant_echo", arguments: { value: 3, tenantId: "t1" } } });
    const body = (await payload(response)) as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0]!.text)).toEqual({ code: "unauthenticated" });
  });
});
