// The catalog's own rules (decisions/0001-ledger-api.md): unique snake_case names, every write
// scoped, every destructive operation saying it cannot be undone, locking a period behind its own
// scope, and the reference data public.
import { describe, expect, it } from "vitest";

import { OPERATIONS } from "../src";

describe("the operation catalog", () => {
  it("has unique snake_case names", () => {
    const names = OPERATIONS.map((operation) => operation.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("says for every destructive operation that it cannot be undone", () => {
    for (const operation of OPERATIONS.filter((candidate) => candidate.effect === "destructive")) {
      expect(operation.description, operation.name).toMatch(/cannot be undone/i);
    }
  });

  it("needs a write or filing scope for every change, and only reads are public", () => {
    for (const operation of OPERATIONS) {
      if (operation.audience === "public") expect(operation.effect, operation.name).toBe("read");
      else if (operation.effect !== "read") expect(["write", "filing"], operation.name).toContain(operation.scope);
    }
  });

  it("puts locking a period behind the filing scope alone", () => {
    expect(OPERATIONS.filter((operation) => operation.scope === "filing").map((operation) => operation.name)).toEqual(["submit_filing"]);
  });

  it("creates filings only as drafts", () => {
    const createFiling = OPERATIONS.find((operation) => operation.name === "create_filing")!;
    expect(Object.keys(createFiling.input.shape)).not.toContain("status");
  });
});
