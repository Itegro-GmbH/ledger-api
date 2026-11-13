// The DATEV export (decisions/0001-ledger-api.md, "DATEV export"): a tenant's DATEV settings and
// the Buchungsstapel of a period, the CSV its tax advisor imports into DATEV. The file is returned
// in the encoding DATEV expects (Windows-1252), base64 encoded, so it survives JSON unchanged.
import { datevSettingsInputSchema, encodeWindows1252 } from "@ledger/core";
import { z } from "zod";

import { defineOperation } from "./kit";
import { strict, withTenant } from "./use-case";

const isoDate = z.iso.date();

export const getDatevSettings = defineOperation({
  name: "get_datev_settings",
  title: "Get DATEV settings",
  description: "The tenant's DATEV export settings (consultant and client number, account length, fiscal year start, tax keys, automatic accounts), or null while unset.",
  input: z.object({}),
  audience: "tenant",
  scope: "read",
  effect: "read",
  async run(_input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => ({ datev: await ledger.getDatevSettings(tenantId) }));
  },
});

export const setDatevSettings = defineOperation({
  name: "set_datev_settings",
  title: "Set DATEV settings",
  description:
    "Sets the tenant's DATEV export settings: consultantNumber (Beraternummer) and clientNumber (Mandantennummer) " +
    "from the tax advisor, accountLength (Sachkontenlänge, default 4), fiscalYearStartMonth (default 1). taxKeys " +
    "maps a tax code to the advisor's DATEV tax key (BU-Schlüssel); unset codes use the defaults vst19 9, vst7 8, " +
    "ust19 3, ust7 2, and reverse charge has none until set. automaticAccounts lists the advisor's automatic " +
    "accounts (default SKR04 4300 and 4400). Ask the tax advisor for both before the first real export.",
  input: z.object(datevSettingsInputSchema.shape),
  audience: "tenant",
  scope: "write",
  effect: "write",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => ({ datev: await ledger.setDatevSettings({ tenantId, settings: strict(datevSettingsInputSchema, input) }) }));
  },
});

export const createDatevExport = defineOperation({
  name: "create_datev_export",
  title: "Create DATEV export",
  description:
    "The booked entries of a period (at most one fiscal year, usually a month or quarter) as a DATEV " +
    "Buchungsstapel (EXTF CSV, Windows-1252) for the tax advisor: fileName, contentBase64, rowCount and " +
    "warnings (tax codes without a tax key, shortened texts, cleaned document numbers). Proposals are not " +
    "exported. Needs set_datev_settings first.",
  input: z.object({ from: isoDate, to: isoDate, description: z.string().max(30).optional().describe("Batch description, at most 30 characters") }),
  audience: "tenant",
  scope: "read",
  effect: "read",
  async run(input, ctx) {
    return withTenant(ctx, async ({ services: { ledger }, tenantId }) => {
      const result = await ledger.createDatevExport({ tenantId, ...input });
      return {
        fileName: result.fileName,
        encoding: "windows-1252",
        contentBase64: Buffer.from(encodeWindows1252(result.text)).toString("base64"),
        rowCount: result.rowCount,
        entryCount: result.entryCount,
        warnings: result.warnings,
      };
    });
  },
});

export const EXPORT_OPERATIONS = [getDatevSettings, setDatevSettings, createDatevExport];
