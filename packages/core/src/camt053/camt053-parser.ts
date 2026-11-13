// Parses an ISO 20022 camt.053 (Bank-to-Customer Statement) XML document into normalized
// statements and movements, moved from Digipost's `src/modules/intake/core/camt053-parser.ts`
// (Digipost decisions/0020, decisions/0064). Deterministic and pure: camt.053 identifies itself, so
// no AI is involved.
//
// Versions .001.02 to .001.08 with the common unprefixed default namespace
// (`<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.0X">`) are supported; a message
// with a namespace prefix (`<Doc:Document ...>`) is not, as in Digipost.
import { assertSafeXml, createSafeXmlParser } from "./xml-safety";
import { computeIdempotencyKeyV2, normalizeReference, OccurrenceCounter } from "./idempotency-key";

export type CreditDebitIndicator = "credit" | "debit";

/** The document is not a camt.053 statement this parser reads. */
export class Camt053Error extends Error {
  override readonly name = "Camt053Error";
}

export type NormalizedTransaction = {
  /** v2 algorithm (`idempotency-key.ts`): sha256 hex digest over a composite of EVERY
   * available discriminator - account IBAN, booking date, value date, signed amount cents,
   * currency, credit/debit, normalized EndToEndId, normalized AcctSvcrRef, normalized
   * NtryRef, bank transaction code, mandate id, counterparty IBAN, normalized remittance
   * text, in exactly that order - never "the most specific reference alone" (see
   * `idempotency-key.ts`). Stable across re-imports of the same statement: the movement's
   * external id. */
  idempotencyKey: string;
  accountIban: string | null;
  currency: string;
  bookingDate: string;
  valueDate: string | null;
  /** Signed: positive for a credit (money in), negative for a debit (money out). */
  amountCents: number;
  creditDebit: CreditDebitIndicator;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  counterpartyBic: string | null;
  /** Structured (`RmtInf/Strd`) and unstructured (`RmtInf/Ustrd`) remittance information,
   * joined with "; " when both are present. */
  remittanceInformation: string | null;
  endToEndId: string | null;
  mandateId: string | null;
  creditorId: string | null;
  /** `Domn/Cd`, `Domn/Fmly/Cd`, `Domn/Fmly/SubFmlyCd` joined by "/" (e.g. "PMNT/RCDT/ESCT"),
   * or `null` when the entry carries no bank transaction code at all. */
  bankTransactionCode: string | null;
  accountServicerReference: string | null;
  /** The entry's own `NtryRef` - distinct from `accountServicerReference` (`AcctSvcrRef`);
   * both are real, independent ISO 20022 fields. */
  entryReference: string | null;
};

export type Camt053Balance = {
  /** `Tp/CdOrPrtry/Cd`, e.g. "OPBD" (opening booked), "CLBD" (closing booked). */
  type: string;
  date: string;
  /** Signed the same way as `NormalizedTransaction.amountCents`. */
  amountCents: number;
  currency: string;
};

export type Camt053Statement = {
  statementId: string | null;
  accountIban: string | null;
  currency: string | null;
  openingBalance: Camt053Balance | null;
  closingBalance: Camt053Balance | null;
  transactions: NormalizedTransaction[];
};

export type Camt053ParseResult = {
  version: string;
  statements: Camt053Statement[];
};

const CAMT_053_NAMESPACE_PATTERN = /urn:iso:std:iso:20022:tech:xsd:camt\.053\.001\.(0[2-8])/;

// --- generic parsed-XML-tree accessors (fast-xml-parser, ignoreAttributes: false,
// attributeNamePrefix "@_", textNodeName "#text", parseTagValue: false) ---

type XmlObject = Record<string, unknown>;

function isXmlObject(value: unknown): value is XmlObject {
  return typeof value === "object" && value !== null;
}

/** fast-xml-parser only produces an array when a tag repeats under the same parent; a
 * single occurrence stays a bare object. Every "0..n" ISO 20022 element in this parser goes
 * through this so both cases are handled uniformly. */
function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(node: unknown): string | null {
  if (node === undefined || node === null) return null;
  if (typeof node === "string") return node.length > 0 ? node : null;
  if (typeof node === "number") return String(node);
  if (isXmlObject(node) && "#text" in node) {
    const text = node["#text"];
    return text === undefined || text === null ? null : String(text);
  }
  return null;
}

function attrOf(node: unknown, name: string): string | null {
  if (!isXmlObject(node)) return null;
  const value = node[`@_${name}`];
  return value === undefined || value === null ? null : String(value);
}

function childOf(node: unknown, path: string[]): unknown {
  let current: unknown = node;
  for (const segment of path) {
    if (!isXmlObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function childText(node: unknown, path: string[]): string | null {
  return textOf(childOf(node, path));
}

/** ISO 20022 amounts always use "." as the decimal separator regardless of locale; this is
 * not the German CSV amount format. */
function amountTextToCents(text: string): number {
  const clean = text.trim().replace(/[^0-9.]/g, "");
  const [wholePart = "0", fractionPart = ""] = clean.split(".");
  const fraction = `${fractionPart}00`.slice(0, 2);
  return Number(wholePart) * 100 + Number(fraction);
}

function signedAmountCents(amountNode: unknown, creditDebitIndicator: string | null): { amountCents: number; creditDebit: CreditDebitIndicator } {
  const text = textOf(amountNode) ?? "0";
  const magnitude = Math.abs(amountTextToCents(text));
  const isDebit = creditDebitIndicator?.trim().toUpperCase() === "DBIT";
  return { amountCents: isDebit ? -magnitude : magnitude, creditDebit: isDebit ? "debit" : "credit" };
}

/**
 * The v2 composite field order for a camt.053 transaction (`idempotency-key.ts`'s
 * `computeIdempotencyKeyV2`): account IBAN, booking date, value date, signed amount cents,
 * currency, credit/debit, normalized EndToEndId, normalized AcctSvcrRef, normalized NtryRef,
 * bank transaction code, mandate id, counterparty IBAN, normalized remittance text. Every
 * reference-shaped field goes through `normalizeReference` first so a `NOTPROVIDED`-style
 * placeholder (or a whitespace/case variant of one) can never stand in for, or collide with,
 * a genuine reference.
 */
function camt053IdempotencyKeyFields(tx: {
  accountIban: string | null;
  bookingDate: string;
  valueDate: string | null;
  amountCents: number;
  currency: string;
  creditDebit: CreditDebitIndicator;
  endToEndId: string | null;
  accountServicerReference: string | null;
  entryReference: string | null;
  bankTransactionCode: string | null;
  mandateId: string | null;
  counterpartyIban: string | null;
  remittanceInformation: string | null;
}): (string | number | null)[] {
  return [
    tx.accountIban,
    tx.bookingDate,
    tx.valueDate,
    tx.amountCents,
    tx.currency,
    tx.creditDebit,
    normalizeReference(tx.endToEndId),
    normalizeReference(tx.accountServicerReference),
    normalizeReference(tx.entryReference),
    normalizeReference(tx.bankTransactionCode),
    normalizeReference(tx.mandateId),
    normalizeReference(tx.counterpartyIban),
    normalizeReference(tx.remittanceInformation),
  ];
}

function extractBankTransactionCode(node: unknown): string | null {
  const domainCode = childText(node, ["BkTxCd", "Domn", "Cd"]);
  const familyCode = childText(node, ["BkTxCd", "Domn", "Fmly", "Cd"]);
  const subFamilyCode = childText(node, ["BkTxCd", "Domn", "Fmly", "SubFmlyCd"]);
  const parts = [domainCode, familyCode, subFamilyCode].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join("/") : null;
}

function extractRemittanceInformation(txDtls: unknown): string | null {
  const rmtInf = childOf(txDtls, ["RmtInf"]);
  const unstructured = toArray(childOf(rmtInf, ["Ustrd"]))
    .map((node) => textOf(node))
    .filter((text): text is string => text !== null);
  const structuredRef = childText(rmtInf, ["Strd", "CdtrRefInf", "Ref"]);
  const structuredAddtl = childText(rmtInf, ["Strd", "AddtlRmtInf"]);
  const parts = [structuredRef, structuredAddtl, ...unstructured].filter((part): part is string => part !== null && part.length > 0);
  return parts.length > 0 ? parts.join("; ") : null;
}

function extractCounterparty(
  rltdPties: unknown,
  creditDebit: CreditDebitIndicator,
): { name: string | null; iban: string | null } {
  // We are the account owner: on a credit (money in) the counterparty is the debtor who
  // paid us; on a debit (money out) it is the creditor we paid.
  const partyKey = creditDebit === "credit" ? "Dbtr" : "Cdtr";
  const accountKey = creditDebit === "credit" ? "DbtrAcct" : "CdtrAcct";
  // Digipost decisions/0064: from camt.053.001.04 onwards a related party
  // is a choice type, so the name sits one level deeper under `<Pty>`; up to .001.03 it sits
  // directly under the party element. Both shapes are read, newest first, because the whole
  // point of this parser is that a bank's own export works without anyone configuring a
  // version.
  const name = childText(rltdPties, [partyKey, "Pty", "Nm"]) ?? childText(rltdPties, [partyKey, "Nm"]);
  // The account is NOT part of that choice: `DbtrAcct`/`CdtrAcct` stay siblings of the party
  // element in every version.
  const iban = childText(rltdPties, [accountKey, "Id", "IBAN"]);
  return { name, iban };
}

function extractCounterpartyBic(rltdAgts: unknown, creditDebit: CreditDebitIndicator): string | null {
  const agentKey = creditDebit === "credit" ? "DbtrAgt" : "CdtrAgt";
  // `BIC` was renamed to `BICFI` in camt.053.001.04 (Digipost decisions/0064).
  return childText(rltdAgts, [agentKey, "FinInstnId", "BICFI"]) ?? childText(rltdAgts, [agentKey, "FinInstnId", "BIC"]);
}

function extractCreditorId(rltdPties: unknown): string | null {
  return childText(rltdPties, ["CdtrSchmeId", "Id", "PrvtId", "Othr", "Id"]);
}

function extractDate(node: unknown): string | null {
  // `<Dt><Dt>2026-08-01</Dt></Dt>` (date only) or `<Dt><DtTm>2026-08-01T10:00:00</DtTm></Dt>`
  // (date-time) - both map to a plain ISO date string, truncating any time-of-day part.
  const plainDate = childText(node, ["Dt"]);
  if (plainDate) return plainDate.slice(0, 10);
  const dateTime = childText(node, ["DtTm"]);
  if (dateTime) return dateTime.slice(0, 10);
  return null;
}

function parseBalance(balNode: unknown): Camt053Balance | null {
  const type = childText(balNode, ["Tp", "CdOrPrtry", "Cd"]);
  const amountNode = childOf(balNode, ["Amt"]);
  const currency = attrOf(amountNode, "Ccy");
  const date = extractDate(childOf(balNode, ["Dt"]));
  if (!type || !amountNode || !currency || !date) return null;
  const { amountCents } = signedAmountCents(amountNode, childText(balNode, ["CdtDbtInd"]));
  return { type, amountCents, currency, date };
}

function findBalanceByType(balances: Camt053Balance[], types: string[]): Camt053Balance | null {
  return balances.find((balance) => types.includes(balance.type)) ?? null;
}

/**
 * Builds one `NormalizedTransaction` from a single `TxDtls` node (a batch entry's own
 * transaction detail) or, when `txDtls` is `null`, from the parent `Ntry` node directly (a
 * non-batch entry with no `NtryDtls/TxDtls` breakdown at all).
 */
function buildTransaction(
  entry: unknown,
  txDtls: unknown,
  accountIban: string | null,
  fallbackCurrency: string | null,
  occurrenceCounter: OccurrenceCounter,
): NormalizedTransaction {
  const source = txDtls ?? entry;
  const entryCreditDebitIndicator = childText(entry, ["CdtDbtInd"]);
  const sourceCreditDebitIndicator = txDtls ? (childText(txDtls, ["CdtDbtInd"]) ?? entryCreditDebitIndicator) : entryCreditDebitIndicator;

  const amountNode = (txDtls ? childOf(txDtls, ["Amt"]) : null) ?? childOf(entry, ["Amt"]);
  const currency = attrOf(amountNode, "Ccy") ?? fallbackCurrency ?? "EUR";
  const { amountCents, creditDebit } = signedAmountCents(amountNode, sourceCreditDebitIndicator);

  const bookingDate = extractDate(childOf(entry, ["BookgDt"])) ?? "";
  const valueDate = extractDate(childOf(entry, ["ValDt"]));

  const refs = childOf(txDtls, ["Refs"]);
  const endToEndId = childText(refs, ["EndToEndId"]);
  const mandateId = childText(refs, ["MndtId"]);
  const accountServicerReference = childText(refs, ["AcctSvcrRef"]) ?? childText(entry, ["AcctSvcrRef"]);
  const entryReference = childText(entry, ["NtryRef"]);

  const rltdPties = childOf(txDtls, ["RltdPties"]);
  const rltdAgts = childOf(txDtls, ["RltdAgts"]);
  const counterparty = extractCounterparty(rltdPties, creditDebit);
  const counterpartyBic = extractCounterpartyBic(rltdAgts, creditDebit);
  const creditorId = extractCreditorId(rltdPties);
  const remittanceInformation = extractRemittanceInformation(txDtls);
  const bankTransactionCode = extractBankTransactionCode(source) ?? extractBankTransactionCode(entry);

  const idempotencyKeyFields = camt053IdempotencyKeyFields({
    accountIban,
    bookingDate,
    valueDate,
    amountCents,
    currency,
    creditDebit,
    endToEndId,
    accountServicerReference,
    entryReference,
    bankTransactionCode,
    mandateId,
    counterpartyIban: counterparty.iban,
    remittanceInformation,
  });
  const idempotencyKey = computeIdempotencyKeyV2(idempotencyKeyFields, occurrenceCounter.next(idempotencyKeyFields));

  return {
    idempotencyKey,
    accountIban,
    currency,
    bookingDate,
    valueDate,
    amountCents,
    creditDebit,
    counterpartyName: counterparty.name,
    counterpartyIban: counterparty.iban,
    counterpartyBic,
    remittanceInformation,
    endToEndId,
    mandateId,
    creditorId,
    bankTransactionCode,
    accountServicerReference,
    entryReference,
  };
}

function parseEntry(
  entry: unknown,
  accountIban: string | null,
  fallbackCurrency: string | null,
  occurrenceCounter: OccurrenceCounter,
): NormalizedTransaction[] {
  const txDtlsList = toArray(childOf(entry, ["NtryDtls", "TxDtls"]));
  if (txDtlsList.length > 0) {
    return txDtlsList.map((txDtls) => buildTransaction(entry, txDtls, accountIban, fallbackCurrency, occurrenceCounter));
  }
  return [buildTransaction(entry, null, accountIban, fallbackCurrency, occurrenceCounter)];
}

function parseStatement(stmtNode: unknown, occurrenceCounter: OccurrenceCounter): Camt053Statement {
  const statementId = childText(stmtNode, ["Id"]);
  const accountIban = childText(stmtNode, ["Acct", "Id", "IBAN"]);
  const currency = childText(stmtNode, ["Acct", "Ccy"]);

  const balances = toArray(childOf(stmtNode, ["Bal"]))
    .map(parseBalance)
    .filter((balance): balance is Camt053Balance => balance !== null);
  const openingBalance = findBalanceByType(balances, ["OPBD", "OPAV"]);
  const closingBalance = findBalanceByType(balances, ["CLBD", "CLAV"]);

  const entries = toArray(childOf(stmtNode, ["Ntry"]));
  const transactions = entries.flatMap((entry) => parseEntry(entry, accountIban, currency, occurrenceCounter));

  return { statementId, accountIban, currency, openingBalance, closingBalance, transactions };
}

/**
 * Parses a camt.053 XML document into normalized statements/transactions. Throws
 * `UnsafeXmlError` for a document declaring a DOCTYPE/custom entity (`assertSafeXml`), and a
 * plain `Error` when the root element does not declare a recognized camt.053 namespace -
 * callers are expected to have already called `detectCamt053` to decide this is worth
 * parsing at all.
 */
export function parseCamt053(xmlText: string): Camt053ParseResult {
  assertSafeXml(xmlText);
  const namespaceMatch = CAMT_053_NAMESPACE_PATTERN.exec(xmlText);
  if (!namespaceMatch) {
    throw new Camt053Error("Not a recognized camt.053 document (namespace not found)");
  }

  const parsed = createSafeXmlParser().parse(xmlText) as XmlObject;
  const document = parsed.Document;
  const bkToCstmrStmt = childOf(document, ["BkToCstmrStmt"]);
  // One `OccurrenceCounter` shared across every statement in this file: disambiguation of a
  // fully-identical composite (`idempotency-key.ts`) is only meaningful, and only
  // deterministic, within the boundary of one file - never shared across separate
  // `parseCamt053` calls.
  const occurrenceCounter = new OccurrenceCounter();
  const statements = toArray(childOf(bkToCstmrStmt, ["Stmt"])).map((stmtNode) => parseStatement(stmtNode, occurrenceCounter));

  return { version: namespaceMatch[1]!, statements };
}

/** Pure reconciliation check: closing balance equals opening balance plus the sum of every
 * transaction's signed amount. A data-quality signal, never a reason to refuse an
 * import. */
export function camt053StatementReconciles(statement: Camt053Statement): boolean {
  if (!statement.openingBalance || !statement.closingBalance) return false;
  const transactionsSum = statement.transactions.reduce((sum, tx) => sum + tx.amountCents, 0);
  return statement.openingBalance.amountCents + transactionsSum === statement.closingBalance.amountCents;
}
