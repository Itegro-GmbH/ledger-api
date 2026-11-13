// The sources' repository (decisions/0001-ledger-api.md). Encapsulates access only, no business
// rules. Every method filters on `tenantId` explicitly; an upsert whose key is held by another
// tenant's row changes nothing (`setWhere` on the tenant) and answers `null`.
import { and, asc, count, desc, eq, getTableColumns, gte, ilike, inArray, isNotNull, lte, or, sql, type SQL } from "drizzle-orm";

import type { DbExecutor } from "../../foundation/db-types";
import { accounts, contacts, documents, documentTransactions, importBatches, paymentAliases, paymentNoDocumentRules, settlementLines, transactions } from "../../schema/sources";
import { documentPaymentStatus, todayIso } from "../../sources/payment-status";
import type { SourceRepository } from "../contracts/source-repository";

function first<T>(rows: T[], table: string): T {
  const [row] = rows;
  if (!row) throw new Error(`insert into ${table} returned no row`);
  return row;
}

// Correlated subqueries name the outer table by its bare name (`transactions.id`), not through a
// Drizzle column: a single-table select renders its columns unqualified, and an unqualified `id`
// inside a subquery would bind to the subquery's own table.

/** In an `INSERT ... RETURNING`: whether the row was inserted rather than updated on conflict. */
const inserted = sql<boolean>`(xmax = 0)`;

/** Escapes `%`, `_` and `\` for an `ilike` pattern. */
function containing(search: string): string {
  return `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** The confirmed links of the current `transactions` row, as `[{ documentId, allocatedAmountCents }]`. */
const transactionLinks = sql<{ documentId: string; allocatedAmountCents: number }[]>`coalesce((
  select json_agg(json_build_object('documentId', dt.document_id, 'allocatedAmountCents', dt.allocated_amount_cents) order by dt.created_at, dt.document_id)
  from ${documentTransactions} dt
  where dt.transaction_id = transactions.id and dt.tenant_id = transactions.tenant_id and dt.status = 'confirmed'
), '[]'::json)`;

/** The confirmed links of the current `documents` row, oldest movement first. */
const documentLinks = sql<{ transactionId: string; allocatedAmountCents: number }[]>`coalesce((
  select json_agg(json_build_object('transactionId', dt.transaction_id, 'allocatedAmountCents', dt.allocated_amount_cents) order by t.booking_date, t.id)
  from ${documentTransactions} dt
  join ${transactions} t on t.id = dt.transaction_id
  where dt.document_id = documents.id and dt.tenant_id = documents.tenant_id and dt.status = 'confirmed'
), '[]'::json)`;

/** A document's effective date: its own, else the day it was pushed. */
export const documentEffectiveDate = sql<string>`coalesce(${documents.documentDate}, ${documents.createdAt}::date)`;

export function createDrizzleSourceRepository(db: DbExecutor): SourceRepository {
  return {
    // -----------------------------------------------------------------------------------------
    // Counterparties
    // -----------------------------------------------------------------------------------------
    async upsertContact(tenantId, contact, patch) {
      const { id: _id, ...columns } = patch;
      const [row] = await db
        .insert(contacts)
        .values({ ...contact, tenantId })
        .onConflictDoUpdate({ target: contacts.id, set: { ...columns, updatedAt: new Date() }, setWhere: eq(contacts.tenantId, tenantId) })
        .returning({ ...getTableColumns(contacts), created: inserted });
      if (!row) return null;
      const { created, ...rest } = row;
      return { row: rest, created };
    },

    async listContacts(tenantId, filter, paging) {
      const where = and(eq(contacts.tenantId, tenantId), filter.search ? ilike(contacts.name, containing(filter.search)) : undefined);
      const [items, [total]] = await Promise.all([
        db.select().from(contacts).where(where).orderBy(asc(contacts.name), asc(contacts.id)).offset(paging.offset).limit(paging.limit),
        db.select({ value: count() }).from(contacts).where(where),
      ]);
      return { items, total: total?.value ?? 0 };
    },

    async findContacts(tenantId, ids) {
      if (ids.length === 0) return [];
      return db
        .select()
        .from(contacts)
        .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, [...ids])));
    },

    // -----------------------------------------------------------------------------------------
    // Money accounts
    // -----------------------------------------------------------------------------------------
    async insertMoneyAccount(tenantId, account) {
      return first(
        await db
          .insert(accounts)
          .values({ ...account, tenantId })
          .returning(),
        "accounts",
      );
    },

    async updateMoneyAccount(tenantId, id, patch) {
      const [row] = await db
        .update(accounts)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, id)))
        .returning();
      return row ?? null;
    },

    async findMoneyAccount(tenantId, id) {
      const [row] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, id)))
        .limit(1);
      return row ?? null;
    },

    listMoneyAccounts: (tenantId) =>
      db
        .select({
          ...getTableColumns(accounts),
          movementCount: sql<number>`(select count(*)::int from ${transactions} t where t.account_id = accounts.id and t.tenant_id = accounts.tenant_id)`,
          balanceCents: sql<number>`(select coalesce(sum(t.amount_cents), 0)::int from ${transactions} t where t.account_id = accounts.id and t.tenant_id = accounts.tenant_id)`,
        })
        .from(accounts)
        .where(eq(accounts.tenantId, tenantId))
        .orderBy(asc(accounts.createdAt), asc(accounts.id)),

    // -----------------------------------------------------------------------------------------
    // Movements
    // -----------------------------------------------------------------------------------------
    async upsertTransactions(tenantId, accountId, rows) {
      if (rows.length === 0) return [];
      const refreshed = (column: string) => sql.raw(`excluded.${column}`);
      const written = await db
        .insert(transactions)
        .values(rows.map((row) => ({ ...row, tenantId, accountId })))
        .onConflictDoUpdate({
          target: [transactions.accountId, transactions.idempotencyKey],
          set: {
            valueDate: refreshed("value_date"),
            counterpartyName: refreshed("counterparty_name"),
            counterpartyIban: refreshed("counterparty_iban"),
            counterpartyBic: refreshed("counterparty_bic"),
            remittanceText: refreshed("remittance_text"),
            endToEndId: refreshed("end_to_end_id"),
            mandateId: refreshed("mandate_id"),
            creditorId: refreshed("creditor_id"),
            bankTxCode: refreshed("bank_tx_code"),
            bankReference: refreshed("bank_reference"),
            raw: refreshed("raw"),
            transferGroupId: sql`coalesce(excluded.transfer_group_id, transactions.transfer_group_id)`,
            sourceDocumentId: sql`coalesce(excluded.source_document_id, transactions.source_document_id)`,
          },
          setWhere: eq(transactions.tenantId, tenantId),
        })
        .returning({ ...getTableColumns(transactions), created: inserted });
      const byKey = new Map(written.map(({ created, ...row }) => [row.idempotencyKey, { row, created }]));
      return rows.map((row) => {
        const found = byKey.get(row.idempotencyKey);
        if (!found) throw new Error(`upsert into transactions returned no row for ${row.idempotencyKey}`);
        return found;
      });
    },

    async upsertImportBatch(tenantId, batch) {
      const { accountId: _accountId, sourceDocumentId: _sourceDocumentId, ...figures } = batch;
      const [row] = await db
        .insert(importBatches)
        .values({ ...batch, tenantId })
        .onConflictDoUpdate({ target: importBatches.sourceDocumentId, set: figures, setWhere: and(eq(importBatches.tenantId, tenantId), eq(importBatches.accountId, batch.accountId)) })
        .returning();
      return row ?? null;
    },

    async findMoneyAccountByIban(tenantId, iban) {
      const [row] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.tenantId, tenantId), eq(accounts.iban, iban)))
        .limit(1);
      return row ?? null;
    },

    async setImportBatch(tenantId, transactionIds, importBatchId) {
      if (transactionIds.length === 0) return;
      await db
        .update(transactions)
        .set({ importBatchId })
        .where(and(eq(transactions.tenantId, tenantId), inArray(transactions.id, [...transactionIds])));
    },

    async listTransactions(tenantId, filter, paging) {
      const conditions: (SQL | undefined)[] = [
        eq(transactions.tenantId, tenantId),
        filter.accountId ? eq(transactions.accountId, filter.accountId) : undefined,
        filter.from ? gte(transactions.bookingDate, filter.from) : undefined,
        filter.to ? lte(transactions.bookingDate, filter.to) : undefined,
        filter.search ? or(ilike(transactions.counterpartyName, containing(filter.search)), ilike(transactions.remittanceText, containing(filter.search))) : undefined,
        filter.unlinked
          ? sql`${transactions.noDocumentNeeded} = false and not exists (select 1 from ${documentTransactions} dt where dt.transaction_id = transactions.id and dt.tenant_id = transactions.tenant_id and dt.status = 'confirmed')`
          : undefined,
      ];
      const where = and(...conditions);
      const [items, [total]] = await Promise.all([
        db
          .select({ ...getTableColumns(transactions), links: transactionLinks })
          .from(transactions)
          .where(where)
          .orderBy(desc(transactions.bookingDate), desc(transactions.createdAt), desc(transactions.id))
          .offset(paging.offset)
          .limit(paging.limit),
        db.select({ value: count() }).from(transactions).where(where),
      ]);
      return { items, total: total?.value ?? 0 };
    },

    async findTransactions(tenantId, ids) {
      if (ids.length === 0) return [];
      return db
        .select()
        .from(transactions)
        .where(and(eq(transactions.tenantId, tenantId), inArray(transactions.id, [...ids])));
    },

    async setNoDocumentNeeded(tenantId, ids, value) {
      if (ids.length === 0) return 0;
      const rows = await db
        .update(transactions)
        .set({ noDocumentNeeded: value })
        .where(and(eq(transactions.tenantId, tenantId), inArray(transactions.id, [...ids]), sql`${transactions.noDocumentNeeded} <> ${value}`))
        .returning({ id: transactions.id });
      return rows.length;
    },

    async listUnexplainedTransactionNames(tenantId) {
      const rows = await db
        .select({ id: transactions.id, counterpartyName: transactions.counterpartyName })
        .from(transactions)
        .where(
          and(
            eq(transactions.tenantId, tenantId),
            eq(transactions.noDocumentNeeded, false),
            isNotNull(transactions.counterpartyName),
            sql`not exists (select 1 from ${documentTransactions} dt where dt.transaction_id = transactions.id and dt.tenant_id = transactions.tenant_id and dt.status = 'confirmed')`,
          ),
        );
      return rows.map((row) => ({ id: row.id, counterpartyName: row.counterpartyName ?? "" }));
    },

    async upsertSettlementLines(tenantId, lines) {
      if (lines.length === 0) return [];
      const refreshed = (column: string) => sql.raw(`excluded.${column}`);
      return db
        .insert(settlementLines)
        .values(lines.map((line) => ({ ...line, tenantId })))
        .onConflictDoUpdate({
          target: [settlementLines.sourceDocumentId, settlementLines.externalLineId],
          set: {
            transactionId: sql`coalesce(excluded.transaction_id, settlement_lines.transaction_id)`,
            // A re-read report may classify a line differently (Google's fee refunds).
            type: refreshed("type"),
            grossCents: refreshed("gross_cents"),
            feeCents: refreshed("fee_cents"),
            netCents: refreshed("net_cents"),
            currency: refreshed("currency"),
            bookingDate: refreshed("booking_date"),
          },
          setWhere: eq(settlementLines.tenantId, tenantId),
        })
        .returning();
    },

    // -----------------------------------------------------------------------------------------
    // Movement to document links
    // -----------------------------------------------------------------------------------------
    async confirmLink(tenantId, link) {
      const decidedAt = new Date();
      const kind = link.matchedBy === "user" ? "manual" : "exact";
      const [row] = await db
        .insert(documentTransactions)
        .values({ tenantId, ...link, status: "confirmed", kind, confidence: 1, reasons: [], decidedAt })
        .onConflictDoUpdate({
          target: [documentTransactions.documentId, documentTransactions.transactionId],
          set: { status: "confirmed", allocatedAmountCents: link.allocatedAmountCents, matchedBy: link.matchedBy, decidedAt, decidedByUserId: link.decidedByUserId },
          setWhere: eq(documentTransactions.tenantId, tenantId),
        })
        .returning();
      return row ?? null;
    },

    async findConfirmedLink(tenantId, documentId, transactionId) {
      const [row] = await db
        .select()
        .from(documentTransactions)
        .where(
          and(
            eq(documentTransactions.tenantId, tenantId),
            eq(documentTransactions.documentId, documentId),
            eq(documentTransactions.transactionId, transactionId),
            eq(documentTransactions.status, "confirmed"),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async deleteConfirmedLink(tenantId, documentId, transactionId) {
      const rows = await db
        .delete(documentTransactions)
        .where(
          and(
            eq(documentTransactions.tenantId, tenantId),
            eq(documentTransactions.documentId, documentId),
            eq(documentTransactions.transactionId, transactionId),
            eq(documentTransactions.status, "confirmed"),
          ),
        )
        .returning({ id: documentTransactions.id });
      return rows.length > 0;
    },

    async sumConfirmedByDocument(tenantId, documentIds) {
      if (documentIds.length === 0) return new Map();
      const rows = await db
        .select({ id: documentTransactions.documentId, sum: sql<number>`sum(${documentTransactions.allocatedAmountCents})::int` })
        .from(documentTransactions)
        .where(and(eq(documentTransactions.tenantId, tenantId), eq(documentTransactions.status, "confirmed"), inArray(documentTransactions.documentId, [...documentIds])))
        .groupBy(documentTransactions.documentId);
      return new Map(rows.map((row) => [row.id, row.sum]));
    },

    async sumConfirmedByTransaction(tenantId, transactionIds) {
      if (transactionIds.length === 0) return new Map();
      const rows = await db
        .select({ id: documentTransactions.transactionId, sum: sql<number>`sum(${documentTransactions.allocatedAmountCents})::int` })
        .from(documentTransactions)
        .where(and(eq(documentTransactions.tenantId, tenantId), eq(documentTransactions.status, "confirmed"), inArray(documentTransactions.transactionId, [...transactionIds])))
        .groupBy(documentTransactions.transactionId);
      return new Map(rows.map((row) => [row.id, row.sum]));
    },

    // -----------------------------------------------------------------------------------------
    // Payment names and no-document rules
    // -----------------------------------------------------------------------------------------
    async upsertPaymentAlias(tenantId, alias) {
      await db
        .insert(paymentAliases)
        .values({ tenantId, ...alias })
        .onConflictDoUpdate({
          target: [paymentAliases.tenantId, paymentAliases.counterpartyNameNormalized],
          set: { contactId: alias.contactId, learnedFromUserId: alias.learnedFromUserId, createdAt: new Date() },
        });
    },

    async upsertNoDocumentRule(tenantId, rule) {
      await db
        .insert(paymentNoDocumentRules)
        .values({ tenantId, ...rule })
        .onConflictDoNothing({ target: [paymentNoDocumentRules.tenantId, paymentNoDocumentRules.counterpartyNameNormalized] });
    },

    // -----------------------------------------------------------------------------------------
    // Documents
    // -----------------------------------------------------------------------------------------
    async upsertDocument(tenantId, document) {
      const { id: _id, ...columns } = document;
      const [row] = await db
        .insert(documents)
        .values({ ...document, tenantId })
        .onConflictDoUpdate({ target: documents.id, set: { ...columns, updatedAt: new Date() }, setWhere: eq(documents.tenantId, tenantId) })
        .returning({ ...getTableColumns(documents), created: inserted });
      if (!row) return null;
      const { created, ...rest } = row;
      return { row: rest, created };
    },

    async listDocuments(tenantId, filter, paging) {
      const where = and(
        eq(documents.tenantId, tenantId),
        filter.from ? sql`${documentEffectiveDate} >= ${filter.from}::date` : undefined,
        filter.to ? sql`${documentEffectiveDate} <= ${filter.to}::date` : undefined,
        filter.kind ? sql`${documents.kind} = ${filter.kind}` : undefined,
        filter.direction ? sql`${documents.direction} = ${filter.direction}` : undefined,
        filter.contactId ? eq(documents.contactId, filter.contactId) : undefined,
      );
      const [rows, [total]] = await Promise.all([
        db
          .select({ ...getTableColumns(documents), links: documentLinks })
          .from(documents)
          .where(where)
          .orderBy(desc(documentEffectiveDate), desc(documents.id))
          .offset(paging.offset)
          .limit(paging.limit),
        db.select({ value: count() }).from(documents).where(where),
      ]);
      const today = todayIso();
      const items = rows.map((row) => ({
        ...row,
        paymentStatus: documentPaymentStatus(
          row,
          row.links.reduce((sum, link) => sum + link.allocatedAmountCents, 0),
          today,
        ),
      }));
      return { items, total: total?.value ?? 0 };
    },

    async findDocuments(tenantId, ids) {
      if (ids.length === 0) return [];
      return db
        .select()
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, [...ids])));
    },
  };
}
