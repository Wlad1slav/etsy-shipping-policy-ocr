import assert from "node:assert/strict";
import test from "node:test";
import { makeUniqueSheetNames, parseScreenshot } from "../scripts/shipping_parser.mjs";

const line = (text, x, y, width = 100, height = 20) => ({
  text,
  confidence: 1,
  x,
  y,
  width,
  height,
});

test("parses a fixed-price Etsy shipping block as numeric USD", () => {
  const image = {
    path: "/repo/screenshots/Desk XL/example.jpg",
    pixelWidth: 1280,
    pixelHeight: 1500,
    lines: [
      line("Canada", 190, 100),
      line("Shipping service", 486, 100),
      line("Ukrposhta - International (7-21 business days)", 503, 145, 450),
      line("What you'll charge", 486, 230),
      line("Fixed price", 503, 280),
      line("US$ 29,90", 503, 390),
      line("US$ 19,00", 717, 390),
    ],
  };
  const [row] = parseScreenshot(image, "/repo/screenshots").rows;
  assert.deepEqual(row, {
    destination: "Canada",
    shippingService: "Ukrposhta - International",
    deliveryEstimate: "7–21 business days",
    chargeType: "Fixed price",
    oneItemUsd: 29.9,
    additionalItemUsd: 19,
    sourceY: 100,
    ocrStatus: "OK",
  });
});

test("treats free shipping as zero and ignores country-less upgrade blocks", () => {
  const image = {
    path: "/repo/screenshots/Step Stools/example.jpg",
    pixelWidth: 1280,
    pixelHeight: 1500,
    lines: [
      line("Ukraine", 190, 100),
      line("Shipping service", 486, 100),
      line("Ukrposhta - Domestic (3-6 business days)", 503, 145, 400),
      line("Free shipping", 503, 270),
      line("Shipping service", 486, 500),
      line("Other", 503, 545),
      line("US$ 35,00", 503, 700),
      line("US$ 35,00", 817, 700),
    ],
  };
  const result = parseScreenshot(image, "/repo/screenshots");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].chargeType, "Free shipping");
  assert.equal(result.rows[0].oneItemUsd, 0);
  assert.equal(result.rows[0].additionalItemUsd, 0);
});

test("uses directory SKU and unique Excel-safe sheet names", () => {
  const screenshots = [
    { sku: "Desks" },
    { sku: "Desks" },
    { sku: "Chair / standard" },
  ];
  assert.deepEqual(makeUniqueSheetNames(screenshots), ["Desks", "Desks (2)", "Chair standard"]);
});

