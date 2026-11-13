// The deterministic one-sentence summary of an entry ("So wird gebucht"), spec section 3:
// rendered from the lines and their accounts through fixed `Ledger.summaries.*` templates,
// never AI text. Returns an i18n key and its ICU values; `amount` is in euros so the template
// can format it with `{amount, number, ::currency/EUR}`.
import type { EntrySummaryKind, LedgerAccountGroup, LedgerAccountKind, LedgerOwnerType, MessageRef, TaxCode, TaxRole } from "./types";

export type SummaryLine = {
  accountNumber: string;
  accountName: string;
  kind: LedgerAccountKind;
  group: LedgerAccountGroup;
  openItems: boolean;
  ownerType: LedgerOwnerType | null;
  ownerPersonName: string | null;
  amountCents: number;
  taxCode: TaxCode | null;
  taxRole: TaxRole | null;
};

function ref(kind: EntrySummaryKind, params: Record<string, string | number>): MessageRef {
  return { key: `summaries.${kind}`, params };
}

const euros = (cents: number) => Math.abs(cents) / 100;

function isPaymentAccount(line: SummaryLine): boolean {
  return line.group === "bank" || line.ownerType === "bank_account";
}

/** Lines of the same account count once (an invoice's 19 % part and its pass-through part on
 * the same expense account is still one expense). */
function distinctAccounts(lines: readonly SummaryLine[]): SummaryLine[] {
  const seen = new Map<string, SummaryLine>();
  for (const line of lines) {
    const existing = seen.get(line.accountNumber);
    seen.set(line.accountNumber, existing ? { ...existing, amountCents: existing.amountCents + line.amountCents } : line);
  }
  return [...seen.values()];
}

/** Money moving between a bank account and one that is not income or expense: a transfer when
 * both sides hold money (another bank account, money in transit), else a payment. */
function isMoneyAccount(line: SummaryLine): boolean {
  return isPaymentAccount(line) || (line.ownerType === null && line.group === "other" && line.kind === "asset");
}

/** Picks the template that describes the entry best; `manual` when none fits. */
export function summarizeEntry(lines: readonly SummaryLine[]): MessageRef {
  const total = lines.reduce((sum, line) => (line.amountCents > 0 ? sum + line.amountCents : sum), 0);
  const base = lines.filter((line) => line.taxRole !== "tax");
  const manual = ref("manual", { amount: euros(total), count: lines.length });
  if (base.length < 2) return manual;

  const debits = distinctAccounts(base.filter((line) => line.amountCents > 0));
  const credits = distinctAccounts(base.filter((line) => line.amountCents < 0));
  const expenses = debits.filter((line) => line.kind === "expense");
  const revenues = credits.filter((line) => line.kind === "revenue");

  // A platform's report: sales (and its fees) against what the platform owes.
  const platform = debits.find((line) => line.ownerType === "platform");
  if (platform && revenues.length >= 1) {
    const sales = revenues.reduce((sum, line) => sum - line.amountCents, 0);
    const fees = expenses.reduce((sum, line) => sum + line.amountCents, 0);
    return ref("platformReport", { amount: sales / 100, fees: fees / 100, counter: platform.accountName });
  }

  if (expenses.length > 1 || revenues.length > 1) {
    const parts = expenses.length > 1 ? expenses : revenues;
    return ref("split", { amount: euros(total), count: parts.length });
  }

  if (expenses.length === 1 && credits.length === 1) {
    const expense = expenses[0]!;
    const counter = credits[0]!;
    const amount = euros(counter.amountCents);
    if (expense.taxCode === "rc13b") return ref("reverseCharge", { amount, account: expense.accountName, counter: counter.accountName });
    if (isPaymentAccount(counter)) return ref("expensePaidByBank", { amount, account: expense.accountName, counter: counter.accountName });
    if (counter.ownerType === "person") {
      return ref("expensePaidByShareholder", { amount, account: expense.accountName, person: counter.ownerPersonName ?? counter.accountName });
    }
    if (counter.openItems && counter.kind === "asset") return ref("expenseFromPrepaid", { amount, account: expense.accountName, counter: counter.accountName });
    if (counter.openItems) return ref("expenseAgainstOpenItem", { amount, account: expense.accountName, counter: counter.accountName });
    return manual;
  }

  if (revenues.length === 1 && debits.length === 1) {
    return ref("revenue", { amount: euros(debits[0]!.amountCents), account: revenues[0]!.accountName, counter: debits[0]!.accountName });
  }

  if (expenses.length === 0 && revenues.length === 0) {
    const banks = base.filter(isPaymentAccount);
    if (banks.length === 1) {
      const bank = banks[0]!;
      const others = distinctAccounts(base.filter((line) => line !== bank));
      const opposite = others.every((line) => Math.sign(line.amountCents) === -Math.sign(bank.amountCents));
      if (others.length >= 1 && opposite && !others.every(isMoneyAccount)) {
        const counter = others.length === 1 ? others[0]!.accountName : others.map((line) => line.accountName).join(", ");
        return bank.amountCents < 0
          ? ref("paymentOut", { amount: euros(bank.amountCents), bank: bank.accountName, counter })
          : ref("paymentIn", { amount: euros(bank.amountCents), bank: bank.accountName, counter });
      }
    }
    if (debits.length === 1 && credits.length === 1) {
      return ref("transfer", { amount: euros(debits[0]!.amountCents), from: credits[0]!.accountName, to: debits[0]!.accountName });
    }
  }
  return manual;
}
