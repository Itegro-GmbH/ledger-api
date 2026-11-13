// Reference data every platform needs before it has a tenant: the tax codes with their accounts
// and VAT return fields, and the chart templates. Public, read-only, the same for everyone.
import { SKR04_SEED_ACCOUNTS, TAX_CODE_DEFINITIONS, TAX_CODES } from "@ledger/core";
import { z } from "zod";

import { defineOperation, ok } from "./kit";

export const listTaxCodes = defineOperation({
  name: "list_tax_codes",
  title: "List tax codes",
  description:
    "Every tax code a booking line can carry (vst19, vst7, rc13b, ust19, ust7, eu_not_taxable, not_taxable, " +
    "tax_free, pass_through): rate, kind, the account the generated tax line goes to (SKR04), and the VAT " +
    "return field (Kennzahl) its base is reported in. A line with a tax code gets its tax lines added " +
    "automatically when it is booked.",
  input: z.object({}),
  audience: "public",
  scope: null,
  effect: "read",
  async run() {
    return ok({ taxCodes: TAX_CODES.map((code) => TAX_CODE_DEFINITIONS[code]) });
  },
});

export const CHART_TEMPLATES = ["skr04"] as const;

export const getChartTemplate = defineOperation({
  name: "get_chart_template",
  title: "Get chart template",
  description:
    "The accounts a new tenant starts with for a chart (today SKR04; SKR03 follows with the DATEV export): " +
    "number, name, kind (asset, liability, equity, revenue, expense), group, and whether the account keeps " +
    "open items.",
  input: z.object({ chart: z.enum(CHART_TEMPLATES).default("skr04") }),
  audience: "public",
  scope: null,
  effect: "read",
  async run(input) {
    return ok({ chart: input.chart, accounts: SKR04_SEED_ACCOUNTS });
  },
});
