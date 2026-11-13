// The action input schemas: shape checks the database never has to see fail.
import { describe, expect, it } from "vitest";

import {
  createAccountInputSchema,
  createEntryInputSchema,
  createFilingInputSchema,
  createMatchInputSchema,
  listEntriesFilterSchema,
  periodSchema,
  proposalInputSchema,
  ruleInputSchema,
  RULE_TAX_CODES_BY_DIRECTION,
  updateEntryInputSchema,
} from "../src";

const entry = {
  bookingDate: "2026-07-01",
  text: "IONOS Rechnung",
  lines: [
    { accountNumber: "6810", amountCents: 150, taxCode: "vst19" },
    { accountNumber: "1800", amountCents: -150 },
  ],
};

describe("entry schemas", () => {
  it("accepts a manual entry and defaults `book` to false", () => {
    const parsed = createEntryInputSchema.parse({ entry });
    expect(parsed.book).toBe(false);
    expect(parsed.entry.lines[0]!.taxCode).toBe("vst19");
  });

  it("refuses zero lines, a zero amount, fractional cents, a bad account number, an empty text", () => {
    expect(createEntryInputSchema.safeParse({ entry: { ...entry, lines: [] } }).success).toBe(false);
    expect(createEntryInputSchema.safeParse({ entry: { ...entry, lines: [{ accountNumber: "6810", amountCents: 0 }] } }).success).toBe(false);
    expect(createEntryInputSchema.safeParse({ entry: { ...entry, lines: [{ accountNumber: "6810", amountCents: 1.5 }] } }).success).toBe(false);
    expect(createEntryInputSchema.safeParse({ entry: { ...entry, lines: [{ accountNumber: "68", amountCents: 1 }] } }).success).toBe(false);
    expect(createEntryInputSchema.safeParse({ entry: { ...entry, text: "  " } }).success).toBe(false);
    expect(createEntryInputSchema.safeParse({ entry: { ...entry, bookingDate: "01.07.2026" } }).success).toBe(false);
    expect(createEntryInputSchema.safeParse({ entry: { ...entry, lines: [{ accountNumber: "6810", amountCents: 1, taxCode: "vst16" }] } }).success).toBe(false);
  });

  it("takes an optional reason and expected revision on update", () => {
    const id = "6f1d1b8e-3b0a-4c8e-9a51-0d6a3c6b2e11";
    expect(updateEntryInputSchema.parse({ entryId: id, entry, reason: "Konto falsch", expectedRevision: 2 }).reason).toBe("Konto falsch");
    expect(updateEntryInputSchema.safeParse({ entryId: "x", entry }).success).toBe(false);
  });

  it("keeps `manual` out of the proposal engine's origins", () => {
    expect(proposalInputSchema.safeParse({ sourceKey: "doc:1", entry, origin: "manual" }).success).toBe(false);
    expect(proposalInputSchema.parse({ sourceKey: "doc:1", entry, origin: "template" }).warnings).toEqual([]);
  });
});

describe("account schema", () => {
  it("needs the owner field matching the owner type", () => {
    const base = { number: "3511", name: "Auslagen Erika", kind: "liability", group: "open_items", openItems: true };
    expect(createAccountInputSchema.safeParse({ ...base, ownerType: "person", ownerPersonName: "Erika" }).success).toBe(true);
    expect(createAccountInputSchema.safeParse({ ...base, ownerType: "person" }).success).toBe(false);
    expect(createAccountInputSchema.safeParse({ ...base, ownerType: null }).success).toBe(true);
  });
});

describe("period, filing, match and rule schemas", () => {
  it("refuses a period whose end is before its start", () => {
    expect(periodSchema.safeParse({ from: "2026-07-31", to: "2026-07-01" }).success).toBe(false);
    expect(periodSchema.safeParse({ from: "2026-07-01", to: "2026-07-31" }).success).toBe(true);
  });

  it("needs the submission date for a submitted filing", () => {
    const filing = { kind: "vat_return", periodFrom: "2026-07-01", periodTo: "2026-09-30" };
    expect(createFilingInputSchema.safeParse({ ...filing, status: "submitted" }).success).toBe(false);
    expect(createFilingInputSchema.safeParse({ ...filing, status: "submitted", submittedOn: "2026-10-10" }).success).toBe(true);
    expect(createFilingInputSchema.safeParse({ ...filing, status: "draft" }).success).toBe(true);
  });

  it("needs a note to explain a remainder", () => {
    const line = "6f1d1b8e-3b0a-4c8e-9a51-0d6a3c6b2e11";
    expect(createMatchInputSchema.safeParse({ accountNumber: "1461", kind: "explained", lineIds: [line] }).success).toBe(false);
    expect(createMatchInputSchema.safeParse({ accountNumber: "1461", kind: "explained", lineIds: [line], note: "Guthaben 0,04" }).success).toBe(true);
    expect(createMatchInputSchema.safeParse({ accountNumber: "1461", kind: "match", lineIds: [line] }).success).toBe(true);
  });

  it("needs a contact or a counterparty pattern for a rule", () => {
    const rule = { contactId: null, direction: "incoming", accountNumber: "2900", taxCode: "not_taxable", paymentAccountNumber: null, noDocument: true };
    expect(ruleInputSchema.safeParse(rule).success).toBe(false);
    expect(ruleInputSchema.parse({ ...rule, counterpartyPattern: "Stammkapital" }).active).toBe(true);
  });

  it("restricts a rule's tax code to its direction", () => {
    const base = { contactId: null, counterpartyPattern: "x", accountNumber: "6300", paymentAccountNumber: null, noDocument: false };
    const ok = (direction: string, taxCode: string | null) => ruleInputSchema.safeParse({ ...base, direction, taxCode }).success;
    for (const code of ["vst19", "vst7", "rc13b", "pass_through", "not_taxable", "tax_free", null]) expect(ok("incoming", code)).toBe(true);
    for (const code of ["ust19", "ust7", "eu_not_taxable"]) expect(ok("incoming", code)).toBe(false);
    for (const code of ["ust19", "ust7", "eu_not_taxable", "not_taxable", "tax_free", null]) expect(ok("outgoing", code)).toBe(true);
    for (const code of ["vst19", "vst7", "rc13b", "pass_through"]) expect(ok("outgoing", code)).toBe(false);
    for (const code of ["not_taxable", "tax_free", null]) expect(ok("any", code)).toBe(true);
    for (const code of ["vst19", "ust19", "rc13b", "eu_not_taxable", "pass_through"]) expect(ok("any", code)).toBe(false);
    expect(RULE_TAX_CODES_BY_DIRECTION.incoming).toContain("vst19");
  });

  it("defaults the entry list filter", () => {
    expect(listEntriesFilterSchema.parse({})).toEqual({ dismissed: "exclude", limit: 500 });
  });
});
