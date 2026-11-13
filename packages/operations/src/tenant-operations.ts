// Tenants ("Mandanten"): one set of books each, owned by the calling platform in the key's
// environment (decisions/0001-ledger-api.md, "Tenancy: platform and tenant"). Creating a tenant
// also turns its books on and seeds the chart, so it can book right away.
import { VAT_BASES, VAT_PERIODS } from "@ledger/core";
import { z } from "zod";

import { defineOperation, fail, OPERATION_ERROR } from "./kit";
import { withPlatform } from "./use-case";

const isoDate = z.iso.date();

function tenantView(row: { id: string; name: string; externalRef: string | null; environment: string; createdAt: Date }) {
  return { id: row.id, name: row.name, externalRef: row.externalRef, environment: row.environment, createdAt: row.createdAt.toISOString() };
}

export const createTenant = defineOperation({
  name: "create_tenant",
  title: "Create tenant",
  description:
    "Creates a tenant (one set of books: a company or sole trader) for your platform and turns its books on with " +
    "the SKR04 chart. externalRef is your own id for it (unique per platform), so you can find it again with " +
    "find_tenant. id may be given to keep an existing identifier. vatPeriod is the VAT return period, vatBasis " +
    "'soll' (on invoices) or 'ist' (on payments), startDate the first day the books cover.",
  input: z.object({
    id: z.uuid().optional(),
    name: z.string().trim().min(1).max(200),
    externalRef: z.string().trim().min(1).max(200).optional(),
    vatPeriod: z.enum(VAT_PERIODS).default("quarter"),
    vatBasis: z.enum(VAT_BASES).default("soll"),
    startDate: isoDate.nullable().default(null),
  }),
  audience: "platform",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withPlatform(ctx, async ({ services, platformId, environment }) => {
      const scope = { platformId, environment };
      if (input.externalRef && (await services.tenants.findByExternalRef(scope, input.externalRef))) return fail("external_ref_taken");
      const tenant = await services.tenants.create({ ...scope, id: input.id, name: input.name, externalRef: input.externalRef ?? null });
      try {
        const settings = await services.ledger.setSettings({
          tenantId: tenant.id,
          settings: { enabled: true, vatPeriod: input.vatPeriod, vatBasis: input.vatBasis, startDate: input.startDate },
        });
        return { tenant: tenantView(tenant), settings };
      } catch (error) {
        // Not left half created: a tenant without its books would only confuse the next call.
        await services.tenants.delete(scope, tenant.id);
        throw error;
      }
    });
  },
});

export const listTenants = defineOperation({
  name: "list_tenants",
  title: "List tenants",
  description: "Every tenant of your platform in the key's environment (test or live).",
  input: z.object({}),
  audience: "platform",
  scope: "read",
  effect: "read",
  async run(_input, ctx) {
    return withPlatform(ctx, async ({ services, platformId, environment }) => ({
      tenants: (await services.tenants.list({ platformId, environment })).map(tenantView),
    }));
  },
});

export const findTenant = defineOperation({
  name: "find_tenant",
  title: "Find tenant",
  description: "One tenant of your platform by its id or by your externalRef.",
  input: z.object({ id: z.uuid().optional(), externalRef: z.string().trim().min(1).max(200).optional() }),
  audience: "platform",
  scope: "read",
  effect: "read",
  async run(input, ctx) {
    if (!input.id === !input.externalRef) return fail(OPERATION_ERROR.invalidInput, { message: "pass exactly one of id and externalRef" });
    return withPlatform(ctx, async ({ services, platformId, environment }) => {
      const scope = { platformId, environment };
      const tenant = input.id ? await services.tenants.find(scope, input.id) : await services.tenants.findByExternalRef(scope, input.externalRef!);
      if (!tenant) return fail(OPERATION_ERROR.notFound);
      return { tenant: tenantView(tenant), settings: await services.ledger.getSettings(tenant.id) };
    });
  },
});

export const updateTenant = defineOperation({
  name: "update_tenant",
  title: "Update tenant",
  description: "Renames a tenant, changes its externalRef, or its VAT settings (period, basis, start date).",
  input: z.object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(200).optional(),
    externalRef: z.string().trim().min(1).max(200).nullable().optional(),
    vatPeriod: z.enum(VAT_PERIODS).optional(),
    vatBasis: z.enum(VAT_BASES).optional(),
    startDate: isoDate.nullable().optional(),
  }),
  audience: "platform",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withPlatform(ctx, async ({ services, platformId, environment }) => {
      const scope = { platformId, environment };
      const existing = await services.tenants.find(scope, input.id);
      if (!existing) return fail(OPERATION_ERROR.notFound);
      if (input.externalRef && input.externalRef !== existing.externalRef && (await services.tenants.findByExternalRef(scope, input.externalRef))) return fail("external_ref_taken");
      const tenant = input.name !== undefined || input.externalRef !== undefined ? await services.tenants.update(scope, input.id, { name: input.name, externalRef: input.externalRef }) : existing;
      let settings = await services.ledger.getSettings(input.id);
      if (input.vatPeriod || input.vatBasis || input.startDate !== undefined) {
        settings = await services.ledger.setSettings({
          tenantId: input.id,
          settings: { enabled: true, vatPeriod: input.vatPeriod ?? settings.vatPeriod, vatBasis: input.vatBasis ?? settings.vatBasis, startDate: input.startDate !== undefined ? input.startDate : settings.startDate },
        });
      }
      return { tenant: tenantView(tenant!), settings };
    });
  },
});

export const deleteTenant = defineOperation({
  name: "delete_tenant",
  title: "Delete tenant",
  description:
    "Deletes a tenant and its whole books: accounts, entries, revisions, filings, rules. Cannot be undone. Meant " +
    "for test tenants and for a platform's customer who left; a tenant with submitted filings is still deleted, so " +
    "export what must be retained first.",
  input: z.object({ id: z.uuid() }),
  audience: "platform",
  scope: "write",
  effect: "destructive",
  async run(input, ctx) {
    return withPlatform(ctx, async ({ services, platformId, environment }) => {
      const deleted = await services.tenants.delete({ platformId, environment }, input.id);
      return deleted ? { deleted: true } : fail(OPERATION_ERROR.notFound);
    });
  },
});

export const TENANT_OPERATIONS = [createTenant, listTenants, findTenant, updateTenant, deleteTenant];
