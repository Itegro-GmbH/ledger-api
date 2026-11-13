// The `LedgerSourceReader` over this service's own source tables (`schema/sources.ts`): the same
// reads Digipost's ledger made of its documents, accounts, transactions, settlement lines,
// contacts, payment aliases and no-document rules (`listForLedger` and friends), with the same
// rows, order and pairing rules, and the same as the in-memory reader the tests use
// (`tests/support/memory-source-reader.ts`).
//
// Differences to Digipost, all by construction of the pushed documents:
// - a document's counterparty is its `contact_id` (the platform pushes the one its direction
//   implies) instead of a `document_contacts` link in that role, and `listDocumentContacts`
//   answers that one link;
// - a document's status is always `done` (a platform pushes a document once analysed) and its
//   payment status comes from its confirmed links (`documentPaymentStatus`);
// - issued invoices are not a source here yet: `listInvoices` answers nothing.
//
// Every query filters on the tenant, joined rows included. Read only.
import { LEDGER_BOOKABLE_DOCUMENT_KINDS } from "@ledger/core";
import { and, asc, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";

import type { DbExecutor } from "../foundation/db-types";
import { documentEffectiveDate } from "../repositories/drizzle/source-repository";
import { accounts, contacts, documents, documentTransactions, importBatches, paymentAliases, paymentNoDocumentRules, settlementLines, transactions } from "../schema/sources";
import { documentPaymentStatus, todayIso } from "./payment-status";
import type { LedgerSourceDocumentRow, LedgerSourceReader } from "./source-reader";

type PairedClearing = { accountId: string; platform: string | null; contactId: string | null; reportDocumentIds: string[] | null };

/** The counterparty of the current `documents` row, of the same tenant. */
const documentContact = sql<{ id: string; name: string; vatId: string | null; country: string | null } | null>`(
  select json_build_object('id', c.id, 'name', c.name, 'vatId', c.vat_id, 'country', c.country)
  from ${contacts} c
  where c.id = documents.contact_id and c.tenant_id = documents.tenant_id
)`;

/** The confirmed links of the current `documents` row, oldest movement first. */
const confirmedTransactions = sql<{ transactionId: string; allocatedAmountCents: number }[]>`coalesce((
  select json_agg(json_build_object('transactionId', t.id, 'allocatedAmountCents', dt.allocated_amount_cents) order by t.booking_date, t.id)
  from ${documentTransactions} dt
  join ${transactions} t on t.id = dt.transaction_id and t.tenant_id = dt.tenant_id
  where dt.document_id = documents.id and dt.tenant_id = documents.tenant_id and dt.status = 'confirmed'
), '[]'::json)`;

/** A bank movement's partner in its transfer group on a clearing account, with the report
 * documents whose payout line is that partner (Digipost's `listForLedger`). */
const pairedClearing = sql<PairedClearing | null>`(
  select json_build_object(
    'accountId', ca.id,
    'platform', ca.platform,
    'contactId', ca.contact_id,
    'reportDocumentIds', (
      select json_agg(distinct sl.source_document_id)
      from ${settlementLines} sl
      where sl.transaction_id = pt.id and sl.tenant_id = pt.tenant_id and sl.type = 'payout'
    )
  )
  from ${transactions} pt
  join ${accounts} ca on ca.id = pt.account_id and ca.tenant_id = pt.tenant_id
  where transactions.transfer_group_id is not null
    and pt.transfer_group_id = transactions.transfer_group_id
    and pt.tenant_id = transactions.tenant_id
    and pt.id <> transactions.id
    and ca.type = 'clearing'
  order by pt.created_at
  limit 1
)`;

export function createDrizzleSourceReader(db: DbExecutor): LedgerSourceReader {
  const bankTransactions = (tenantId: string) =>
    and(eq(transactions.tenantId, tenantId), eq(accounts.type, "bank"));
  const joinAccount = and(eq(accounts.id, transactions.accountId), eq(accounts.tenantId, transactions.tenantId));

  return {
    // -----------------------------------------------------------------------------------------
    // Documents
    // -----------------------------------------------------------------------------------------
    async listDocumentsForLedger(tenantId) {
      const rows = await db
        .select({
          id: documents.id,
          kind: documents.kind,
          direction: documents.direction,
          documentDate: documents.documentDate,
          effectiveDate: sql<string>`to_char(${documentEffectiveDate}, 'YYYY-MM-DD')`,
          title: documents.title,
          sender: documents.sender,
          summary: documents.summary,
          originalFileName: sql<string>`coalesce(${documents.originalFileName}, ${documents.title}, '')`,
          invoiceNumber: documents.invoiceNumber,
          totalAmountCents: documents.totalAmountCents,
          currency: documents.currency,
          platform: documents.platform,
          dueDate: documents.dueDate,
          taxBreakdown: documents.taxBreakdown,
          netTotalCents: documents.netTotalCents,
          taxTotalCents: documents.taxTotalCents,
          passThroughCents: documents.passThroughCents,
          reverseCharge: documents.reverseCharge,
          serviceDate: documents.serviceDate,
          servicePeriodFrom: documents.servicePeriodFrom,
          servicePeriodTo: documents.servicePeriodTo,
          contact: documentContact,
          confirmedTransactions,
        })
        .from(documents)
        .where(eq(documents.tenantId, tenantId))
        .orderBy(asc(documentEffectiveDate), asc(documents.id));

      const today = todayIso();
      return rows.map(({ contact, dueDate, ...row }): LedgerSourceDocumentRow => ({
        ...row,
        status: "done",
        paymentStatus: documentPaymentStatus(
          { totalAmountCents: row.totalAmountCents, dueDate },
          row.confirmedTransactions.reduce((sum, link) => sum + link.allocatedAmountCents, 0),
          today,
        ),
        contactId: contact?.id ?? null,
        contactName: contact?.name ?? null,
        contactVatId: contact?.vatId ?? null,
        contactCountry: contact?.country ?? null,
      }));
    },

    async documentExists(tenantId, documentId) {
      const [row] = await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), eq(documents.id, documentId)))
        .limit(1);
      return Boolean(row);
    },

    async listDocumentContacts(tenantId, documentId) {
      const rows = await db
        .select({ documentId: documents.id, contactId: contacts.id, direction: documents.direction, contactName: contacts.name })
        .from(documents)
        .innerJoin(contacts, and(eq(contacts.id, documents.contactId), eq(contacts.tenantId, documents.tenantId)))
        .where(and(eq(documents.tenantId, tenantId), eq(documents.id, documentId)));
      return rows.map((row) => ({ documentId: row.documentId, contactId: row.contactId, role: row.direction === "outgoing" ? "recipient" : "sender", contactName: row.contactName }));
    },

    async listBookableDocumentIds(tenantId, period) {
      const rows = await db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.tenantId, tenantId),
            inArray(documents.kind, [...LEDGER_BOOKABLE_DOCUMENT_KINDS]),
            sql`${documentEffectiveDate} between ${period.from}::date and ${period.to}::date`,
          ),
        )
        .orderBy(documentEffectiveDate, asc(documents.id));
      return rows.map((row) => row.id);
    },

    // -----------------------------------------------------------------------------------------
    // Money accounts and movements
    // -----------------------------------------------------------------------------------------
    listMoneyAccounts: (tenantId) =>
      db
        .select({ id: accounts.id, type: accounts.type, name: accounts.name, iban: accounts.iban, platform: accounts.platform, contactId: accounts.contactId })
        .from(accounts)
        .where(eq(accounts.tenantId, tenantId))
        .orderBy(asc(accounts.createdAt), asc(accounts.id)),

    listSourceAccounts: (tenantId) =>
      db
        .select({ id: accounts.id, name: accounts.name, type: accounts.type, platform: accounts.platform, contactId: accounts.contactId, contactName: contacts.name })
        .from(accounts)
        .leftJoin(contacts, and(eq(contacts.id, accounts.contactId), eq(contacts.tenantId, accounts.tenantId)))
        .where(eq(accounts.tenantId, tenantId))
        .orderBy(asc(accounts.createdAt), asc(accounts.id)),

    async listTransactionsForLedger(tenantId) {
      const rows = await db
        .select({
          id: transactions.id,
          accountId: transactions.accountId,
          bookingDate: transactions.bookingDate,
          amountCents: transactions.amountCents,
          currency: sql<string>`coalesce(${transactions.currency}, ${accounts.currency})`,
          counterpartyName: transactions.counterpartyName,
          counterpartyIban: transactions.counterpartyIban,
          remittanceText: transactions.remittanceText,
          noDocumentNeeded: transactions.noDocumentNeeded,
          pairedClearing,
        })
        .from(transactions)
        .innerJoin(accounts, joinAccount)
        .where(bankTransactions(tenantId))
        .orderBy(asc(transactions.bookingDate), asc(transactions.id));
      return rows.map((row) => ({
        ...row,
        pairedClearing: row.pairedClearing ? { ...row.pairedClearing, reportDocumentIds: row.pairedClearing.reportDocumentIds ?? [] } : null,
      }));
    },

    async findTransactionById(tenantId, transactionId) {
      const [row] = await db
        .select({ id: transactions.id, accountId: transactions.accountId, bookingDate: transactions.bookingDate, amountCents: transactions.amountCents, counterpartyName: transactions.counterpartyName })
        .from(transactions)
        .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, transactionId)))
        .limit(1);
      return row ?? null;
    },

    async transactionExists(tenantId, transactionId) {
      const [row] = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, transactionId)))
        .limit(1);
      return Boolean(row);
    },

    listBankMovements: (tenantId, to) =>
      db
        .select({ transactionId: transactions.id, accountId: transactions.accountId, bookingDate: transactions.bookingDate, amountCents: transactions.amountCents })
        .from(transactions)
        .innerJoin(accounts, joinAccount)
        .where(and(bankTransactions(tenantId), lte(transactions.bookingDate, to)))
        .orderBy(asc(transactions.bookingDate), asc(transactions.id)),

    async listBankOpeningBalances(tenantId) {
      const rows = await db
        .selectDistinctOn([importBatches.accountId], { accountId: importBatches.accountId, openingBalanceCents: importBatches.openingBalanceCents })
        .from(importBatches)
        .innerJoin(accounts, and(eq(accounts.id, importBatches.accountId), eq(accounts.tenantId, importBatches.tenantId)))
        .where(and(eq(importBatches.tenantId, tenantId), eq(accounts.type, "bank"), isNotNull(importBatches.openingBalanceCents), isNotNull(importBatches.statementFrom)))
        .orderBy(asc(importBatches.accountId), asc(importBatches.statementFrom));
      return new Map(rows.map((row) => [row.accountId, row.openingBalanceCents ?? 0]));
    },

    async listBankTransactionIds(tenantId, period) {
      const rows = await db
        .select({ id: transactions.id })
        .from(transactions)
        .innerJoin(accounts, joinAccount)
        .where(and(bankTransactions(tenantId), gte(transactions.bookingDate, period.from), lte(transactions.bookingDate, period.to)))
        .orderBy(asc(transactions.bookingDate), asc(transactions.id));
      return rows.map((row) => row.id);
    },

    listSettlementLinesForLedger: (tenantId) =>
      db
        .select({
          id: settlementLines.id,
          sourceDocumentId: settlementLines.sourceDocumentId,
          platform: accounts.platform,
          type: settlementLines.type,
          grossCents: settlementLines.grossCents,
          feeCents: settlementLines.feeCents,
          netCents: settlementLines.netCents,
          currency: settlementLines.currency,
          bookingDate: settlementLines.bookingDate,
        })
        .from(settlementLines)
        .innerJoin(accounts, and(eq(accounts.id, settlementLines.clearingAccountId), eq(accounts.tenantId, settlementLines.tenantId)))
        .where(eq(settlementLines.tenantId, tenantId))
        .orderBy(asc(settlementLines.sourceDocumentId), asc(settlementLines.bookingDate), asc(settlementLines.id)),

    // -----------------------------------------------------------------------------------------
    // Invoices the platform issued: not a source here yet.
    // -----------------------------------------------------------------------------------------
    listInvoices: async () => [],

    // -----------------------------------------------------------------------------------------
    // Counterparties
    // -----------------------------------------------------------------------------------------
    listContacts: (tenantId) => db.select({ id: contacts.id, name: contacts.name }).from(contacts).where(eq(contacts.tenantId, tenantId)).orderBy(asc(contacts.name), asc(contacts.id)),

    async findContactById(tenantId, contactId) {
      const [row] = await db
        .select({ id: contacts.id, name: contacts.name })
        .from(contacts)
        .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)))
        .limit(1);
      return row ?? null;
    },

    listPaymentAliases: (tenantId) =>
      db
        .select({ counterpartyNameNormalized: paymentAliases.counterpartyNameNormalized, contactId: paymentAliases.contactId })
        .from(paymentAliases)
        .where(eq(paymentAliases.tenantId, tenantId)),

    listNoDocumentRules: (tenantId) =>
      db.select({ counterpartyNameNormalized: paymentNoDocumentRules.counterpartyNameNormalized }).from(paymentNoDocumentRules).where(eq(paymentNoDocumentRules.tenantId, tenantId)),
  };
}
