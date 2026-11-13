// Unit tests for src/foundation/db-errors.ts: no DB, no network. Fixtures are plain objects shaped
// like `pg`'s `DatabaseError` (code/message/constraint): `dbErrorOf()` duck-types on those fields
// rather than requiring the real `pg` class, so a real driver error and these fixtures behave
// identically here.
import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";

import { dbErrorOf, isDbError } from "../src";

/** A minimal stand-in for `pg`'s `DatabaseError`. */
function pgError(code: string, message: string, constraint: string | null = null): Error & { code: string; constraint: string | null } {
  const err = new Error(message) as Error & { code: string; constraint: string | null };
  err.code = code;
  err.constraint = constraint;
  return err;
}

describe("dbErrorOf", () => {
  it.each([
    ["23505", "unique"],
    ["23503", "foreign_key"],
    ["23514", "check"],
    ["22001", "invalid_input"],
    ["23502", "invalid_input"],
    ["22P02", "invalid_input"],
    ["42501", "forbidden"],
    ["40001", "serialization"],
    ["40P01", "serialization"],
    ["P0001", "raised"],
  ] as const)("maps SQLSTATE %s to kind %s", (code, kind) => {
    const err = pgError(code, "some message");
    expect(dbErrorOf(err)).toEqual({ kind, code, constraint: null, message: "some message" });
  });

  it("maps an unrecognized SQLSTATE to unknown, keeping the code", () => {
    const err = pgError("55P03", "lock_not_available");
    expect(dbErrorOf(err)).toEqual({ kind: "unknown", code: "55P03", constraint: null, message: "lock_not_available" });
  });

  it("preserves the violated constraint name", () => {
    // A real constraint name from this package's schema.
    const err = pgError("23505", 'duplicate key value violates unique constraint "ledger_accounts_tenant_number_key"', "ledger_accounts_tenant_number_key");
    const result = dbErrorOf(err);
    expect(result.kind).toBe("unique");
    expect(result.constraint).toBe("ledger_accounts_tenant_number_key");
  });

  it.each([["NOT_FOUND"], ["INVALID_CONFIG:some_field"], ["SOME_CUSTOM_CODE"]] as const)(
    "classifies a P0001 raise message %s as raised, preserving the exact text",
    (message) => {
      const err = pgError("P0001", message);
      const result = dbErrorOf(err);
      expect(result.kind).toBe("raised");
      expect(result.message).toBe(message);
    },
  );

  it("does not treat a driver-level code (not 5 SQLSTATE chars) as a SQLSTATE", () => {
    const err = pgError("ECONNRESET", "socket hang up");
    const result = dbErrorOf(err);
    expect(result.kind).toBe("unknown");
    expect(result.code).toBeNull();
  });

  it("unwraps a DrizzleQueryError's cause to read the underlying Postgres error", () => {
    const inner = pgError("23505", 'duplicate key value violates unique constraint "user_email_key"', "user_email_key");
    const wrapped = new DrizzleQueryError("insert into ...", [], inner);
    const result = dbErrorOf(wrapped);
    expect(result).toEqual({ kind: "unique", code: "23505", constraint: "user_email_key", message: inner.message });
  });

  it("unwraps a DrizzleQueryError wrapping a P0001 raise, preserving the message", () => {
    const inner = pgError("P0001", "SOME_CUSTOM_CODE");
    const wrapped = new DrizzleQueryError("select some_function($1)", ["id"], inner);
    expect(dbErrorOf(wrapped)).toMatchObject({ kind: "raised", message: "SOME_CUSTOM_CODE" });
  });

  it("maps a plain Error with no cause and no code to unknown", () => {
    const result = dbErrorOf(new Error("boom"));
    expect(result).toEqual({ kind: "unknown", code: null, constraint: null, message: "boom" });
  });

  it("maps a thrown string to unknown, using it as the message", () => {
    expect(dbErrorOf("boom")).toEqual({ kind: "unknown", code: null, constraint: null, message: "boom" });
  });

  it("maps a thrown non-Error, non-string value to a generic message", () => {
    expect(dbErrorOf({ weird: true })).toEqual({ kind: "unknown", code: null, constraint: null, message: "Database error" });
  });
});

describe("isDbError", () => {
  it("is true when the kind matches", () => {
    expect(isDbError(pgError("23505", "dup"), "unique")).toBe(true);
  });

  it("is false when the kind does not match", () => {
    expect(isDbError(pgError("23505", "dup"), "check")).toBe(false);
  });
});
