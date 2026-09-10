import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import {
  buildRatePlan,
  normalizeShopifyId,
  readWorksheetRows,
  warningReportFilename,
} from "../scripts/shopify_shipping_importer.mjs";
import { parseArguments } from "../scripts/import_shopify_shipping.mjs";

function shippingRow(rowNumber, destination, oneItemUsd, overrides = {}) {
  return {
    rowNumber,
    destination,
    shippingService: "Ukrposhta - International",
    deliveryEstimate: "7-21 business days",
    chargeType: "Fixed price",
    oneItemUsd,
    additionalItemUsd: oneItemUsd,
    ocrStatus: "OK",
    ...overrides,
  };
}

test("uses the first worksheet price when a destination is duplicated", () => {
  const plan = buildRatePlan(
    [shippingRow(7, "Canada", 29), shippingRow(8, "Canada", 99)],
    { sheetName: "Desk XL" },
  );

  assert.equal(plan.zones.length, 1);
  assert.equal(plan.zones[0].methodDefinitionsToCreate[0].rateDefinition.price.amount, "29.00");
  assert.equal(plan.warnings.length, 1);
  assert.equal(plan.warnings[0].code, "DUPLICATE_DESTINATION");
  assert.equal(plan.warnings[0].selected.row, 7);
  assert.equal(plan.warnings[0].ignored[0].row, 8);
});

test("gives explicit country rows priority over regional fallback rows", () => {
  const plan = buildRatePlan(
    [
      shippingRow(7, "France", 25),
      shippingRow(8, "European Union", 59),
      shippingRow(9, "Everywhere else", 120),
    ],
    { sheetName: "Chair" },
  );

  assert.equal(plan.zones.length, 3);
  assert.deepEqual(plan.zones[0].countries, [{ code: "FR", includeAllProvinces: true }]);
  assert.equal(plan.zones[1].countries.some((country) => country.code === "FR"), false);
  assert.equal(plan.zones[1].countries.some((country) => country.code === "DE"), true);
  assert.deepEqual(plan.zones[2].countries, [{ restOfWorld: true }]);
});

test("skips a missing flat price and records both OCR and price warnings", () => {
  const plan = buildRatePlan(
    [shippingRow(7, "Iceland", null, { additionalItemUsd: null, ocrStatus: "Review: both prices are missing" })],
    { sheetName: "Desks" },
  );

  assert.equal(plan.zones.length, 0);
  assert.deepEqual(plan.warnings.map((warning) => warning.code), ["OCR_REVIEW", "INVALID_FIRST_ITEM_PRICE"]);
});

test("reads the expected table from a named workbook worksheet", () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Desk XL");
  worksheet.addRow(["Metadata"]);
  worksheet.addRow([
    "Country / region",
    "Shipping service",
    "Delivery estimate",
    "Charge type",
    "One item (USD)",
    "Additional item (USD)",
    "OCR status",
  ]);
  worksheet.addRow(["Canada", "UPS", "1-3 business days", "Fixed price", 49.9, 39, "OK"]);

  assert.deepEqual(readWorksheetRows(workbook, "Desk XL"), [
    {
      rowNumber: 3,
      destination: "Canada",
      shippingService: "UPS",
      deliveryEstimate: "1-3 business days",
      chargeType: "Fixed price",
      oneItemUsd: 49.9,
      additionalItemUsd: 39,
      ocrStatus: "OK",
    },
  ]);
});

test("normalizes Shopify IDs and warning filenames", () => {
  assert.deepEqual(normalizeShopifyId("12345", "Product"), {
    gid: "gid://shopify/Product/12345",
    numericId: "12345",
  });
  assert.deepEqual(normalizeShopifyId("gid://shopify/Product/12345", "Product"), {
    gid: "gid://shopify/Product/12345",
    numericId: "12345",
  });
  assert.equal(warningReportFilename("12345", "Chair / XL"), "12345_Chair_XL.json");
});

test("accepts worksheet and product ID through CLI flags", () => {
  const options = parseArguments(["--sheet", "Desk XL", "--product-id", "12345", "--apply"]);
  assert.equal(options.sheet, "Desk XL");
  assert.equal(options.productId, "12345");
  assert.equal(options.apply, true);
});
