// Stable error codes (AGENTS.md "Code": `as const` sets, never raw text). The UI maps them to
// `Ledger.errors` in `de.json`. Mirrors `src/persistence/use-cases/ledger-use-cases.ts`'s
// `LEDGER_ERROR`, plus `invalid_input` (a Zod parse failure in `actions.ts`), the
// `WorkspaceAccessErrorCode`s `requirePermission` returns, and `unknown`.
export const LEDGER_USE_CASE_ERROR_CODES = [
  "disabled",
  "not_found",
  "account_not_found",
  "account_archived",
  "account_number_taken",
  "owner_not_found",
  "source_not_found",
  "unbalanced",
  "locked",
  "reason_required",
  "stale_revision",
  "already_booked",
  "not_booked",
  "not_proposed",
  "invalid_filing",
  "filing_choice_required",
  "filing_overlaps",
  "filing_not_draft",
  "filing_not_submitted",
  "correction_exists",
  "account_not_open_items",
  "line_not_on_account",
  "line_already_matched",
  "match_not_zero",
  "owner_taken",
  "advisor_file_invalid",
  "rule_source_missing",
] as const;
export type LedgerUseCaseErrorCode = (typeof LEDGER_USE_CASE_ERROR_CODES)[number];

export const LEDGER_ACTION_ERROR_CODES = ["invalid_input", ...LEDGER_USE_CASE_ERROR_CODES, "unauthenticated", "no_workspace", "forbidden", "unknown"] as const;
export type LedgerActionErrorCode = (typeof LEDGER_ACTION_ERROR_CODES)[number];

/** Whether a use case's error code is one the actions pass through unchanged. */
export function isLedgerUseCaseErrorCode(code: string): code is LedgerUseCaseErrorCode {
  return (LEDGER_USE_CASE_ERROR_CODES as readonly string[]).includes(code);
}

/** The messages the database's custom SQL raises (`src/persistence/sql/ledger_*`). */
export const LEDGER_DB_RAISES = { unbalanced: "ledger_unbalanced", locked: "ledger_locked" } as const;
