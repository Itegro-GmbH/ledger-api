// The tax advisor's Summen- und Saldenliste (spec section 4 "advisor comparison"): a lenient
// parser for the DATEV CSV export and the per-account comparison with the ledger's own closing
// balances. Exports differ by program and settings (column names, an "EXTF" preamble, one
// "S/H" column or separate "Saldo Soll"/"Saldo Haben" columns), so the parser looks for the
// header row by name instead of a fixed layout.

export type AdvisorBalanceRow = { accountNumber: string; accountName: string | null; balanceCents: number };

export const ADVISOR_PARSE_ERRORS = ["no_header", "no_balance_column", "no_rows", "too_many_rows", "amount_too_large"] as const;
export type AdvisorParseError = (typeof ADVISOR_PARSE_ERRORS)[number];

/** A Summen- und Saldenliste has a few hundred accounts; more rows is not one. */
export const MAX_ADVISOR_ROWS = 5000;
/** A balance is stored in a Postgres `integer`. */
const MAX_BALANCE_CENTS = 2_147_483_647;

export type AdvisorParseResult =
  | { ok: true; rows: AdvisorBalanceRow[]; skippedLines: number[] }
  | { ok: false; error: AdvisorParseError };

/** One CSV line into cells: `;` separated, `"` quotes with `""` as an escaped quote. */
function splitCsvLine(line: string, separator: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === separator) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function normalizeHeader(cell: string): string {
  return cell.toLowerCase().replace(/\s+/g, " ").replace(/[.:]/g, "").trim();
}

const ACCOUNT_HEADERS = new Set(["konto", "kontonummer", "kontonr", "kto", "ktonr", "kto-nr", "sachkonto", "konto-nr"]);
const NAME_HEADERS = new Set(["beschriftung", "kontobeschriftung", "bezeichnung", "kontobezeichnung", "name", "kontoname"]);
const INDICATOR_HEADERS = new Set(["s/h", "sh", "soll/haben"]);

/** A German amount ("1.234,56", "-0,15", "12,00 H") to signed cents; `null` when unreadable.
 * A trailing or embedded "S"/"H" is returned separately. */
export function parseGermanAmount(raw: string): { cents: number; indicator: "S" | "H" | null } | null {
  let text = raw.replace(/\s+/g, "").replace(/€|EUR/gi, "");
  let indicator: "S" | "H" | null = null;
  const match = /^(.*?)([SH])$/i.exec(text);
  if (match) {
    text = match[1]!;
    indicator = match[2]!.toUpperCase() as "S" | "H";
  }
  if (text === "") return { cents: 0, indicator };
  if (!/^[+-]?(\d{1,3}(\.\d{3})*|\d+)(,\d{1,2})?$/.test(text)) return null;
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace(/^[+-]/, "").replace(/\./g, "").split(",");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return { cents: negative ? -cents : cents, indicator };
}

function applyIndicator(cents: number, indicator: string | null): number {
  const value = indicator?.trim().toUpperCase();
  if (value === "H") return -Math.abs(cents);
  if (value === "S") return Math.abs(cents);
  return cents;
}

type Layout = {
  account: number;
  name: number | null;
  balance: number | null;
  indicator: number | null;
  debitBalance: number | null;
  creditBalance: number | null;
};

function findLayout(header: string[]): Layout | null {
  const normalized = header.map(normalizeHeader);
  const account = normalized.findIndex((cell) => ACCOUNT_HEADERS.has(cell));
  if (account < 0) return null;
  const nameIndex = normalized.findIndex((cell) => NAME_HEADERS.has(cell));

  let balance: number | null = null;
  let indicator: number | null = null;
  let debitBalance: number | null = null;
  let creditBalance: number | null = null;
  for (let index = 0; index < normalized.length; index++) {
    const cell = normalized[index];
    if (cell === "saldo soll") debitBalance = index;
    else if (cell === "saldo haben") creditBalance = index;
    else if (cell === "saldo s/h" || cell === "s/h saldo") indicator = index;
    // The last plain "Saldo" column wins: DATEV lists the cumulative one after the month's.
    else if (cell === "saldo" || cell === "saldo kumuliert" || cell === "endsaldo" || cell === "saldo aktuell") balance = index;
  }
  if (balance !== null && indicator === null && INDICATOR_HEADERS.has(normalized[balance + 1] ?? "")) indicator = balance + 1;
  return { account, name: nameIndex >= 0 ? nameIndex : null, balance, indicator, debitBalance, creditBalance };
}

/** Parses a DATEV Summen- und Saldenliste CSV export. Lines before the header row (an "EXTF"
 * preamble, a title) and lines without a numeric account (sums, blank lines) are skipped. */
export function parseDatevBalanceList(csv: string): AdvisorParseResult {
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/);
  let layout: Layout | null = null;
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const found = findLayout(splitCsvLine(lines[i]!, ";"));
    if (found) {
      layout = found;
      headerIndex = i;
      break;
    }
  }
  if (!layout) return { ok: false, error: "no_header" };
  if (layout.balance === null && (layout.debitBalance === null || layout.creditBalance === null)) return { ok: false, error: "no_balance_column" };

  const rows: AdvisorBalanceRow[] = [];
  const skippedLines: number[] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const cells = splitCsvLine(line, ";");
    const accountNumber = (cells[layout.account] ?? "").replace(/\s+/g, "");
    if (!/^\d{3,9}$/.test(accountNumber)) continue;

    let cents: number | null = null;
    if (layout.balance !== null) {
      const parsed = parseGermanAmount(cells[layout.balance] ?? "");
      if (parsed) cents = applyIndicator(parsed.cents, parsed.indicator ?? (layout.indicator !== null ? (cells[layout.indicator] ?? null) : null));
    } else if (layout.debitBalance !== null && layout.creditBalance !== null) {
      const debit = parseGermanAmount(cells[layout.debitBalance] ?? "");
      const credit = parseGermanAmount(cells[layout.creditBalance] ?? "");
      if (debit && credit) cents = Math.abs(debit.cents) - Math.abs(credit.cents);
    }
    if (cents === null) {
      skippedLines.push(i + 1);
      continue;
    }
    if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_BALANCE_CENTS) return { ok: false, error: "amount_too_large" };
    if (rows.length >= MAX_ADVISOR_ROWS) return { ok: false, error: "too_many_rows" };
    const name = layout.name !== null ? (cells[layout.name] ?? "").trim() : "";
    rows.push({ accountNumber, accountName: name === "" ? null : name, balanceCents: cents });
  }
  if (rows.length === 0) return { ok: false, error: "no_rows" };
  return { ok: true, rows, skippedLines };
}

export type AdvisorComparisonRow = {
  accountNumber: string;
  name: string | null;
  oursCents: number;
  theirsCents: number;
  differenceCents: number;
};

export type AdvisorComparison = { rows: AdvisorComparisonRow[]; differenceCount: number };

/** Per account number: the ledger's closing balance against the tax advisor's, every account
 * either side knows with a non-zero balance, sorted by number. */
export function compareWithAdvisor(
  ours: readonly { number: string; name: string; closingCents: number }[],
  theirs: readonly AdvisorBalanceRow[],
): AdvisorComparison {
  const map = new Map<string, AdvisorComparisonRow>();
  for (const row of ours) {
    map.set(row.number, { accountNumber: row.number, name: row.name, oursCents: row.closingCents, theirsCents: 0, differenceCents: 0 });
  }
  for (const row of theirs) {
    const existing = map.get(row.accountNumber) ?? { accountNumber: row.accountNumber, name: row.accountName, oursCents: 0, theirsCents: 0, differenceCents: 0 };
    existing.theirsCents += row.balanceCents;
    if (!existing.name) existing.name = row.accountName;
    map.set(row.accountNumber, existing);
  }
  const rows = [...map.values()]
    .map((row) => ({ ...row, differenceCents: row.oursCents - row.theirsCents }))
    .filter((row) => row.oursCents !== 0 || row.theirsCents !== 0)
    .sort((a, b) => a.accountNumber.localeCompare(b.accountNumber, "de", { numeric: true }));
  return { rows, differenceCount: rows.filter((row) => row.differenceCents !== 0).length };
}
