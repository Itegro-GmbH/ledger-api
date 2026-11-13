// "Als Regel speichern" (decisions/0080 phase 3): the booking rule a booked or edited entry
// implies, so the same contact or counterparty is proposed the same way next time without the
// AI. Pure; `learnRuleFromEntry` resolves the contact and writes the rule.
import { moneyDirection } from "./proposals";
import type { RuleInput } from "./schemas";
import type { LedgerAccountGroup, LedgerAccountKind, LedgerOwnerType, TaxCode, TaxRole } from "./types";

export type RuleLearningLine = {
  accountNumber: string;
  kind: LedgerAccountKind;
  group: LedgerAccountGroup;
  openItems: boolean;
  ownerType: LedgerOwnerType | null;
  amountCents: number;
  taxCode: TaxCode | null;
  taxRole: TaxRole | null;
};

export type RuleLearningInput = {
  entryId: string;
  lines: readonly RuleLearningLine[];
  /** `document`: the entry books a document (an invoice), `transaction`: a bank transaction
   * without one (share capital, bank fees). */
  source: "document" | "transaction";
  /** The document's contact, or the contact a transaction's counterparty resolves to. */
  contactId: string | null;
  counterpartyName: string | null;
};

export const MAX_RULE_PATTERN_LENGTH = 200;

/** A counterparty name as a rule pattern: lowercase, single spaces, at most 200 characters. */
export function counterpartyPatternOf(name: string | null): string | null {
  const pattern = (name ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, MAX_RULE_PATTERN_LENGTH);
  return pattern.length >= 3 ? pattern : null;
}

function isBank(line: RuleLearningLine): boolean {
  return line.group === "bank" || line.ownerType === "bank_account";
}

const largest = (lines: readonly RuleLearningLine[]) => lines.reduce((best, line) => (Math.abs(line.amountCents) > Math.abs(best.amountCents) ? line : best));

/** The rule the entry implies, or `null` when it names no contact or counterparty, or has no
 * single account the rule could propose. */
export function deriveRuleFromEntry(input: RuleLearningInput): RuleInput | null {
  const base = input.lines.filter((line) => line.taxRole !== "tax");
  if (input.source === "document") {
    if (!input.contactId) return null;
    const targets = base.filter((line) => line.kind === "expense" || line.kind === "revenue");
    if (targets.length === 0) return null;
    const main = largest(targets);
    const openItem = base.find((line) => line.openItems && (line.ownerType === "contact" || line.ownerType === "person"));
    return {
      contactId: input.contactId,
      counterpartyPattern: null,
      direction: main.kind === "expense" ? "incoming" : "outgoing",
      accountNumber: main.accountNumber,
      taxCode: main.taxCode === "pass_through" ? null : main.taxCode,
      paymentAccountNumber: openItem?.accountNumber ?? null,
      noDocument: false,
      active: true,
      learnedFromEntryId: input.entryId,
    };
  }

  const bank = base.filter(isBank);
  const others = base.filter((line) => !isBank(line));
  if (bank.length !== 1 || others.length === 0) return null;
  const accounts = new Set(others.map((line) => line.accountNumber));
  if (accounts.size !== 1) return null;
  const pattern = input.contactId ? null : counterpartyPatternOf(input.counterpartyName);
  if (!input.contactId && !pattern) return null;
  const main = largest(others);
  return {
    contactId: input.contactId,
    counterpartyPattern: pattern,
    // Money in is the revenue side (`outgoing`), money out the expense side (`incoming`), the
    // same reading `ruleForTransaction` applies.
    direction: moneyDirection(bank[0]!.amountCents),
    accountNumber: main.accountNumber,
    taxCode: main.taxCode,
    paymentAccountNumber: null,
    noDocument: true,
    active: true,
    learnedFromEntryId: input.entryId,
  };
}
