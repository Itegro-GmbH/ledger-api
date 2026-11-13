// The ledger's controls and the derived period status (decisions/0080 "Controls", spec
// section 4). Pure: the use case gathers the facts (bank movements, unbooked sources, open-item
// states), these functions decide what passes.
import type { OpenItemAccountStatus, PeriodStatus, ControlId, ControlStatus, MessageRef, VatPeriod } from "./types";
import type { Period } from "./reports";

// ---------------------------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------------------------

export type LabeledPeriod = Period & { key: string };

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthPeriod(year: number, month: number): LabeledPeriod {
  return { key: `${year}-${pad(month)}`, from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDayOfMonth(year, month))}` };
}

function quarterPeriod(year: number, quarter: number): LabeledPeriod {
  const firstMonth = (quarter - 1) * 3 + 1;
  const lastMonth = firstMonth + 2;
  return { key: `${year}-Q${quarter}`, from: `${year}-${pad(firstMonth)}-01`, to: `${year}-${pad(lastMonth)}-${pad(lastDayOfMonth(year, lastMonth))}` };
}

/** The USt-VA periods of a calendar year, oldest first. */
export function vatPeriodsOfYear(year: number, vatPeriod: VatPeriod): LabeledPeriod[] {
  if (vatPeriod === "quarter") return [1, 2, 3, 4].map((quarter) => quarterPeriod(year, quarter));
  return Array.from({ length: 12 }, (_, i) => monthPeriod(year, i + 1));
}

/** The USt-VA period an ISO date falls into. */
export function vatPeriodOf(isoDate: string, vatPeriod: VatPeriod): LabeledPeriod {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  return vatPeriod === "quarter" ? quarterPeriod(year, Math.floor((month - 1) / 3) + 1) : monthPeriod(year, month);
}

/** The whole calendar year (what an annual statement covers and locks). */
export function yearPeriod(year: number): LabeledPeriod {
  return { key: String(year), from: `${year}-01-01`, to: `${year}-12-31` };
}

/** The day before an ISO date. */
export function dayBefore(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Bank account versus real bank balance
// ---------------------------------------------------------------------------------------------

export type DailyMovement = { date: string; amountCents: number };

export type BankBalanceInput = {
  accountNumber: string;
  /** The ledger account: its balance before its first movement, and every booked movement. */
  ledger: { openingCents: number; movements: readonly DailyMovement[] };
  /** The real bank account: the statement balance before its first transaction, and every
   * imported transaction. */
  real: { openingCents: number; movements: readonly DailyMovement[] };
};

export type BankBalanceComparison = {
  accountNumber: string;
  ok: boolean;
  /** The first day in the period where both balances differ (the opening counts as `from`). */
  firstDivergenceDate: string | null;
  ledgerClosingCents: number;
  realClosingCents: number;
};

function balanceBefore(opening: number, movements: readonly DailyMovement[], date: string): number {
  return movements.reduce((sum, movement) => (movement.date < date ? sum + movement.amountCents : sum), opening);
}

function sumByDay(movements: readonly DailyMovement[], period: Period): Map<string, number> {
  const out = new Map<string, number>();
  for (const movement of movements) {
    if (movement.date < period.from || movement.date > period.to) continue;
    out.set(movement.date, (out.get(movement.date) ?? 0) + movement.amountCents);
  }
  return out;
}

/** Compares the ledger's bank account with the real bank balance on every day of the period
 * on which either side moved, and on the period's first day. */
export function compareBankBalances(input: BankBalanceInput, period: Period): BankBalanceComparison {
  let ledger = balanceBefore(input.ledger.openingCents, input.ledger.movements, period.from);
  let real = balanceBefore(input.real.openingCents, input.real.movements, period.from);
  let firstDivergence: string | null = ledger === real ? null : period.from;

  const ledgerDays = sumByDay(input.ledger.movements, period);
  const realDays = sumByDay(input.real.movements, period);
  const days = [...new Set([...ledgerDays.keys(), ...realDays.keys()])].sort();
  for (const day of days) {
    ledger += ledgerDays.get(day) ?? 0;
    real += realDays.get(day) ?? 0;
    if (firstDivergence === null && ledger !== real) firstDivergence = day;
  }
  return { accountNumber: input.accountNumber, ok: firstDivergence === null && ledger === real, firstDivergenceDate: firstDivergence, ledgerClosingCents: ledger, realClosingCents: real };
}

// ---------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------

export type ControlsInput = {
  bank: readonly BankBalanceComparison[];
  unbookedBankTransactionIds: readonly string[];
  unbookedDocumentIds: readonly string[];
  openItemAccounts: readonly { accountNumber: string; status: OpenItemAccountStatus; balanceCents: number }[];
  proposalsWaiting: number;
  unbalancedProposals: number;
  /** `null` when no Summen- und Saldenliste of the tax advisor was uploaded for the period. */
  advisorDifferences: number | null;
};

export type ControlResult = {
  id: ControlId;
  status: ControlStatus;
  count: number;
  /** `Ledger.controls.<id>.<status>` with its values. */
  message: MessageRef;
  /** The ids or account numbers the control is about, for the UI to link. */
  subjects: string[];
};

function result(id: ControlId, status: ControlStatus, count: number, subjects: string[], params: Record<string, string | number> = {}): ControlResult {
  return { id, status, count, subjects, message: { key: `controls.${id}.${status}`, params: { count, ...params } } };
}

/** Every control, in `CONTROL_IDS` order. */
export function computeControls(input: ControlsInput): ControlResult[] {
  const out: ControlResult[] = [];

  if (input.bank.length === 0) {
    out.push(result("bank_matches_statement", "not_applicable", 0, []));
  } else {
    const failing = input.bank.filter((bank) => !bank.ok);
    if (failing.length === 0) {
      out.push(result("bank_matches_statement", "ok", 0, []));
    } else {
      const first = [...failing].sort((a, b) => (a.firstDivergenceDate ?? "").localeCompare(b.firstDivergenceDate ?? ""))[0]!;
      out.push(
        result(
          "bank_matches_statement",
          "failed",
          failing.length,
          failing.map((bank) => bank.accountNumber),
          { account: first.accountNumber, date: first.firstDivergenceDate ?? "", differenceCents: first.ledgerClosingCents - first.realClosingCents },
        ),
      );
    }
  }

  const unbookedTx = input.unbookedBankTransactionIds.length;
  out.push(result("unbooked_bank_transactions", unbookedTx > 0 ? "failed" : "ok", unbookedTx, [...input.unbookedBankTransactionIds]));

  const unbookedDocs = input.unbookedDocumentIds.length;
  out.push(result("unbooked_documents", unbookedDocs > 0 ? "warning" : "ok", unbookedDocs, [...input.unbookedDocumentIds]));

  const openAccounts = input.openItemAccounts.filter((account) => account.status === "open");
  let openItemsStatus: ControlStatus = openAccounts.length > 0 ? "failed" : "ok";
  if (input.openItemAccounts.length === 0) openItemsStatus = "not_applicable";
  out.push(
    result(
      "open_item_accounts",
      openItemsStatus,
      openAccounts.length,
      openAccounts.map((account) => account.accountNumber),
    ),
  );

  out.push(result("unbalanced_entries", input.unbalancedProposals > 0 ? "failed" : "ok", input.unbalancedProposals, []));
  out.push(result("proposals_waiting", input.proposalsWaiting > 0 ? "warning" : "ok", input.proposalsWaiting, []));

  if (input.advisorDifferences === null) out.push(result("advisor_differences", "not_applicable", 0, []));
  else out.push(result("advisor_differences", input.advisorDifferences > 0 ? "warning" : "ok", input.advisorDifferences, []));

  return out;
}

/** Controls that keep a period from being "bereit". The comparison with the tax advisor is
 * informative: her figures usually arrive after the period is ready. */
function blocksReady(control: ControlResult): boolean {
  return control.id !== "advisor_differences" && (control.status === "failed" || control.status === "warning");
}

export type PeriodStatusInput = {
  submitted: boolean;
  /** The newest handover covering the period, with the changes made since. */
  handover: { changesSince: number } | null;
  controls: readonly ControlResult[];
  bookedCount: number;
  proposedCount: number;
};

export type DerivedPeriodStatus = { status: PeriodStatus; changesSince: number; failingControls: ControlId[] };

/** submitted > handed over > ready (booked and every control passes) > in progress > open. */
export function derivePeriodStatus(input: PeriodStatusInput): DerivedPeriodStatus {
  const failingControls = input.controls.filter(blocksReady).map((control) => control.id);
  const changesSince = input.handover?.changesSince ?? 0;
  if (input.submitted) return { status: "submitted", changesSince, failingControls };
  if (input.handover) return { status: "handed_over", changesSince, failingControls };
  if (input.bookedCount > 0 && failingControls.length === 0) return { status: "ready", changesSince, failingControls };
  if (input.bookedCount > 0 || input.proposedCount > 0) return { status: "in_progress", changesSince, failingControls };
  return { status: "open", changesSince, failingControls };
}
