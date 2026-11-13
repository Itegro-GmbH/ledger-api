// A document's payment status from its confirmed links (Digipost's stored `payment_status` with
// `resolveDisplayStatus`'s overdue upgrade, computed on read here because nothing else writes it).
// Pure, shared by the source repository and the source reader.

export const DOCUMENT_PAYMENT_STATUSES = ["not_applicable", "open", "partially_paid", "paid", "overdue"] as const;
export type DocumentPaymentStatus = (typeof DOCUMENT_PAYMENT_STATUSES)[number];

/**
 * `not_applicable` without a total (or a zero one); `paid` once the confirmed links cover the
 * total's absolute amount; otherwise `overdue` past the due date, else `partially_paid` or `open`.
 * `today` is an ISO date.
 */
export function documentPaymentStatus(doc: { totalAmountCents: number | null; dueDate: string | null }, confirmedCents: number, today: string): DocumentPaymentStatus {
  if (!doc.totalAmountCents) return "not_applicable";
  if (confirmedCents >= Math.abs(doc.totalAmountCents)) return "paid";
  if (doc.dueDate && doc.dueDate < today) return "overdue";
  return confirmedCents > 0 ? "partially_paid" : "open";
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
