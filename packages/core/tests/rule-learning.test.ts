// "Als Regel speichern" (decisions/0080 phase 3): the rule a booked entry implies.
import { describe, expect, it } from "vitest";

import { counterpartyPatternOf, deriveRuleFromEntry, type RuleLearningLine } from "../src";

const l = (accountNumber: string, amountCents: number, overrides: Partial<RuleLearningLine> = {}): RuleLearningLine => ({
  accountNumber,
  amountCents,
  kind: "expense",
  group: "costs",
  openItems: false,
  ownerType: null,
  taxCode: null,
  taxRole: null,
  ...overrides,
});

describe("deriveRuleFromEntry", () => {
  it("an invoice: the contact's expense account and tax code, and its own open-item account", () => {
    const rule = deriveRuleFromEntry({
      entryId: "e1",
      source: "document",
      contactId: "meta",
      counterpartyName: null,
      lines: [
        l("6600", 1300, { taxCode: "rc13b", taxRole: "base" }),
        l("1407", 247, { kind: "asset", group: "taxes", taxCode: "rc13b", taxRole: "tax" }),
        l("3837", -247, { kind: "liability", group: "taxes", taxCode: "rc13b", taxRole: "tax" }),
        l("1461", -1300, { kind: "asset", group: "open_items", openItems: true, ownerType: "contact" }),
      ],
    });
    expect(rule).toEqual({ contactId: "meta", counterpartyPattern: null, direction: "incoming", accountNumber: "6600", taxCode: "rc13b", paymentAccountNumber: "1461", noDocument: false, active: true, learnedFromEntryId: "e1" });
  });

  it("an invoice against the shared payables keeps no payment account; without a contact there is no rule", () => {
    const lines = [l("6810", 126, { taxCode: "vst19", taxRole: "base" }), l("1406", 24, { kind: "asset", group: "taxes", taxCode: "vst19", taxRole: "tax" }), l("3300", -150, { kind: "liability", group: "open_items", openItems: true })];
    expect(deriveRuleFromEntry({ entryId: "e", source: "document", contactId: "ionos", counterpartyName: null, lines })?.paymentAccountNumber).toBeNull();
    expect(deriveRuleFromEntry({ entryId: "e", source: "document", contactId: null, counterpartyName: null, lines })).toBeNull();
  });

  it("share capital: a no-document rule by counterparty name, money in", () => {
    const rule = deriveRuleFromEntry({
      entryId: "e2",
      source: "transaction",
      contactId: null,
      counterpartyName: "Erika  Mustermann",
      lines: [l("1800", 416_700, { kind: "asset", group: "bank", ownerType: "bank_account" }), l("2900", -416_700, { kind: "equity", group: "equity" })],
    });
    expect(rule).toMatchObject({ contactId: null, counterpartyPattern: "erika mustermann", direction: "outgoing", accountNumber: "2900", noDocument: true });
  });

  it("no rule for a transaction split over several accounts or without a counterparty", () => {
    const bank = l("1800", -500, { kind: "asset", group: "bank", ownerType: "bank_account" });
    expect(deriveRuleFromEntry({ entryId: "e", source: "transaction", contactId: null, counterpartyName: "Musterbank", lines: [bank, l("6855", 300), l("6300", 200)] })).toBeNull();
    expect(deriveRuleFromEntry({ entryId: "e", source: "transaction", contactId: null, counterpartyName: null, lines: [bank, l("6855", 500)] })).toBeNull();
    expect(counterpartyPatternOf("ab")).toBeNull();
  });
});
