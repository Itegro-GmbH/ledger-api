import { describe, expect, it } from "vitest";

import { describePeriod, firstOpenDate, lockingFilingFor, type FilingView } from "../src";

function filing(overrides: Partial<FilingView>): FilingView {
  return {
    id: "f",
    kind: "vat_return",
    status: "submitted",
    periodFrom: "2026-07-01",
    periodTo: "2026-09-30",
    submittedOn: "2026-10-10",
    amountCents: null,
    correctsFilingId: null,
    note: null,
    createdAt: "2026-10-10T10:00:00.000Z",
    ...overrides,
  };
}

describe("describePeriod", () => {
  it("names months, quarters, years and plain ranges", () => {
    expect(describePeriod("2026-07-01", "2026-07-31")).toEqual({ kind: "month", year: 2026, month: 7 });
    expect(describePeriod("2026-07-01", "2026-09-30")).toEqual({ kind: "quarter", year: 2026, quarter: 3 });
    expect(describePeriod("2026-01-01", "2026-12-31")).toEqual({ kind: "year", year: 2026 });
    expect(describePeriod("2026-07-05", "2026-07-31").kind).toBe("range");
    expect(describePeriod("2026-02-01", "2026-04-30").kind).toBe("range");
  });
});

describe("locks", () => {
  it("only a submitted filing locks, an annual statement its whole year", () => {
    expect(lockingFilingFor([filing({})], "2026-08-15")?.id).toBe("f");
    expect(lockingFilingFor([filing({ status: "draft" })], "2026-08-15")).toBeNull();
    expect(lockingFilingFor([filing({ kind: "annual_statement", periodFrom: "2026-01-01", periodTo: "2026-12-31" })], "2026-12-31")).not.toBeNull();
    expect(lockingFilingFor([filing({})], "2026-10-01")).toBeNull();
  });

  it("finds the first open day after back-to-back filings", () => {
    const filings = [filing({ id: "q2", periodFrom: "2026-04-01", periodTo: "2026-06-30" }), filing({ id: "q3" })];
    expect(firstOpenDate(filings, "2026-05-10")).toBe("2026-10-01");
    expect(firstOpenDate(filings, "2026-11-02")).toBe("2026-11-02");
  });
});
