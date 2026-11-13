// The ledger pages' URL filters (decisions/0080 UI: filters live in the URL as a plain GET form,
// so they can be linked and shared). An empty or malformed value counts as absent
// (decisions/0062-an-empty-search-param-means-absent.md), never as an error.
import type { ListEntriesFilter } from "./schemas";
import { JOURNAL_ENTRY_ORIGINS, type JournalEntryOrigin } from "./types";

export type RawSearchParams = Record<string, string | string[] | undefined>;

function first(params: RawSearchParams, name: string): string {
  const value = params[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

/** A real calendar date in `YYYY-MM-DD`, else `""`. */
export function isoDateParam(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : "";
}

function originParam(value: string): JournalEntryOrigin | "" {
  return (JOURNAL_ENTRY_ORIGINS as readonly string[]).includes(value) ? (value as JournalEntryOrigin) : "";
}

/** A `von`/`bis` pair in the wrong order is swapped rather than dropped. */
function ordered(from: string, to: string): [string, string] {
  return from && to && from > to ? [to, from] : [from, to];
}

// -- "Zu prüfen" ----------------------------------------------------------------------------

export type QueueFilterValues = { von: string; bis: string; herkunft: JournalEntryOrigin | ""; nurWarnungen: boolean };

/** `?von=&bis=&herkunft=&nur=warnungen` of `/dashboard/buchhaltung/zu-pruefen`. */
export function parseQueueSearchParams(params: RawSearchParams): QueueFilterValues {
  const [von, bis] = ordered(isoDateParam(first(params, "von")), isoDateParam(first(params, "bis")));
  return { von, bis, herkunft: originParam(first(params, "herkunft")), nurWarnungen: first(params, "nur") === "warnungen" };
}

export function isQueueFiltered(values: QueueFilterValues): boolean {
  return Boolean(values.von || values.bis || values.herkunft || values.nurWarnungen);
}

// -- Journal --------------------------------------------------------------------------------

export const JOURNAL_STATUS_FILTERS = ["proposed", "booked", "dismissed"] as const;
export type JournalStatusFilter = (typeof JOURNAL_STATUS_FILTERS)[number];

export const JOURNAL_PAGE_SIZE = 200;
/** `listEntriesFilterSchema` caps a page at 2000. */
export const JOURNAL_MAX_LIMIT = 2000;

export type JournalFilterValues = {
  von: string;
  bis: string;
  status: JournalStatusFilter | "";
  herkunft: JournalEntryOrigin | "";
  konto: string;
  /** A handover id: only entries changed since that handover ("geändert seit Übergabe"). */
  seit: string;
  limit: number;
};

/** `?von=&bis=&status=&herkunft=&konto=&seit=&anzahl=` of `/dashboard/buchhaltung/journal`. */
export function parseJournalSearchParams(params: RawSearchParams): JournalFilterValues {
  const [von, bis] = ordered(isoDateParam(first(params, "von")), isoDateParam(first(params, "bis")));
  const status = first(params, "status");
  const konto = first(params, "konto");
  const seit = first(params, "seit");
  const limit = Number.parseInt(first(params, "anzahl"), 10);
  return {
    von,
    bis,
    status: (JOURNAL_STATUS_FILTERS as readonly string[]).includes(status) ? (status as JournalStatusFilter) : "",
    herkunft: originParam(first(params, "herkunft")),
    konto: /^\d{4,8}$/.test(konto) ? konto : "",
    seit: /^[0-9a-f-]{36}$/i.test(seit) ? seit : "",
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.ceil(limit / JOURNAL_PAGE_SIZE) * JOURNAL_PAGE_SIZE, JOURNAL_MAX_LIMIT) : JOURNAL_PAGE_SIZE,
  };
}

/** The use case's filter for the values; `changedSince` is the chosen handover's timestamp
 * (the page resolves `seit` within the caller's own handovers). One extra row tells the page
 * whether "Mehr laden" has anything to load. */
export function journalFilterFor(values: JournalFilterValues, changedSince: string | null): ListEntriesFilter {
  return {
    ...(values.von ? { from: values.von } : {}),
    ...(values.bis ? { to: values.bis } : {}),
    ...(values.status === "proposed" || values.status === "booked" ? { status: values.status } : {}),
    ...(values.herkunft ? { origin: values.herkunft } : {}),
    ...(values.konto ? { accountNumber: values.konto } : {}),
    ...(changedSince ? { changedSince } : {}),
    dismissed: values.status === "dismissed" ? "only" : "exclude",
    limit: Math.min(values.limit + 1, JOURNAL_MAX_LIMIT),
  };
}

/** The search string for the journal with `values`, `""` values left out. */
export function journalSearch(values: JournalFilterValues, overrides: Partial<JournalFilterValues> = {}): string {
  const merged = { ...values, ...overrides };
  const query = new URLSearchParams();
  for (const name of ["von", "bis", "status", "herkunft", "konto", "seit"] as const) if (merged[name]) query.set(name, merged[name]);
  if (merged.limit !== JOURNAL_PAGE_SIZE) query.set("anzahl", String(merged.limit));
  const text = query.toString();
  return text ? `?${text}` : "";
}

// -- Konten (Summen- und Saldenliste) and Kontenblatt --------------------------------------

/** "Einfach" (rein/raus, plain language) or "Soll/Haben" (EB, Soll, Haben, Saldo). */
export const BALANCE_VIEW_MODES = ["einfach", "soll-haben"] as const;
export type BalanceViewMode = (typeof BALANCE_VIEW_MODES)[number];

export type AccountsFilterValues = { von: string; bis: string; ansicht: BalanceViewMode; alle: boolean };

/** `?von=&bis=&ansicht=&alle=1` of `/dashboard/buchhaltung/konten`; the period defaults to the
 * calendar year of `today` (from its first day to today). */
export function parseAccountsSearchParams(params: RawSearchParams, today: string): AccountsFilterValues {
  const [von, bis] = ordered(isoDateParam(first(params, "von")), isoDateParam(first(params, "bis")));
  const ansicht = first(params, "ansicht");
  return {
    von: von || `${today.slice(0, 4)}-01-01`,
    bis: bis || (von && von > today ? `${von.slice(0, 4)}-12-31` : today),
    ansicht: (BALANCE_VIEW_MODES as readonly string[]).includes(ansicht) ? (ansicht as BalanceViewMode) : "einfach",
    alle: first(params, "alle") === "1",
  };
}

/** The search string of the accounts page with `overrides`; defaults are left out except the
 * period, which every link carries. */
export function accountsSearch(values: AccountsFilterValues, overrides: Partial<AccountsFilterValues> = {}): string {
  const merged = { ...values, ...overrides };
  const query = new URLSearchParams({ von: merged.von, bis: merged.bis });
  if (merged.ansicht !== "einfach") query.set("ansicht", merged.ansicht);
  if (merged.alle) query.set("alle", "1");
  return `?${query.toString()}`;
}

export const ACCOUNT_SHEET_TABS = ["blatt", "offen"] as const;
export type AccountSheetTab = (typeof ACCOUNT_SHEET_TABS)[number];

export type AccountSheetFilterValues = { von: string; bis: string; vorschlaege: boolean; tab: AccountSheetTab };

/** `?von=&bis=&vorschlaege=1&tab=offen` of `/dashboard/buchhaltung/konten/[nummer]`. */
export function parseAccountSheetSearchParams(params: RawSearchParams, today: string): AccountSheetFilterValues {
  const period = parseAccountsSearchParams(params, today);
  return { von: period.von, bis: period.bis, vorschlaege: first(params, "vorschlaege") === "1", tab: first(params, "tab") === "offen" ? "offen" : "blatt" };
}

export function accountSheetSearch(values: AccountSheetFilterValues, overrides: Partial<AccountSheetFilterValues> = {}): string {
  const merged = { ...values, ...overrides };
  const query = new URLSearchParams({ von: merged.von, bis: merged.bis });
  if (merged.vorschlaege) query.set("vorschlaege", "1");
  if (merged.tab !== "blatt") query.set("tab", merged.tab);
  return `?${query.toString()}`;
}
