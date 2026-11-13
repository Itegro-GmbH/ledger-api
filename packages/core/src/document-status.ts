// The ledger's status of one document (decisions/0080 UI: the document page's "Buchhaltung"
// card). Pure: the read model loads the document's entries and the filings.
import { lockingFilingFor } from "./periods";
import type { FilingView, JournalEntryListItem, LedgerDocumentEntry, LedgerDocumentStatus } from "./types";

const ORDER: Record<LedgerDocumentStatus["state"], number> = { locked: 3, booked: 2, proposed: 1, none: 0 };

function stateOf(entry: LedgerDocumentEntry): LedgerDocumentStatus["state"] {
  if (entry.dismissed) return "none";
  if (entry.status === "booked") return entry.lockedBy ? "locked" : "booked";
  return "proposed";
}

/** Every entry of the document (booked first, then proposals, dismissed last) and the strongest
 * state among them. A dismissed proposal alone counts as "keine Buchung". */
export function ledgerDocumentStatusOf(entries: readonly JournalEntryListItem[], filings: readonly FilingView[]): LedgerDocumentStatus {
  const views = entries.map((entry): LedgerDocumentEntry => {
    const filing = entry.status === "booked" ? lockingFilingFor(filings, entry.bookingDate) : null;
    return {
      id: entry.id,
      status: entry.status,
      dismissed: entry.dismissed,
      bookingDate: entry.bookingDate,
      totalCents: entry.totalCents,
      summary: entry.summary,
      lockedBy: filing ? { id: filing.id, kind: filing.kind, periodFrom: filing.periodFrom, periodTo: filing.periodTo } : null,
    };
  });
  views.sort((a, b) => ORDER[stateOf(b)] - ORDER[stateOf(a)] || a.bookingDate.localeCompare(b.bookingDate));
  const state = views.reduce<LedgerDocumentStatus["state"]>((best, entry) => (ORDER[stateOf(entry)] > ORDER[best] ? stateOf(entry) : best), "none");
  return { state, entries: views };
}
