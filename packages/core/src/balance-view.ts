// The living Summen- und Saldenliste's view model (decisions/0080 UI concept B, screen A): the
// balance rows grouped for display, with plain-language amounts for the "Einfach" view. Pure, so
// the grouping and the signs are unit-tested without rendering.
import type { BalanceRow } from "./reports";
import { LEDGER_ACCOUNT_GROUPS, type LedgerAccountGroup, type LedgerAccountKind, type LedgerAccountView } from "./types";

/** Accounts whose balance normally sits on the Haben side: shown with the sign flipped in the
 * "Einfach" view, so share capital, revenue and debts read as positive amounts. */
export function isCreditNormal(kind: LedgerAccountKind): boolean {
  return kind === "liability" || kind === "equity" || kind === "revenue";
}

export type BalanceViewRow = BalanceRow & {
  description: string | null;
  /** The closing balance in the account's own direction ("Stand"). */
  naturalCents: number;
  /** What increased the account in the period ("rein") and what decreased it ("raus"). */
  inCents: number;
  outCents: number;
};

export type BalanceViewGroup = {
  group: LedgerAccountGroup;
  rows: BalanceViewRow[];
  totals: { openingCents: number; debitCents: number; creditCents: number; closingCents: number; inCents: number; outCents: number };
  /** The sum of "Stand" when every account of the group runs the same direction; `null` for a
   * mixed group (Vorsteuer and Umsatzsteuer cannot be added up as one "Stand"). */
  naturalCents: number | null;
};

function viewRow(row: BalanceRow, description: string | null): BalanceViewRow {
  const credit = isCreditNormal(row.kind);
  return {
    ...row,
    description,
    naturalCents: credit ? -row.closingCents : row.closingCents,
    inCents: credit ? row.creditCents : row.debitCents,
    outCents: credit ? row.debitCents : row.creditCents,
  };
}

function emptyRow(account: LedgerAccountView): BalanceRow {
  return {
    accountId: account.id,
    number: account.number,
    name: account.name,
    kind: account.kind,
    group: account.group,
    openItems: account.openItems,
    openingCents: 0,
    debitCents: 0,
    creditCents: 0,
    closingCents: 0,
  };
}

/**
 * Groups the balance rows in `LEDGER_ACCOUNT_GROUPS` order ("Bank und Geld" first), each sorted
 * by account number, with subtotals. With `showEmpty`, every account of the chart that is not
 * archived and has no movement joins its group with zeros ("Konten ohne Bewegung zeigen").
 * Groups without a row are left out.
 */
export function buildBalanceGroups(rows: readonly BalanceRow[], accounts: readonly LedgerAccountView[], options: { showEmpty: boolean }): BalanceViewGroup[] {
  const descriptions = new Map(accounts.map((account) => [account.id, account.description]));
  const all: BalanceRow[] = [...rows];
  if (options.showEmpty) {
    const present = new Set(rows.map((row) => row.accountId));
    for (const account of accounts) if (!account.archived && !present.has(account.id)) all.push(emptyRow(account));
  }

  const groups: BalanceViewGroup[] = [];
  for (const group of LEDGER_ACCOUNT_GROUPS) {
    const groupRows = all
      .filter((row) => row.group === group)
      .sort((a, b) => a.number.localeCompare(b.number, "de", { numeric: true }))
      .map((row) => viewRow(row, descriptions.get(row.accountId) ?? null));
    if (groupRows.length === 0) continue;
    const totals = groupRows.reduce(
      (sum, row) => ({
        openingCents: sum.openingCents + row.openingCents,
        debitCents: sum.debitCents + row.debitCents,
        creditCents: sum.creditCents + row.creditCents,
        closingCents: sum.closingCents + row.closingCents,
        inCents: sum.inCents + row.inCents,
        outCents: sum.outCents + row.outCents,
      }),
      { openingCents: 0, debitCents: 0, creditCents: 0, closingCents: 0, inCents: 0, outCents: 0 },
    );
    const directions = new Set(groupRows.map((row) => isCreditNormal(row.kind)));
    groups.push({ group, rows: groupRows, totals, naturalCents: directions.size === 1 ? groupRows.reduce((sum, row) => sum + row.naturalCents, 0) : null });
  }
  return groups;
}

/** A row's status chip on the accounts page: a bank account against its statement, an
 * open-item account settled, explained or still open. */
export type AccountStatusChip =
  | { kind: "bank_ok" }
  | { kind: "bank_diff"; since: string | null }
  | { kind: "items_zero" }
  | { kind: "items_explained" }
  | { kind: "items_open"; count: number };

/** Which explanation the "Offene Posten" tab opens with: what this kind of open-item account is
 * for (decisions/0080 cases: Meta prepaid and Google Ads charged first, a platform's payout, a
 * shareholder's expenses, ordinary payables). */
export const OPEN_ITEM_ACCOUNT_TYPES = ["prepaid", "receivable", "shareholder", "payable", "generic"] as const;
export type OpenItemAccountType = (typeof OPEN_ITEM_ACCOUNT_TYPES)[number];

export function openItemAccountType(account: Pick<LedgerAccountView, "number" | "ownerType" | "kind">): OpenItemAccountType {
  if (account.ownerType === "person") return "shareholder";
  if (account.ownerType === "platform") return "receivable";
  if (account.ownerType === "contact") return "prepaid";
  if (account.number === "1200") return "receivable";
  if (account.kind === "liability") return account.number.startsWith("35") ? "shareholder" : "payable";
  return "generic";
}
