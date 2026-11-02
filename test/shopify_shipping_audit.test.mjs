import assert from "node:assert/strict";
import test from "node:test";
import { parseArguments } from "../scripts/audit_shopify_shipping.mjs";
import {
  AUDIT_LABELS,
  analyzeVariant,
  buildAudit,
  buildProductPolicySummary,
  policyTypeForVariant,
  shippingBlockerCodes,
  translateAuditText,
} from "../scripts/shopify_shipping_audit.mjs";

function variant(overrides = {}) {
  return {
    id: "gid://shopify/ProductVariant/20",
    title: "Large",
    availableForSale: true,
    inventoryItem: { requiresShipping: true },
    product: {
      id: "gid://shopify/Product/10",
      title: "Desk",
      status: "ACTIVE",
      onlineStoreUrl: "https://example.test/products/desk",
    },
    deliveryProfile: {
      id: "gid://shopify/DeliveryProfile/30",
      name: "Desk shipping",
      default: false,
      coversAllItems: false,
      activeMethodDefinitionsCount: 3,
      originLocationCount: 1,
      locationsWithoutRatesCount: 0,
      zoneCountryCount: 20,
    },
    ...overrides,
  };
}

test("treats the default delivery profile as not being the variant's own policy", () => {
  const source = variant({
    deliveryProfile: {
      ...variant().deliveryProfile,
      name: "General shipping rates",
      default: true,
    },
  });

  assert.equal(policyTypeForVariant(source), "GENERAL");
  assert.equal(analyzeVariant(source).missingOwnShippingPolicy, true);
  assert.equal(analyzeVariant(source).shippingBlocksOrdering, false);
});

test("does not report a digital variant as missing a shipping policy", () => {
  const source = variant({
    inventoryItem: { requiresShipping: false },
    deliveryProfile: null,
  });

  assert.equal(policyTypeForVariant(source), "NON_SHIPPABLE");
  assert.equal(analyzeVariant(source).missingOwnShippingPolicy, false);
  assert.deepEqual(shippingBlockerCodes(source), []);
});

test("reports definite shipping blockers independently from storefront availability", () => {
  const source = variant({
    deliveryProfile: {
      ...variant().deliveryProfile,
      activeMethodDefinitionsCount: 0,
      originLocationCount: 0,
    },
  });

  assert.deepEqual(shippingBlockerCodes(source), [
    "SHIPPING_PROFILE_NO_ORIGINS",
    "SHIPPING_PROFILE_NO_ACTIVE_RATES",
  ]);
  assert.equal(analyzeVariant(source).unavailableInOnlineStore, true);
});

test("reports inactive, unpublished, and unavailable variants", () => {
  const source = variant({
    availableForSale: false,
    product: {
      ...variant().product,
      status: "DRAFT",
      onlineStoreUrl: null,
    },
  });

  assert.deepEqual(analyzeVariant(source).availabilityReasonCodes, [
    "PRODUCT_NOT_ACTIVE",
    "NOT_PUBLISHED_TO_ONLINE_STORE",
    "VARIANT_NOT_AVAILABLE_FOR_SALE",
  ]);
});

test("builds separate audit collections and summary counts", () => {
  const custom = variant();
  const general = variant({
    id: "gid://shopify/ProductVariant/21",
    title: "Small",
    deliveryProfile: { ...variant().deliveryProfile, id: "gid://shopify/DeliveryProfile/31", default: true },
  });
  const unavailable = variant({
    id: "gid://shopify/ProductVariant/22",
    title: "Medium",
    availableForSale: false,
  });
  const audit = buildAudit([custom, general, unavailable]);

  assert.equal(audit.withoutOwnPolicy.length, 1);
  assert.equal(audit.unavailable.length, 1);
  assert.equal(audit.summary.variants, 3);
  assert.equal(audit.summary.variantsWithOwnPolicy, 2);
  assert.equal(audit.summary.variantsUsingGeneralProfile, 1);
  assert.equal(audit.summary.productsWithoutOwnPolicy, 1);
});

test("summarizes each eligible product once and ignores draft and archived products", () => {
  const generalProfile = { ...variant().deliveryProfile, id: "gid://shopify/DeliveryProfile/31", default: true };
  const activeCustom = analyzeVariant(variant());
  const activeGeneral = analyzeVariant(variant({
    id: "gid://shopify/ProductVariant/21",
    title: "Small",
    deliveryProfile: generalProfile,
  }));
  const draftGeneral = analyzeVariant(variant({
    id: "gid://shopify/ProductVariant/22",
    product: {
      ...variant().product,
      id: "gid://shopify/Product/11",
      title: "Draft desk",
      status: "DRAFT",
    },
    deliveryProfile: generalProfile,
  }));
  const archivedGeneral = analyzeVariant(variant({
    id: "gid://shopify/ProductVariant/23",
    product: {
      ...variant().product,
      id: "gid://shopify/Product/12",
      title: "Archived desk",
      status: "ARCHIVED",
    },
    deliveryProfile: generalProfile,
  }));

  const products = buildProductPolicySummary([activeCustom, activeGeneral, draftGeneral, archivedGeneral]);

  assert.equal(products.length, 1);
  assert.equal(products[0].product.id, "gid://shopify/Product/10");
  assert.equal(products[0].variantsTotal, 2);
  assert.equal(products[0].variantsWithOwnPolicy, 1);
  assert.equal(products[0].variantsWithoutOwnPolicy, 1);
  assert.deepEqual(products[0].appliedFallbackProfiles, ["Desk shipping"]);
});

test("parses report output paths", () => {
  const options = parseArguments(["--output", "./tmp/audit.xlsx"]);
  assert.match(options.output, /tmp\/audit\.xlsx$/);
  assert.match(options.jsonOutput, /tmp\/audit\.json$/);
});

test("uses English-only policy and reason labels", () => {
  const labels = [
    ...Object.values(AUDIT_LABELS.POLICY_TYPES),
    ...Object.values(AUDIT_LABELS.REASON_LABELS),
  ];
  assert.equal(labels.some((label) => /[\u0400-\u04FF]/u.test(label)), false);
});

test("translates known non-English audit text without changing English text", () => {
  assert.equal(
    translateAuditText("Chair (\u0437\u0432\u0438\u0447\u0430\u0439\u043d\u0438\u0439)"),
    "Chair (standard)",
  );
  assert.equal(translateAuditText("General profile"), "General profile");
});
