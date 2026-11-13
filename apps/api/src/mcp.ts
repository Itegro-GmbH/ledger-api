// The MCP endpoint (decisions/0001-ledger-api.md): every operation of the catalog as a tool with
// the same name, description and input schema, served statelessly (a fresh server per request,
// so any serverless instance answers any request). The caller authenticates with the same
// platform key as over HTTP (`Authorization: Bearer sk_...`). A tenant operation takes the
// tenant from the `Ledger-Tenant` header or from its optional `tenantId` argument, a write an
// optional `idempotencyKey` argument (MCP clients cannot set a header per call).
import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import type { Operation, OperationOutcome } from "@ledger/operations";
import { z } from "zod";

import { executeOperation, MAX_IDEMPOTENCY_KEY_LENGTH, type ExecuteDeps } from "./execute";

const SERVER_INFO = { name: "ledger-api", title: "Ledger API", version: "1.0.0" } as const;

const INSTRUCTIONS = [
  "A German double-entry bookkeeping core. You act for one platform (your key) and, in tenant tools, for one tenant",
  "(a set of books). Amounts are integer cents, debit (Soll) positive and credit (Haben) negative. Dates are ISO",
  "(YYYY-MM-DD). Destructive tools cannot be undone: ask the user before calling them.",
].join(" ");

type RequestHeaders = { authorization: string | undefined; tenant: string | undefined; actor: string | undefined };

/** A tool's schema: the operation's own input plus the MCP-only routing arguments. */
export function mcpInputSchema(operation: Operation) {
  const extra = {
    ...(operation.audience === "tenant" ? { tenantId: z.string().max(100).optional().describe("Tenant to act in; defaults to the Ledger-Tenant header.") } : {}),
    ...(operation.effect !== "read" && operation.audience !== "public"
      ? { idempotencyKey: z.string().max(MAX_IDEMPOTENCY_KEY_LENGTH).optional().describe("Retrying with the same key never repeats the write.") }
      : {}),
  };
  return Object.keys(extra).length ? operation.input.safeExtend(extra) : operation.input;
}

function toCallToolResult(outcome: OperationOutcome): CallToolResult {
  if (outcome.ok) return { content: [{ type: "text", text: JSON.stringify(outcome.data) }], structuredContent: outcome.data };
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ code: outcome.code, ...(outcome.details ?? {}) }) }] };
}

export function buildMcpServer(operations: readonly Operation[], headers: RequestHeaders, deps: ExecuteDeps): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  for (const operation of operations) {
    server.registerTool(
      operation.name,
      {
        title: operation.title,
        description: operation.description,
        inputSchema: mcpInputSchema(operation),
        annotations: { title: operation.title, readOnlyHint: operation.effect === "read", destructiveHint: operation.effect === "destructive", openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        const { tenantId, idempotencyKey, ...input } = args as { tenantId?: string; idempotencyKey?: string };
        const outcome = await executeOperation(
          operation,
          { input, authorization: headers.authorization, tenant: tenantId ?? headers.tenant, actor: headers.actor, idempotencyKey, requireIdempotencyKey: false },
          deps,
        );
        return toCallToolResult(outcome);
      },
    );
  }
  return server;
}

export function createMcpEndpoint(operations: readonly Operation[], deps: ExecuteDeps) {
  return async (request: Request): Promise<Response> => {
    const headers: RequestHeaders = {
      authorization: request.headers.get("authorization") ?? undefined,
      tenant: request.headers.get("ledger-tenant") ?? undefined,
      actor: request.headers.get("ledger-actor") ?? undefined,
    };
    const handler = createMcpHandler(() => buildMcpServer(operations, headers, deps), {
      legacy: "stateless",
      responseMode: "json",
      onerror: (error) => console.error("[mcp] transport error", error.name, error.message),
    });
    return handler.fetch(request);
  };
}
