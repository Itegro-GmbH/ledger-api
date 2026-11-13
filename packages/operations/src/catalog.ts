// Every operation the service offers, in one list (decisions/0001-ledger-api.md). The HTTP
// routes, the OpenAPI document and the MCP tools are all built from it.
import type { Operation } from "./kit";
import { LEDGER_OPERATIONS } from "./ledger-operations";
import { getChartTemplate, listTaxCodes } from "./reference-operations";
import { SOURCE_OPERATIONS } from "./source-operations";
import { TENANT_OPERATIONS } from "./tenant-operations";

export const OPERATIONS: readonly Operation[] = [listTaxCodes, getChartTemplate, ...TENANT_OPERATIONS, ...LEDGER_OPERATIONS, ...SOURCE_OPERATIONS];

const names = new Set<string>();
for (const operation of OPERATIONS) {
  if (names.has(operation.name)) throw new Error(`duplicate operation name: ${operation.name}`);
  names.add(operation.name);
}

export function findOperation(name: string): Operation | undefined {
  return OPERATIONS.find((operation) => operation.name === name);
}
