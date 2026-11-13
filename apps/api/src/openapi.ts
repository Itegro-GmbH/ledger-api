// The OpenAPI document, built from the operation catalog (decisions/0001-ledger-api.md): one
// `POST /v1/<name>` path per operation, its request body the operation's own Zod schema. It can
// never drift from what the service accepts.
import { type Operation } from "@ledger/operations";
import { z } from "zod";

const errorSchema = {
  type: "object",
  required: ["ok", "error"],
  properties: {
    ok: { const: false },
    error: { type: "object", required: ["code"], properties: { code: { type: "string" }, details: { type: "object" } } },
  },
};

export function buildOpenApiDocument(operations: readonly Operation[], serverUrl: string | null) {
  const paths: Record<string, unknown> = {};
  for (const operation of operations) {
    const headers = [
      ...(operation.audience === "tenant" ? [{ name: "Ledger-Tenant", in: "header", required: true, schema: { type: "string" }, description: "The tenant to act in." }] : []),
      ...(operation.effect !== "read" ? [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", maxLength: 200 } }] : []),
      ...(operation.audience !== "public" ? [{ name: "Ledger-Actor", in: "header", required: false, schema: { type: "string", maxLength: 200 }, description: "Who acted on the platform's side; recorded in revisions." }] : []),
    ];
    paths[`/v1/${operation.name}`] = {
      post: {
        operationId: operation.name,
        summary: operation.title,
        description: operation.description,
        tags: [operation.effect],
        security: operation.audience === "public" ? [] : [{ platformKey: [] }],
        parameters: headers,
        "x-ledger-scope": operation.scope,
        "x-ledger-effect": operation.effect,
        requestBody: { required: true, content: { "application/json": { schema: z.toJSONSchema(operation.input, { io: "input", unrepresentable: "any" }) } } },
        responses: {
          "200": {
            description: "Success",
            content: { "application/json": { schema: { type: "object", required: ["ok", "data"], properties: { ok: { const: true }, data: { type: "object" } } } } },
          },
          default: { description: "Error with a stable code", content: { "application/json": { schema: errorSchema } } },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "ledger-api",
      version: "1",
      description: "A multi-tenant German bookkeeping core. Every operation is `POST /v1/<name>` with a JSON body.",
    },
    servers: serverUrl ? [{ url: serverUrl }] : [],
    components: { securitySchemes: { platformKey: { type: "http", scheme: "bearer", description: "A platform key, sk_test_... or sk_live_..." } } },
    paths,
  };
}
