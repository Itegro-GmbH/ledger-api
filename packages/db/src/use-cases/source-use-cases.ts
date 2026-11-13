// The sources' use cases (decisions/0001-ledger-api.md, "What the service owns, and what platforms
// send"): what a platform pushes (counterparties, money accounts, money movements, documents) and
// the decisions on them (which document a movement pays, which movements need no document, which
// payment name means which counterparty). A source is never booked here: `syncProposals` turns it
// into a proposal later.
//
// Rules ported from Digipost's contacts, accounts and payments use cases: a clearing account has
// exactly one owner (a platform or a counterparty), a bank account none; a pushed movement is never
// duplicated (idempotent by its external id per account) and a known one keeps its date and
// amount; a link never allocates more than the document's open amount or the movement's
// unallocated amount, and never pays an incoming invoice with money in. Batches are all or nothing.
// A camt.053 statement is parsed by the core (`parseCamt053`) and written like pushed movements.
import { camt053StatementReconciles, parseCamt053, type Camt053ParseResult, type Camt053Transaction, type ProposalTaxBreakdownEntry } from "@ledger/core";

import { UseCaseError } from "../errors";
import { dbErrorOf } from "../foundation/db-errors";
import type {
  ContactRow,
  ContactWrite,
  DocumentFilter,
  DocumentRow,
  DocumentTransactionRow,
  DocumentWithLinks,
  DocumentWrite,
  MoneyAccountRow,
  Page,
  Paging,
  Repositories,
  SettlementLineRow,
  SettlementLineWrite,
  TransactionFilter,
  TransactionRow,
  TransactionWithLinks,
  TransactionWrite,
  UnitOfWork,
} from "../repositories/contracts";
import type { ContactRelationType, ContactSource, DocumentDirection, DocumentKind } from "../schema/sources";
import { aliasKeyForCounterparty, normalizeName } from "../sources/contact-resolution";
import type { MoneyAccountType } from "../sources/source-reader";

export const SOURCE_ERROR = {
  counterpartyNotFound: "counterparty_not_found",
  counterpartyIdTaken: "counterparty_id_taken",
  vatIdTaken: "vat_id_taken",
  moneyAccountNotFound: "money_account_not_found",
  invalidOwner: "invalid_money_account_owner",
  ibanTaken: "iban_taken",
  clearingOwnerTaken: "clearing_owner_taken",
  movementNotFound: "movement_not_found",
  duplicateExternalId: "duplicate_external_id",
  documentNotFound: "document_not_found",
  documentIdTaken: "document_id_taken",
  duplicateDocumentId: "duplicate_document_id",
  externalRefTaken: "external_ref_taken",
  directionMismatch: "direction_mismatch",
  allocationExceedsDocument: "allocation_exceeds_document",
  allocationExceedsMovement: "allocation_exceeds_movement",
  linkNotFound: "link_not_found",
  statementInvalid: "statement_invalid",
  statementAccountMismatch: "statement_account_mismatch",
  statementTaken: "statement_taken",
} as const;
export type SourceErrorCode = (typeof SOURCE_ERROR)[keyof typeof SOURCE_ERROR];

/** Unique constraints a caller can run into, by name. */
const UNIQUE_ERRORS: Record<string, SourceErrorCode> = {
  contacts_tenant_vat_normalized_key: SOURCE_ERROR.vatIdTaken,
  accounts_tenant_iban_key: SOURCE_ERROR.ibanTaken,
  accounts_tenant_platform_clearing_key: SOURCE_ERROR.clearingOwnerTaken,
  accounts_tenant_contact_clearing_key: SOURCE_ERROR.clearingOwnerTaken,
  documents_tenant_external_ref_key: SOURCE_ERROR.externalRefTaken,
  transactions_account_idempotency_key: SOURCE_ERROR.duplicateExternalId,
};

export type CounterpartyInput = {
  /** Keeps an existing id (Digipost's contact ids); a new one is generated otherwise. */
  id?: string;
  name: string;
  legalForm?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
  vatId?: string | null;
  taxNumber?: string | null;
  registerCourt?: string | null;
  registerNumber?: string | null;
  leitwegId?: string | null;
  iban?: string | null;
  bic?: string | null;
  bankName?: string | null;
  accountHolder?: string | null;
  sepaCreditorId?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  contactPerson?: string | null;
  customerNumber?: string | null;
  supplierNumber?: string | null;
  paymentTermsDays?: number | null;
  relationType?: ContactRelationType | null;
  notes?: string | null;
  source?: ContactSource;
  /** `true` records that a person checked it (now, by the actor); `false` clears that. */
  verified?: boolean;
};

export type MoneyAccountInput = {
  type: MoneyAccountType;
  name: string;
  iban?: string | null;
  bic?: string | null;
  currency?: string;
  holder?: string | null;
  /** A clearing account's settlement platform (`stripe`, `apple`, ...). */
  platform?: string | null;
  /** A clearing account's supplier. */
  contactId?: string | null;
};

export type MoneyAccountPatchInput = { name?: string; iban?: string | null; bic?: string | null; currency?: string; holder?: string | null };

export type MovementInput = {
  /** The caller's id of the movement, unique per account (a Stripe balance transaction id, a bank
   * end-to-end id). Pushing it again changes nothing but its descriptive fields. */
  externalId: string;
  bookingDate: string;
  valueDate?: string | null;
  /** Signed cents, money in positive. */
  amountCents: number;
  currency?: string | null;
  counterpartyName?: string | null;
  counterpartyIban?: string | null;
  counterpartyBic?: string | null;
  remittanceText?: string | null;
  endToEndId?: string | null;
  mandateId?: string | null;
  creditorId?: string | null;
  bankTxCode?: string | null;
  bankReference?: string | null;
  /** Pairs a payout on a clearing account with its bank deposit (both carry the same id). */
  transferGroupId?: string | null;
  /** The platform's document the movement was read from (a statement). */
  sourceDocumentId?: string | null;
  raw?: unknown;
};

export type StatementInput = { from?: string | null; to?: string | null; openingBalanceCents?: number | null; closingBalanceCents?: number | null; sourceDocumentId?: string | null };

export type MovementUpsertResult = {
  created: number;
  existing: number;
  /** Known movements whose pushed date or amount differs from the stored one (never changed). */
  conflicts: { id: string; externalId: string }[];
  movements: { id: string; externalId: string; created: boolean }[];
  importBatchId: string | null;
};

export type StatementImportResult = {
  accountId: string;
  statementId: string | null;
  /** Opening balance plus the movements equals the closing balance. */
  reconciles: boolean;
  created: number;
  existing: number;
  conflicts: { id: string; externalId: string }[];
  importBatchId: string | null;
};

export type DocumentInput = {
  id: string;
  externalRef?: string | null;
  kind: DocumentKind;
  direction?: DocumentDirection | null;
  title?: string | null;
  sender?: string | null;
  summary?: string | null;
  originalFileName?: string | null;
  fileUrl?: string | null;
  invoiceNumber?: string | null;
  documentDate?: string | null;
  dueDate?: string | null;
  serviceDate?: string | null;
  servicePeriodFrom?: string | null;
  servicePeriodTo?: string | null;
  currency?: string | null;
  totalAmountCents?: number | null;
  netTotalCents?: number | null;
  taxTotalCents?: number | null;
  passThroughCents?: number | null;
  taxBreakdown?: ProposalTaxBreakdownEntry[] | null;
  reverseCharge?: boolean | null;
  platform?: string | null;
  contactId?: string | null;
};

export type LinkInput = {
  documentId: string;
  transactionId: string;
  /** Positive cents of the movement this document claims; default: as much as both have open. */
  allocatedAmountCents?: number;
  /** `user` (default) for a person's decision, `auto` for a platform's own deterministic pairing
   * (a Stripe charge to its invoice). */
  matchedBy?: "user" | "auto";
};

export interface SourceUseCases {
  upsertCounterparties(input: { tenantId: string; actor: string; counterparties: readonly CounterpartyInput[] }): Promise<{ row: ContactRow; created: boolean }[]>;
  listCounterparties(tenantId: string, filter: { search?: string }, paging: Paging): Promise<Page<ContactRow>>;

  createMoneyAccount(input: { tenantId: string; account: MoneyAccountInput }): Promise<MoneyAccountRow>;
  updateMoneyAccount(input: { tenantId: string; accountId: string; patch: MoneyAccountPatchInput }): Promise<MoneyAccountRow>;
  listMoneyAccounts(tenantId: string): Promise<(MoneyAccountRow & { movementCount: number; balanceCents: number })[]>;

  upsertMovements(input: { tenantId: string; accountId: string; movements: readonly MovementInput[]; statement?: StatementInput | null }): Promise<MovementUpsertResult>;
  /** Imports a camt.053 statement (every statement in the file): onto `accountId`, or onto the
   * bank account with the statement's IBAN. Idempotent like `upsertMovements`. */
  importBankStatement(input: { tenantId: string; accountId?: string; xml: string; sourceDocumentId?: string | null }): Promise<{ version: string; statements: StatementImportResult[] }>;
  listMovements(tenantId: string, filter: TransactionFilter, paging: Paging): Promise<Page<TransactionWithLinks>>;

  upsertDocuments(input: { tenantId: string; documents: readonly DocumentInput[] }): Promise<{ row: DocumentRow; created: boolean }[]>;
  listDocuments(tenantId: string, filter: DocumentFilter, paging: Paging): Promise<Page<DocumentWithLinks>>;

  linkMovementDocuments(input: { tenantId: string; actor: string; links: readonly LinkInput[] }): Promise<DocumentTransactionRow[]>;
  unlinkMovementDocument(input: { tenantId: string; documentId: string; transactionId: string }): Promise<void>;
  setNoDocumentNeeded(input: {
    tenantId: string;
    actor: string;
    transactionIds: readonly string[];
    noDocumentNeeded: boolean;
    forCounterparty?: boolean;
  }): Promise<{ updated: number; rule: string | null; alsoMarked: string[] }>;
  upsertPaymentAliases(input: { tenantId: string; actor: string; aliases: readonly { counterpartyName: string; contactId: string }[] }): Promise<{ counterpartyNameNormalized: string; contactId: string }[]>;
  /** A platform report's lines (revenue, fee, refund, payout, adjustment) on a clearing account,
   * idempotent by (report document, external line id); a line pushed again updates its amounts,
   * type and date, and keeps a movement link once set. */
  upsertSettlementLines(input: { tenantId: string; lines: readonly SettlementLineWrite[] }): Promise<SettlementLineRow[]>;
}

export type SourceUseCaseDeps = { repos: Repositories; uow: UnitOfWork; now?: () => Date };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The actor as a user id column holds it: only a uuid (a Digipost user id) is kept. */
function userIdOf(actor: string): string | null {
  return UUID.test(actor) ? actor : null;
}

/** Uppercase without whitespace: how IBANs and VAT ids are stored and compared. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/\s+/g, "");
}

const nullableCode = (raw: string | null | undefined) => (raw ? normalizeCode(raw) : (raw ?? null));

/** A parsed camt.053 movement as pushed: its v2 idempotency key (the same Digipost computes) is
 * the external id, so a statement imported in either place is never imported twice. */
function statementMovement(tx: Camt053Transaction): MovementInput {
  return {
    externalId: tx.idempotencyKey,
    bookingDate: tx.bookingDate,
    valueDate: tx.valueDate,
    amountCents: tx.amountCents,
    currency: tx.currency,
    counterpartyName: tx.counterpartyName,
    counterpartyIban: tx.counterpartyIban,
    counterpartyBic: tx.counterpartyBic,
    remittanceText: tx.remittanceInformation,
    endToEndId: tx.endToEndId,
    mandateId: tx.mandateId,
    creditorId: tx.creditorId,
    bankTxCode: tx.bankTransactionCode,
    bankReference: tx.accountServicerReference,
    raw: tx,
  };
}

export function createSourceUseCases(deps: SourceUseCaseDeps): SourceUseCases {
  const now = deps.now ?? (() => new Date());
  const sources = deps.repos.sources;

  /** Runs `work` in one transaction; a unique violation a caller can cause becomes its code. */
  async function transact<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    try {
      return await deps.uow.transaction(work);
    } catch (error) {
      const dbError = dbErrorOf(error);
      const code = dbError.kind === "unique" && dbError.constraint ? UNIQUE_ERRORS[dbError.constraint] : undefined;
      if (code) throw new UseCaseError(code);
      throw error;
    }
  }

  async function requireContacts(repos: Repositories, tenantId: string, ids: readonly (string | null | undefined)[]): Promise<Map<string, ContactRow>> {
    const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    const found = new Map((await repos.sources.findContacts(tenantId, wanted)).map((row) => [row.id, row]));
    if (wanted.some((id) => !found.has(id))) throw new UseCaseError(SOURCE_ERROR.counterpartyNotFound);
    return found;
  }

  async function requireAccount(repos: Repositories, tenantId: string, accountId: string): Promise<MoneyAccountRow> {
    const account = await repos.sources.findMoneyAccount(tenantId, accountId);
    if (!account) throw new UseCaseError(SOURCE_ERROR.moneyAccountNotFound);
    return account;
  }

  function contactColumns(input: CounterpartyInput, actor: string): Partial<ContactWrite> {
    const { verified, id: _id, ...fields } = input;
    const patch: Partial<ContactWrite> = { ...fields };
    for (const key of Object.keys(patch) as (keyof ContactWrite)[]) if (patch[key] === undefined) delete patch[key];
    if (input.name !== undefined) patch.nameNormalized = normalizeName(input.name);
    if (input.vatId !== undefined) patch.vatIdNormalized = nullableCode(input.vatId);
    if (input.iban !== undefined) patch.ibanNormalized = nullableCode(input.iban);
    if (verified === true) Object.assign(patch, { verifiedAt: now(), verifiedByUserId: userIdOf(actor) });
    if (verified === false) Object.assign(patch, { verifiedAt: null, verifiedByUserId: null });
    return patch;
  }

  function movementRow(movement: MovementInput): TransactionWrite {
    return {
      idempotencyKey: movement.externalId,
      bookingDate: movement.bookingDate,
      valueDate: movement.valueDate ?? null,
      amountCents: movement.amountCents,
      currency: movement.currency ?? null,
      creditDebit: movement.amountCents < 0 ? "debit" : "credit",
      counterpartyName: movement.counterpartyName ?? null,
      counterpartyIban: nullableCode(movement.counterpartyIban),
      counterpartyBic: movement.counterpartyBic ?? null,
      remittanceText: movement.remittanceText ?? null,
      endToEndId: movement.endToEndId ?? null,
      mandateId: movement.mandateId ?? null,
      creditorId: movement.creditorId ?? null,
      bankTxCode: movement.bankTxCode ?? null,
      bankReference: movement.bankReference ?? null,
      transferGroupId: movement.transferGroupId ?? null,
      sourceDocumentId: movement.sourceDocumentId ?? null,
      raw: movement.raw ?? movement,
      importBatchId: null,
    };
  }

  function documentRow(input: DocumentInput): DocumentWrite {
    return {
      id: input.id,
      externalRef: input.externalRef ?? null,
      kind: input.kind,
      direction: input.direction ?? null,
      title: input.title ?? null,
      sender: input.sender ?? null,
      summary: input.summary ?? null,
      originalFileName: input.originalFileName ?? null,
      fileUrl: input.fileUrl ?? null,
      invoiceNumber: input.invoiceNumber ?? null,
      documentDate: input.documentDate ?? null,
      dueDate: input.dueDate ?? null,
      serviceDate: input.serviceDate ?? null,
      servicePeriodFrom: input.servicePeriodFrom ?? null,
      servicePeriodTo: input.servicePeriodTo ?? null,
      currency: input.currency ?? null,
      totalAmountCents: input.totalAmountCents ?? null,
      netTotalCents: input.netTotalCents ?? null,
      taxTotalCents: input.taxTotalCents ?? null,
      passThroughCents: input.passThroughCents ?? null,
      taxBreakdown: input.taxBreakdown ?? null,
      reverseCharge: input.reverseCharge ?? null,
      platform: input.platform ?? null,
      contactId: input.contactId ?? null,
    };
  }

  /** Whether money in this direction can pay the document (Digipost's `directionMatches`): an
   * incoming invoice is paid with money out, an outgoing one with money in, a credit note (negative
   * total) the other way round. Unknown direction or total: anything goes. */
  function directionFits(doc: DocumentRow, tx: TransactionRow): boolean {
    if (doc.direction !== "incoming" && doc.direction !== "outgoing") return true;
    if (!doc.totalAmountCents) return true;
    const moneyIn = tx.amountCents > 0;
    const wantsMoneyIn = (doc.direction === "outgoing") === doc.totalAmountCents > 0;
    return moneyIn === wantsMoneyIn;
  }

  /** Writes movements onto an account already checked to be the tenant's, and records the
   * statement they came with, if any. */
  async function writeMovements(repos: Repositories, tenantId: string, accountId: string, movements: readonly MovementInput[], statement: StatementInput | null): Promise<MovementUpsertResult> {
    const written = await repos.sources.upsertTransactions(tenantId, accountId, movements.map(movementRow));
    const conflicts = written
      .map(({ row }, index) => ({ row, input: movements[index]! }))
      .filter(({ row, input }) => row.amountCents !== input.amountCents || row.bookingDate !== input.bookingDate)
      .map(({ row }) => ({ id: row.id, externalId: row.idempotencyKey }));
    const created = written.filter((item) => item.created);

    let importBatchId: string | null = null;
    if (statement) {
      const opening = statement.openingBalanceCents ?? null;
      const closing = statement.closingBalanceCents ?? null;
      const sum = movements.reduce((total, movement) => total + movement.amountCents, 0);
      const batch = await repos.sources.upsertImportBatch(tenantId, {
        accountId,
        sourceDocumentId: statement.sourceDocumentId ?? null,
        statementFrom: statement.from ?? null,
        statementTo: statement.to ?? null,
        openingBalanceCents: opening,
        closingBalanceCents: closing,
        rowsTotal: movements.length,
        rowsImported: created.length,
        rowsDuplicate: movements.length - created.length,
        balanceMismatch: opening !== null && closing !== null && opening + sum !== closing,
      });
      if (!batch) throw new UseCaseError(SOURCE_ERROR.statementTaken);
      await repos.sources.setImportBatch(
        tenantId,
        created.map((item) => item.row.id),
        batch.id,
      );
      importBatchId = batch.id;
    }

    return {
      created: created.length,
      existing: written.length - created.length,
      conflicts,
      movements: written.map(({ row, created: isNew }) => ({ id: row.id, externalId: row.idempotencyKey, created: isNew })),
      importBatchId,
    };
  }

  return {
    // -----------------------------------------------------------------------------------------
    // Counterparties
    // -----------------------------------------------------------------------------------------
    upsertCounterparties({ tenantId, actor, counterparties }) {
      return transact(async (repos) => {
        const results: { row: ContactRow; created: boolean }[] = [];
        for (const input of counterparties) {
          const patch = contactColumns(input, actor);
          const insert = { ...patch, id: input.id, name: input.name, nameNormalized: normalizeName(input.name), source: input.source ?? "auto" } as ContactWrite;
          const written = await repos.sources.upsertContact(tenantId, insert, patch);
          if (!written) throw new UseCaseError(SOURCE_ERROR.counterpartyIdTaken);
          results.push(written);
        }
        return results;
      });
    },

    listCounterparties: (tenantId, filter, paging) => sources.listContacts(tenantId, filter, paging),

    // -----------------------------------------------------------------------------------------
    // Money accounts
    // -----------------------------------------------------------------------------------------
    async createMoneyAccount({ tenantId, account }) {
      const platform = account.platform ?? null;
      const contactId = account.contactId ?? null;
      if (account.type === "bank" && (platform || contactId)) throw new UseCaseError(SOURCE_ERROR.invalidOwner);
      if (account.type === "clearing" && Boolean(platform) === Boolean(contactId)) throw new UseCaseError(SOURCE_ERROR.invalidOwner);
      return transact(async (repos) => {
        await requireContacts(repos, tenantId, [contactId]);
        return repos.sources.insertMoneyAccount(tenantId, {
          type: account.type,
          name: account.name,
          iban: nullableCode(account.iban),
          bic: account.bic ?? null,
          currency: account.currency ?? "EUR",
          holder: account.holder ?? null,
          platform,
          contactId,
        });
      });
    },

    updateMoneyAccount({ tenantId, accountId, patch }) {
      return transact(async (repos) => {
        const updated = await repos.sources.updateMoneyAccount(tenantId, accountId, { ...patch, ...(patch.iban !== undefined ? { iban: nullableCode(patch.iban) } : {}) });
        if (!updated) throw new UseCaseError(SOURCE_ERROR.moneyAccountNotFound);
        return updated;
      });
    },

    listMoneyAccounts: (tenantId) => sources.listMoneyAccounts(tenantId),

    // -----------------------------------------------------------------------------------------
    // Movements
    // -----------------------------------------------------------------------------------------
    async upsertMovements({ tenantId, accountId, movements, statement }) {
      if (new Set(movements.map((movement) => movement.externalId)).size !== movements.length) throw new UseCaseError(SOURCE_ERROR.duplicateExternalId);
      return transact(async (repos) => {
        await requireAccount(repos, tenantId, accountId);
        return writeMovements(repos, tenantId, accountId, movements, statement ?? null);
      });
    },

    async importBankStatement({ tenantId, accountId, xml, sourceDocumentId }) {
      let parsed: Camt053ParseResult;
      try {
        parsed = parseCamt053(xml);
      } catch {
        // Unsafe XML, not camt.053, or not well-formed: never a server error.
        throw new UseCaseError(SOURCE_ERROR.statementInvalid);
      }
      if (parsed.statements.length === 0) throw new UseCaseError(SOURCE_ERROR.statementInvalid);
      return transact(async (repos) => {
        const statements: StatementImportResult[] = [];
        for (const statement of parsed.statements) {
          const iban = statement.accountIban ? normalizeCode(statement.accountIban) : null;
          let account: MoneyAccountRow | null;
          if (accountId) {
            account = await requireAccount(repos, tenantId, accountId);
            if (iban && account.iban && account.iban !== iban) throw new UseCaseError(SOURCE_ERROR.statementAccountMismatch);
          } else {
            account = iban ? await repos.sources.findMoneyAccountByIban(tenantId, iban) : null;
            if (!account) throw new UseCaseError(SOURCE_ERROR.moneyAccountNotFound);
          }
          const dates = statement.transactions.map((tx) => tx.bookingDate).sort();
          const result = await writeMovements(repos, tenantId, account.id, statement.transactions.map(statementMovement), {
            from: statement.openingBalance?.date ?? dates[0] ?? null,
            to: statement.closingBalance?.date ?? dates.at(-1) ?? null,
            openingBalanceCents: statement.openingBalance?.amountCents ?? null,
            closingBalanceCents: statement.closingBalance?.amountCents ?? null,
            // One batch per source document: only a file with a single statement keeps it.
            sourceDocumentId: parsed.statements.length === 1 ? (sourceDocumentId ?? null) : null,
          });
          statements.push({
            accountId: account.id,
            statementId: statement.statementId,
            reconciles: camt053StatementReconciles(statement),
            created: result.created,
            existing: result.existing,
            conflicts: result.conflicts,
            importBatchId: result.importBatchId,
          });
        }
        return { version: parsed.version, statements };
      });
    },

    listMovements: (tenantId, filter, paging) => sources.listTransactions(tenantId, filter, paging),

    // -----------------------------------------------------------------------------------------
    // Documents
    // -----------------------------------------------------------------------------------------
    async upsertDocuments({ tenantId, documents }) {
      if (new Set(documents.map((doc) => doc.id)).size !== documents.length) throw new UseCaseError(SOURCE_ERROR.duplicateDocumentId);
      return transact(async (repos) => {
        await requireContacts(
          repos,
          tenantId,
          documents.map((doc) => doc.contactId),
        );
        const results: { row: DocumentRow; created: boolean }[] = [];
        for (const doc of documents) {
          const written = await repos.sources.upsertDocument(tenantId, documentRow(doc));
          if (!written) throw new UseCaseError(SOURCE_ERROR.documentIdTaken);
          results.push(written);
        }
        return results;
      });
    },

    listDocuments: (tenantId, filter, paging) => sources.listDocuments(tenantId, filter, paging),

    // -----------------------------------------------------------------------------------------
    // Links and decisions
    // -----------------------------------------------------------------------------------------
    linkMovementDocuments({ tenantId, actor, links }) {
      return transact(async (repos) => {
        const rows: DocumentTransactionRow[] = [];
        for (const link of links) {
          const [[doc], [tx]] = await Promise.all([repos.sources.findDocuments(tenantId, [link.documentId]), repos.sources.findTransactions(tenantId, [link.transactionId])]);
          if (!doc) throw new UseCaseError(SOURCE_ERROR.documentNotFound);
          if (!tx) throw new UseCaseError(SOURCE_ERROR.movementNotFound);
          if (!directionFits(doc, tx)) throw new UseCaseError(SOURCE_ERROR.directionMismatch);

          // What the others already claim; this pair's own row is replaced, so it does not count.
          const [byDocument, byTransaction] = await Promise.all([repos.sources.sumConfirmedByDocument(tenantId, [doc.id]), repos.sources.sumConfirmedByTransaction(tenantId, [tx.id])]);
          const ownAllocation = (await repos.sources.findConfirmedLink(tenantId, doc.id, tx.id))?.allocatedAmountCents ?? 0;
          const movementOpen = Math.abs(tx.amountCents) - ((byTransaction.get(tx.id) ?? 0) - ownAllocation);
          const documentOpen = doc.totalAmountCents === null ? null : Math.abs(doc.totalAmountCents) - ((byDocument.get(doc.id) ?? 0) - ownAllocation);

          const allocated = link.allocatedAmountCents ?? Math.min(movementOpen, documentOpen ?? movementOpen);
          if (allocated <= 0 || allocated > movementOpen) throw new UseCaseError(SOURCE_ERROR.allocationExceedsMovement);
          if (documentOpen !== null && allocated > documentOpen) throw new UseCaseError(SOURCE_ERROR.allocationExceedsDocument);

          const row = await repos.sources.confirmLink(tenantId, {
            documentId: doc.id,
            transactionId: tx.id,
            allocatedAmountCents: allocated,
            matchedBy: link.matchedBy ?? "user",
            decidedByUserId: userIdOf(actor),
          });
          if (!row) throw new UseCaseError(SOURCE_ERROR.documentIdTaken);
          rows.push(row);
        }
        return rows;
      });
    },

    async unlinkMovementDocument({ tenantId, documentId, transactionId }) {
      if (!(await sources.deleteConfirmedLink(tenantId, documentId, transactionId))) throw new UseCaseError(SOURCE_ERROR.linkNotFound);
    },

    setNoDocumentNeeded({ tenantId, actor, transactionIds, noDocumentNeeded, forCounterparty }) {
      return transact(async (repos) => {
        const found = await repos.sources.findTransactions(tenantId, transactionIds);
        if (found.length !== new Set(transactionIds).size) throw new UseCaseError(SOURCE_ERROR.movementNotFound);
        const updated = await repos.sources.setNoDocumentNeeded(tenantId, transactionIds, noDocumentNeeded);
        if (!forCounterparty || !noDocumentNeeded) return { updated, rule: null, alsoMarked: [] };

        // Digipost's "für diese Gegenpartei immer": a standing rule for the first movement's
        // counterparty, applied right away to every unexplained movement of that name.
        const name = transactionIds.map((id) => found.find((tx) => tx.id === id)?.counterpartyName).find(Boolean);
        if (!name) return { updated, rule: null, alsoMarked: [] };
        const normalized = normalizeName(name);
        await repos.sources.upsertNoDocumentRule(tenantId, { counterpartyNameNormalized: normalized, createdByUserId: userIdOf(actor) });
        const matching = (await repos.sources.listUnexplainedTransactionNames(tenantId)).filter((tx) => normalizeName(tx.counterpartyName) === normalized).map((tx) => tx.id);
        await repos.sources.setNoDocumentNeeded(tenantId, matching, true);
        return { updated, rule: normalized, alsoMarked: matching };
      });
    },

    upsertSettlementLines({ tenantId, lines }) {
      return transact(async (repos) => {
        for (const accountId of new Set(lines.map((line) => line.clearingAccountId))) {
          const account = await requireAccount(repos, tenantId, accountId);
          if (account.type !== "clearing") throw new UseCaseError(SOURCE_ERROR.invalidOwner);
        }
        const movementIds = [...new Set(lines.map((line) => line.transactionId).filter((id): id is string => Boolean(id)))];
        if (movementIds.length && (await repos.sources.findTransactions(tenantId, movementIds)).length !== movementIds.length) throw new UseCaseError(SOURCE_ERROR.movementNotFound);
        return repos.sources.upsertSettlementLines(tenantId, lines);
      });
    },

    upsertPaymentAliases({ tenantId, actor, aliases }) {
      return transact(async (repos) => {
        await requireContacts(
          repos,
          tenantId,
          aliases.map((alias) => alias.contactId),
        );
        const written: { counterpartyNameNormalized: string; contactId: string }[] = [];
        for (const alias of aliases) {
          const key = aliasKeyForCounterparty(alias.counterpartyName);
          await repos.sources.upsertPaymentAlias(tenantId, { counterpartyNameNormalized: key, contactId: alias.contactId, learnedFromUserId: userIdOf(actor) });
          written.push({ counterpartyNameNormalized: key, contactId: alias.contactId });
        }
        return written;
      });
    },
  };
}
