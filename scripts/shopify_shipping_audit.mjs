const POLICY_TYPES = Object.freeze({
  NON_SHIPPABLE: "Shipping not required",
  MISSING: "No delivery profile",
  GENERAL: "General shop profile",
  GLOBAL: "Global profile",
  CUSTOM: "Custom profile",
});

const REASON_LABELS = Object.freeze({
  PRODUCT_NOT_ACTIVE: "Product status is not ACTIVE",
  NOT_PUBLISHED_TO_ONLINE_STORE: "Product is not published to the Online Store",
  VARIANT_NOT_AVAILABLE_FOR_SALE: "Variant is not available for sale",
  SHIPPING_PROFILE_MISSING: "Delivery profile is missing",
  SHIPPING_PROFILE_NO_ORIGINS: "Delivery profile has no origin location",
  SHIPPING_PROFILE_NO_ACTIVE_RATES: "Delivery profile has no active shipping rates",
});

const KNOWN_TEXT_TRANSLATIONS = Object.freeze([
  [/\u0437\u0432\u0438\u0447\u0430\u0439\u043d\u0438\u0439/giu, "standard"],
]);

export function translateAuditText(value) {
  let translated = String(value ?? "");
  for (const [pattern, replacement] of KNOWN_TEXT_TRANSLATIONS) {
    translated = translated.replace(pattern, replacement);
  }
  return translated;
}

export function numericShopifyId(id) {
  const match = String(id ?? "").match(/\/(\d+)$/);
  return match ? match[1] : String(id ?? "");
}

export function policyTypeForVariant(variant) {
  if (!variant.inventoryItem?.requiresShipping) return "NON_SHIPPABLE";
  if (!variant.deliveryProfile) return "MISSING";
  if (variant.deliveryProfile.default) return "GENERAL";
  if (variant.deliveryProfile.coversAllItems) return "GLOBAL";
  return "CUSTOM";
}

export function shippingBlockerCodes(variant) {
  if (!variant.inventoryItem?.requiresShipping) return [];
  const profile = variant.deliveryProfile;
  if (!profile) return ["SHIPPING_PROFILE_MISSING"];

  const reasons = [];
  if (profile.originLocationCount === 0) reasons.push("SHIPPING_PROFILE_NO_ORIGINS");
  if (profile.activeMethodDefinitionsCount === 0) reasons.push("SHIPPING_PROFILE_NO_ACTIVE_RATES");
  return reasons;
}

export function analyzeVariant(variant) {
  const translatedVariant = {
    ...variant,
    title: translateAuditText(variant.title),
    displayName: translateAuditText(variant.displayName),
    product: {
      ...variant.product,
      title: translateAuditText(variant.product.title),
    },
    deliveryProfile: variant.deliveryProfile
      ? { ...variant.deliveryProfile, name: translateAuditText(variant.deliveryProfile.name) }
      : null,
  };
  const policyType = policyTypeForVariant(translatedVariant);
  const shippingReasons = shippingBlockerCodes(translatedVariant);
  const availabilityReasons = [];

  if (translatedVariant.product.status !== "ACTIVE") availabilityReasons.push("PRODUCT_NOT_ACTIVE");
  if (!translatedVariant.product.onlineStoreUrl) availabilityReasons.push("NOT_PUBLISHED_TO_ONLINE_STORE");
  if (!translatedVariant.availableForSale) availabilityReasons.push("VARIANT_NOT_AVAILABLE_FOR_SALE");
  availabilityReasons.push(...shippingReasons);

  return {
    ...translatedVariant,
    policyType,
    policyTypeLabel: POLICY_TYPES[policyType],
    hasOwnShippingPolicy: policyType === "CUSTOM",
    missingOwnShippingPolicy: Boolean(translatedVariant.inventoryItem?.requiresShipping) && policyType !== "CUSTOM",
    shippingBlocksOrdering: shippingReasons.length > 0,
    shippingReasonCodes: shippingReasons,
    unavailableInOnlineStore: availabilityReasons.length > 0,
    availabilityReasonCodes: availabilityReasons,
    availabilityReasons: availabilityReasons.map((code) => REASON_LABELS[code]),
  };
}

function uniqueCount(items, selector) {
  return new Set(items.map(selector)).size;
}

export function buildProductPolicySummary(analyzedVariants) {
  const excludedStatuses = new Set(["DRAFT", "ARCHIVED"]);
  const productGroups = new Map();

  for (const variant of analyzedVariants) {
    if (excludedStatuses.has(variant.product.status)) continue;
    let group = productGroups.get(variant.product.id);
    if (!group) {
      group = { product: variant.product, variants: [] };
      productGroups.set(variant.product.id, group);
    }
    group.variants.push(variant);
  }

  return [...productGroups.values()]
    .filter((group) => group.variants.some((variant) => variant.missingOwnShippingPolicy))
    .map((group) => {
      const profileNames = new Set(
        group.variants
          .filter((variant) => variant.missingOwnShippingPolicy && variant.deliveryProfile?.name)
          .map((variant) => variant.deliveryProfile.name),
      );
      return {
        product: group.product,
        variantsTotal: group.variants.length,
        shippableVariants: group.variants.filter((variant) => variant.inventoryItem?.requiresShipping).length,
        variantsWithOwnPolicy: group.variants.filter((variant) => variant.hasOwnShippingPolicy).length,
        variantsWithoutOwnPolicy: group.variants.filter((variant) => variant.missingOwnShippingPolicy).length,
        variantsWithoutAnyProfile: group.variants.filter((variant) => variant.policyType === "MISSING").length,
        variantsUsingGeneralProfile: group.variants.filter((variant) => variant.policyType === "GENERAL").length,
        variantsUsingGlobalProfile: group.variants.filter((variant) => variant.policyType === "GLOBAL").length,
        appliedFallbackProfiles: [...profileNames].sort((left, right) => left.localeCompare(right, "uk")),
      };
    })
    .sort((left, right) => left.product.title.localeCompare(right.product.title, "uk"));
}

export function buildAudit(variants) {
  const analyzed = variants.map(analyzeVariant).sort((left, right) => {
    const productOrder = left.product.title.localeCompare(right.product.title, "uk");
    if (productOrder) return productOrder;
    return left.title.localeCompare(right.title, "uk");
  });

  const withoutOwnPolicy = analyzed.filter((variant) => variant.missingOwnShippingPolicy);
  const unavailable = analyzed.filter((variant) => variant.unavailableInOnlineStore);
  const shippingBlocked = analyzed.filter((variant) => variant.shippingBlocksOrdering);
  const productsWithoutOwnPolicy = buildProductPolicySummary(analyzed);
  const profileMap = new Map();
  for (const variant of analyzed) {
    const profile = variant.deliveryProfile;
    if (profile) profileMap.set(profile.id, profile);
  }

  return {
    allVariants: analyzed,
    withoutOwnPolicy,
    productsWithoutOwnPolicy,
    unavailable,
    shippingBlocked,
    profiles: [...profileMap.values()].sort((left, right) => left.name.localeCompare(right.name, "uk")),
    summary: {
      products: uniqueCount(analyzed, (variant) => variant.product.id),
      variants: analyzed.length,
      physicalVariants: analyzed.filter((variant) => variant.inventoryItem?.requiresShipping).length,
      nonShippableVariants: analyzed.filter((variant) => !variant.inventoryItem?.requiresShipping).length,
      variantsWithOwnPolicy: analyzed.filter((variant) => variant.hasOwnShippingPolicy).length,
      variantsWithoutOwnPolicy: withoutOwnPolicy.length,
      variantsWithoutAnyProfile: analyzed.filter((variant) => variant.policyType === "MISSING").length,
      variantsUsingGeneralProfile: analyzed.filter((variant) => variant.policyType === "GENERAL").length,
      productsWithoutOwnPolicy: productsWithoutOwnPolicy.length,
      unavailableVariants: unavailable.length,
      shippingBlockedVariants: shippingBlocked.length,
      profilesUsed: profileMap.size,
      profilesWithLocationsWithoutRates: [...profileMap.values()].filter(
        (profile) => profile.locationsWithoutRatesCount > 0,
      ).length,
    },
  };
}

export const AUDIT_LABELS = Object.freeze({ POLICY_TYPES, REASON_LABELS });
