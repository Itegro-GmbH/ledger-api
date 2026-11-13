// Pure reports over booked journal lines (decisions/0080 "Controls", spec section 4): the
// Summen- und Saldenliste, the account sheet, open items per open-item account and the USt-VA
// preview. The use case loads the lines; nothing here reads a database.
//
// Signs: debit (Soll) positive, credit (Haben) negative. A balance is the plain sum, so an asset
// with money on it is positive and a liability or a revenue account is negative, exactly as a
// DATEV list shows it with "S" and "H".
import { TAX_ACCOUNT_KENNZAHLEN, TAX_CODE_DEFINITIONS } from "./tax-codes";
import {
  VAT_KENNZAHLEN,
  type LedgerAccountGroup,
  type LedgerAccountKind,
  type OpenItemAccountStatus,
  type OpenItemMatchKind,
  type TaxCode,
  type TaxRole,
  type VatKennzahl,
} from "./types";

export type ReportAccount = {
  id: string;
  number: string;
  name: string;
  kind: LedgerAccountKind;
  group: LedgerAccountGroup;
  openItems: boolean;
};

export type ReportLine = {
  lineId: string;
  entryId: string;
  position: number;
  accountId: string;
  accountNumber: string;
  bookingDate: string;
  amountCents: number;
  taxCode: TaxCode | null;
  taxRole: TaxRole | null;
  text: string | null;
  entryText: string;
  documentId: string | null;
  transactionId: string | null;
  /** The line belongs to a proposal, not a booked entry. Only the account sheet loads
   * proposals (shown dashed, counted only on request); every other report is booked only. */
  proposed?: boolean;
};

export type Period = { from: string; to: string };

/** Revenue and expense accounts start every calendar year at zero (the profit moves into
 * equity with the annual statement); every other kind carries its balance forward. */
export function carriesBalanceForward(kind: LedgerAccountKind): boolean {
  return kind === "asset" || kind === "liability" || kind === "equity";
}

function yearStartOf(isoDate: string): string {
  return `${isoDate.slice(0, 4)}-01-01`;
}

/** SKR 04 "Gewinnvortrag vor Verwendung": where a list starting in a later year carries the
 * result of the earlier years (their revenue and expense lines), so its openings still add up to
 * zero. In the seed chart; a synthetic row stands in when a workspace's chart lacks it. */
export const RETAINED_EARNINGS_ACCOUNT = { number: "2970", name: "Gewinnvortrag vor Verwendung" } as const;

/** The result of every year before the one `from` lies in: the sum of the revenue and expense
 * lines booked before that year's start (negative is a profit, as on a credit-normal account). */
export function priorYearsResult(kindOf: (accountId: string) => LedgerAccountKind | undefined, lines: readonly ReportLine[], from: string): number {
  const start = yearStartOf(from);
  let result = 0;
  for (const line of lines) {
    if (line.bookingDate >= start) continue;
    const kind = kindOf(line.accountId);
    if (kind && !carriesBalanceForward(kind)) result += line.amountCents;
  }
  return result;
}

/** Whether a line before `from` counts toward the account's opening balance. */
function countsTowardOpening(kind: LedgerAccountKind, bookingDate: string, from: string): boolean {
  if (bookingDate >= from) return false;
  return carriesBalanceForward(kind) || bookingDate >= yearStartOf(from);
}

export type BalanceRow = {
  accountId: string;
  number: string;
  name: string;
  kind: LedgerAccountKind;
  group: LedgerAccountGroup;
  openItems: boolean;
  openingCents: number;
  debitCents: number;
  creditCents: number;
  closingCents: number;
};

export type BalanceList = {
  rows: BalanceRow[];
  totals: { openingCents: number; debitCents: number; creditCents: number; closingCents: number };
};

/** The Summen- und Saldenliste for a period: per account the opening balance, the debit and
 * credit sums inside the period (credit as a positive amount), and the closing balance. Only
 * accounts with a non-zero value appear. Sorted by account number. */
export function computeBalances(accounts: readonly ReportAccount[], lines: readonly ReportLine[], period: Period): BalanceList {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const acc = new Map<string, { opening: number; debit: number; credit: number }>();
  for (const line of lines) {
    const account = byId.get(line.accountId);
    if (!account || line.bookingDate > period.to) continue;
    const entry = acc.get(account.id) ?? { opening: 0, debit: 0, credit: 0 };
    if (line.bookingDate < period.from) {
      if (countsTowardOpening(account.kind, line.bookingDate, period.from)) entry.opening += line.amountCents;
    } else if (line.amountCents > 0) {
      entry.debit += line.amountCents;
    } else {
      entry.credit -= line.amountCents;
    }
    acc.set(account.id, entry);
  }

  // Revenue and expense accounts restart every year; their earlier result opens on 2970.
  const carried = priorYearsResult((id) => byId.get(id)?.kind, lines, period.from);
  const retained = accounts.find((account) => account.number === RETAINED_EARNINGS_ACCOUNT.number);
  const listed = retained ? accounts : [...accounts, { id: `synthetic:${RETAINED_EARNINGS_ACCOUNT.number}`, number: RETAINED_EARNINGS_ACCOUNT.number, name: RETAINED_EARNINGS_ACCOUNT.name, kind: "equity" as const, group: "equity" as const, openItems: false }];
  if (carried !== 0) {
    const id = retained?.id ?? `synthetic:${RETAINED_EARNINGS_ACCOUNT.number}`;
    const entry = acc.get(id) ?? { opening: 0, debit: 0, credit: 0 };
    entry.opening += carried;
    acc.set(id, entry);
  }

  const rows: BalanceRow[] = [];
  for (const account of listed) {
    const values = acc.get(account.id);
    if (!values) continue;
    const closing = values.opening + values.debit - values.credit;
    if (values.opening === 0 && values.debit === 0 && values.credit === 0) continue;
    rows.push({
      accountId: account.id,
      number: account.number,
      name: account.name,
      kind: account.kind,
      group: account.group,
      openItems: account.openItems,
      openingCents: values.opening,
      debitCents: values.debit,
      creditCents: values.credit,
      closingCents: closing,
    });
  }
  rows.sort((a, b) => a.number.localeCompare(b.number, "de", { numeric: true }));
  const totals = rows.reduce(
    (sum, row) => ({
      openingCents: sum.openingCents + row.openingCents,
      debitCents: sum.debitCents + row.debitCents,
      creditCents: sum.creditCents + row.creditCents,
      closingCents: sum.closingCents + row.closingCents,
    }),
    { openingCents: 0, debitCents: 0, creditCents: 0, closingCents: 0 },
  );
  return { rows, totals };
}

/** The closing balance of every account on `asOf` (inclusive), keyed by account number. */
export function closingBalancesByNumber(accounts: readonly ReportAccount[], lines: readonly ReportLine[], period: Period): Map<string, number> {
  const list = computeBalances(accounts, lines, period);
  return new Map(list.rows.map((row) => [row.number, row.closingCents]));
}

export type AccountSheetRow = {
  lineId: string;
  entryId: string;
  bookingDate: string;
  text: string;
  amountCents: number;
  runningBalanceCents: number;
  counterAccountNumbers: string[];
  taxCode: TaxCode | null;
  taxRole: TaxRole | null;
  documentId: string | null;
  transactionId: string | null;
  /** A proposal's line: listed, but in the balance only with `countProposals`. */
  proposed: boolean;
};

export type AccountSheet = {
  account: ReportAccount;
  openingCents: number;
  debitCents: number;
  creditCents: number;
  closingCents: number;
  rows: AccountSheetRow[];
};

function compareLines(a: ReportLine, b: ReportLine): number {
  if (a.bookingDate !== b.bookingDate) return a.bookingDate < b.bookingDate ? -1 : 1;
  if (a.entryId !== b.entryId) return a.entryId < b.entryId ? -1 : 1;
  return a.position - b.position;
}

/**
 * The Kontenblatt: every line of one account in the period, oldest first, with the running
 * balance and the accounts on the other side of each entry. `lines` must contain every line of
 * every entry touching the account (the counter accounts come from them). Lines of proposals
 * (`proposed`) are listed but leave the balance and the sums alone unless `countProposals`.
 */
export function computeAccountSheet(account: ReportAccount, lines: readonly ReportLine[], period: Period, options: { countProposals?: boolean; carriedResultCents?: number } = {}): AccountSheet {
  const counts = (line: ReportLine) => !line.proposed || options.countProposals === true;
  const byEntry = new Map<string, ReportLine[]>();
  for (const line of lines) {
    const list = byEntry.get(line.entryId) ?? [];
    list.push(line);
    byEntry.set(line.entryId, list);
  }

  // 2970 opens with the earlier years' result, like its row in the Summen- und Saldenliste.
  let opening = account.number === RETAINED_EARNINGS_ACCOUNT.number ? (options.carriedResultCents ?? 0) : 0;
  const inPeriod: ReportLine[] = [];
  for (const line of lines) {
    if (line.accountId !== account.id || line.bookingDate > period.to) continue;
    if (line.bookingDate < period.from) {
      if (counts(line) && countsTowardOpening(account.kind, line.bookingDate, period.from)) opening += line.amountCents;
      continue;
    }
    inPeriod.push(line);
  }
  inPeriod.sort(compareLines);

  let running = opening;
  let debit = 0;
  let credit = 0;
  const rows = inPeriod.map((line): AccountSheetRow => {
    if (counts(line)) {
      running += line.amountCents;
      if (line.amountCents > 0) debit += line.amountCents;
      else credit -= line.amountCents;
    }
    const others = (byEntry.get(line.entryId) ?? []).filter((other) => other.accountId !== account.id);
    const opposite = others.filter((other) => Math.sign(other.amountCents) === -Math.sign(line.amountCents));
    const counters = [...new Set((opposite.length > 0 ? opposite : others).map((other) => other.accountNumber))];
    return {
      lineId: line.lineId,
      entryId: line.entryId,
      bookingDate: line.bookingDate,
      text: line.text ?? line.entryText,
      amountCents: line.amountCents,
      runningBalanceCents: running,
      counterAccountNumbers: counters,
      taxCode: line.taxCode,
      taxRole: line.taxRole,
      documentId: line.documentId,
      transactionId: line.transactionId,
      proposed: line.proposed === true,
    };
  });
  return { account, openingCents: opening, debitCents: debit, creditCents: credit, closingCents: running, rows };
}

export type OpenItemMatchInput = { id: string; kind: OpenItemMatchKind; note: string | null; lineIds: readonly string[] };

export type OpenItemMatchView = { id: string; kind: OpenItemMatchKind; note: string | null; sumCents: number; lines: ReportLine[] };

export type OpenItems = {
  balanceCents: number;
  status: OpenItemAccountStatus;
  /** Lines in no match: what is still open, oldest first. */
  unmatched: ReportLine[];
  unmatchedSumCents: number;
  matches: OpenItemMatchView[];
};

/**
 * Open items of one open-item account up to `asOf`: which lines are settled by a match, which
 * remainder a note explains, and what is still open. Status: `zero` when the balance is zero,
 * `explained` when it is not but every line belongs to a match or an explanation, otherwise
 * `open`.
 */
export function computeOpenItems(accountId: string, lines: readonly ReportLine[], matches: readonly OpenItemMatchInput[], asOf: string): OpenItems {
  const own = lines.filter((line) => line.accountId === accountId && line.bookingDate <= asOf).sort(compareLines);
  const byId = new Map(own.map((line) => [line.lineId, line]));
  const matched = new Set<string>();
  const views: OpenItemMatchView[] = [];
  for (const match of matches) {
    // A match settles its lines only from the day its last line is booked: before that, every
    // line of it is still open.
    const matchLines = match.lineIds.map((id) => byId.get(id)).filter((line): line is ReportLine => line !== undefined);
    if (matchLines.length === 0 || matchLines.length !== match.lineIds.length) continue;
    for (const line of matchLines) matched.add(line.lineId);
    views.push({ id: match.id, kind: match.kind, note: match.note, sumCents: matchLines.reduce((s, l) => s + l.amountCents, 0), lines: matchLines });
  }
  const unmatched = own.filter((line) => !matched.has(line.lineId));
  const balance = own.reduce((sum, line) => sum + line.amountCents, 0);
  let status: OpenItemAccountStatus = unmatched.length === 0 ? "explained" : "open";
  if (balance === 0) status = "zero";
  return { balanceCents: balance, status, unmatched, unmatchedSumCents: unmatched.reduce((s, l) => s + l.amountCents, 0), matches: views };
}

export type VatPreviewRow = { kennzahl: VatKennzahl; baseCents: number | null; taxCents: number | null };

export type VatPreview = {
  rows: VatPreviewRow[];
  outputTaxCents: number;
  inputTaxCents: number;
  /** Kennzahl 83: positive is owed to the tax office, negative is a refund. */
  payableCents: number;
};

/**
 * The USt-VA preview of a period's booked lines. Bases come from base lines with a tax code
 * that maps to a field; tax amounts come from the tax accounts themselves (1406, 1401, 1407,
 * 3806, 3801, 3837), so a tax line typed by hand counts as well. Amounts stay in cents; the
 * real form rounds bases to whole euros.
 */
export function computeVatPreview(lines: readonly Pick<ReportLine, "accountNumber" | "amountCents" | "taxCode" | "taxRole">[]): VatPreview {
  const base = new Map<VatKennzahl, number>();
  const tax = new Map<VatKennzahl, number>();
  let outputTax = 0;
  let inputTax = 0;
  for (const line of lines) {
    if (line.taxCode && line.taxRole !== "tax") {
      const def = TAX_CODE_DEFINITIONS[line.taxCode];
      if (def.baseKennzahl) base.set(def.baseKennzahl, (base.get(def.baseKennzahl) ?? 0) + def.baseSign * line.amountCents);
    }
    const taxAccount = TAX_ACCOUNT_KENNZAHLEN[line.accountNumber];
    if (!taxAccount) continue;
    const amount = taxAccount.side === "output" ? -line.amountCents : line.amountCents;
    tax.set(taxAccount.kennzahl, (tax.get(taxAccount.kennzahl) ?? 0) + amount);
    if (taxAccount.side === "output") outputTax += amount;
    else inputTax += amount;
  }
  const payable = outputTax - inputTax;
  const rows = VAT_KENNZAHLEN.map((kennzahl): VatPreviewRow => {
    if (kennzahl === "83") return { kennzahl, baseCents: null, taxCents: payable };
    const hasBase = base.has(kennzahl);
    const hasTax = tax.has(kennzahl);
    return { kennzahl, baseCents: hasBase ? (base.get(kennzahl) ?? 0) : null, taxCents: hasTax ? (tax.get(kennzahl) ?? 0) : null };
  });
  return { rows, outputTaxCents: outputTax, inputTaxCents: inputTax, payableCents: payable };
}

/**
 * The USt-VA fields one entry contributes to, in `VAT_KENNZAHLEN` order: the base field of each
 * base line's tax code and the field of each tax account it books. 83 (the Zahllast) is every
 * entry that touches any tax field, so it is left out. Lets the preview list the entries behind
 * each Kennzahl with the same rules `computeVatPreview` sums by.
 */
export function vatKennzahlenOfEntry(lines: readonly Pick<ReportLine, "accountNumber" | "taxCode" | "taxRole">[]): VatKennzahl[] {
  const found = new Set<VatKennzahl>();
  for (const line of lines) {
    if (line.taxCode && line.taxRole !== "tax") {
      const kennzahl = TAX_CODE_DEFINITIONS[line.taxCode].baseKennzahl;
      if (kennzahl) found.add(kennzahl);
    }
    const taxAccount = TAX_ACCOUNT_KENNZAHLEN[line.accountNumber];
    if (taxAccount) found.add(taxAccount.kennzahl);
  }
  return VAT_KENNZAHLEN.filter((kennzahl) => kennzahl !== "83" && found.has(kennzahl));
}
