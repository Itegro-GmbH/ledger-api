// How the UI names a period ("Juli 2026", "3. Quartal 2026", "2026") and which submitted filing
// locks a date (decisions/0080 "Locked when filed"). Pure; the use case and the database stay the
// authority on the lock itself, this only labels it.
import { vatPeriodsOfYear, type LabeledPeriod } from "./controls";
import type { FilingRef, FilingView, VatPeriod } from "./types";

export type PeriodShape =
  | { kind: "month"; year: number; month: number }
  | { kind: "quarter"; year: number; quarter: number }
  | { kind: "year"; year: number }
  | { kind: "range"; from: string; to: string };

function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A whole month, quarter or calendar year, else a plain range. */
export function describePeriod(from: string, to: string): PeriodShape {
  const year = Number(from.slice(0, 4));
  const fromMonth = Number(from.slice(5, 7));
  const toMonth = Number(to.slice(5, 7));
  const wholeMonths = from.slice(8) === "01" && Number(to.slice(8)) === lastDay(Number(to.slice(0, 4)), toMonth) && to.slice(0, 4) === from.slice(0, 4);
  if (!wholeMonths) return { kind: "range", from, to };
  if (fromMonth === toMonth) return { kind: "month", year, month: fromMonth };
  if (fromMonth === 1 && toMonth === 12) return { kind: "year", year };
  if ((fromMonth - 1) % 3 === 0 && toMonth === fromMonth + 2) return { kind: "quarter", year, quarter: (fromMonth - 1) / 3 + 1 };
  return { kind: "range", from, to };
}

/** The submitted filing whose period covers `date` (an annual statement covers its whole
 * years), or `null`. An entry tied to a draft correcting filing is exempt from the lock; list
 * views without the entry's filing id may show it as locked anyway. */
export function lockingFilingFor(filings: readonly FilingView[], date: string): FilingView | null {
  return (
    filings.find((filing) => {
      if (filing.status !== "submitted") return false;
      if (filing.kind === "annual_statement") return date >= `${filing.periodFrom.slice(0, 4)}-01-01` && date <= `${filing.periodTo.slice(0, 4)}-12-31`;
      return date >= filing.periodFrom && date <= filing.periodTo;
    }) ?? null
  );
}

/** The first day on or after `date` that no submitted filing locks: where "Korrektur buchen"
 * books its correction. */
/** The draft correcting filings an entry in a locked period can be booked into (the editor's
 * choice when there is more than one). */
export function draftCorrectionFilings(filings: readonly FilingView[]): FilingRef[] {
  return filings
    .filter((filing) => filing.status === "draft" && filing.correctsFilingId !== null)
    .map((filing) => ({ id: filing.id, kind: filing.kind, periodFrom: filing.periodFrom, periodTo: filing.periodTo }));
}

export function firstOpenDate(filings: readonly FilingView[], date: string): string {
  let current = date;
  for (let guard = 0; guard < 100; guard += 1) {
    const filing = lockingFilingFor(filings, current);
    if (!filing) return current;
    const end = filing.kind === "annual_statement" ? `${filing.periodTo.slice(0, 4)}-12-31` : filing.periodTo;
    const next = new Date(`${end}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    current = next.toISOString().slice(0, 10);
  }
  return current;
}

/** Every USt-VA period that has started by `today` and does not end before the ledger's start
 * date, newest first (the period selects of "USt-VA" and "Zeiträume"). */
export function startedVatPeriods(settings: { vatPeriod: VatPeriod; startDate: string | null }, today: string): LabeledPeriod[] {
  const startYear = Number((settings.startDate ?? today).slice(0, 4));
  const currentYear = Number(today.slice(0, 4));
  const out: LabeledPeriod[] = [];
  for (let year = currentYear; year >= startYear; year -= 1) {
    for (const period of vatPeriodsOfYear(year, settings.vatPeriod).reverse()) {
      if (period.from <= today && (!settings.startDate || period.to >= settings.startDate)) out.push(period);
    }
  }
  return out;
}
