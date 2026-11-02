import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAudit, numericShopifyId } from "./shopify_shipping_audit.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(scriptDirectory);

function usage() {
  return `Usage:
  npm run audit:shopify -- [options]

Options:
  --output <file>        Excel report (default: outputs/shopify_shipping_audit.xlsx)
  --json-output <file>   JSON report (default: the Excel path with .json extension)
  --store <store>        Shopify store or *.myshopify.com domain (default: SHOPIFY_STORE)
  --api-version <ver>    Shopify Admin API version (default: SHOPIFY_API_VERSION or 2026-07)
  --help, -h             Show this help

Authentication:
  SHOPIFY_STORE and SHOPIFY_API_TOKEN are loaded from the environment or .env.
  SHOPIFY_ADMIN_TOKEN is also accepted as a token alias.

The audit is read-only. It checks every product variant, including draft and archived products.
`;
}

function requireOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

export function parseArguments(argv) {
  const options = {
    output: path.join(projectDirectory, "outputs", "shopify_shipping_audit.xlsx"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") options.output = path.resolve(requireOptionValue(argv, index++, argument));
    else if (argument === "--json-output") options.jsonOutput = path.resolve(requireOptionValue(argv, index++, argument));
    else if (argument === "--store") options.store = requireOptionValue(argv, index++, argument);
    else if (argument === "--api-version") options.apiVersion = requireOptionValue(argv, index++, argument);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (!options.jsonOutput) {
    const extension = path.extname(options.output);
    options.jsonOutput = extension
      ? `${options.output.slice(0, -extension.length)}.json`
      : `${options.output}.json`;
  }
  return options;
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
  const separator = withoutExport.indexOf("=");
  if (separator < 1) return null;
  const key = withoutExport.slice(0, separator).trim();
  let value = withoutExport.slice(separator + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

async function loadLocalEnv() {
  try {
    const content = await fs.readFile(path.join(projectDirectory, ".env"), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const entry = parseEnvLine(line);
      if (entry && process.env[entry[0]] === undefined) process.env[entry[0]] = entry[1];
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function normalizeStore(value) {
  let store = String(value ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  if (!store) throw new Error("SHOPIFY_STORE is missing. Add it to .env or pass --store.");
  if (!store.includes(".")) store = `${store}.myshopify.com`;
  return store.toLocaleLowerCase("en");
}

function formatGraphqlErrors(errors) {
  return errors.map((error) => error.message).join("; ");
}

class ShopifyClient {
  constructor({ store, token, apiVersion }) {
    this.endpoint = `https://${store}/admin/api/${apiVersion}/graphql.json`;
    this.token = token;
  }

  async request(query, variables = {}) {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": this.token,
      },
      body: JSON.stringify({ query, variables }),
    });

    const bodyText = await response.text();
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new Error(`Shopify returned HTTP ${response.status} with a non-JSON response.`);
    }
    if (!response.ok) {
      throw new Error(`Shopify returned HTTP ${response.status}: ${formatGraphqlErrors(body.errors ?? []) || "request failed"}`);
    }
    if (body.errors?.length) throw new Error(`Shopify GraphQL error: ${formatGraphqlErrors(body.errors)}`);
    return body.data;
  }
}

async function getShopContext(client) {
  const data = await client.request(`
    query ShopifyShippingAuditContext {
      shop {
        name
        myshopifyDomain
        currencyCode
      }
      currentAppInstallation {
        accessScopes { handle }
      }
    }
  `);
  return {
    shop: data.shop,
    scopes: new Set(data.currentAppInstallation.accessScopes.map((scope) => scope.handle)),
  };
}

function checkRequiredScopes(scopes) {
  const requirements = [
    { label: "read_products", accepted: ["read_products", "write_products"] },
    { label: "read_shipping", accepted: ["read_shipping", "write_shipping"] },
  ];
  return requirements
    .filter((requirement) => !requirement.accepted.some((scope) => scopes.has(scope)))
    .map((requirement) => requirement.label);
}

async function getAllVariants(client) {
  const variants = [];
  let after = null;

  do {
    const data = await client.request(
      `query ShopifyShippingAuditVariants($after: String) {
        productVariants(first: 100, after: $after, sortKey: ID) {
          nodes {
            id
            legacyResourceId
            title
            displayName
            sku
            price
            availableForSale
            inventoryQuantity
            sellableOnlineQuantity
            inventoryPolicy
            inventoryItem {
              requiresShipping
              tracked
            }
            product {
              id
              legacyResourceId
              title
              handle
              status
              onlineStoreUrl
            }
            deliveryProfile {
              id
              name
              default
              coversAllItems
              activeMethodDefinitionsCount
              originLocationCount
              locationsWithoutRatesCount
              zoneCountryCount
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { after },
    );
    variants.push(...data.productVariants.nodes);
    after = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
  } while (after);

  return variants;
}

function adminVariantUrl(domain, variant) {
  const storeHandle = domain.replace(/\.myshopify\.com$/i, "");
  return `https://admin.shopify.com/store/${storeHandle}/products/${numericShopifyId(variant.product.id)}/variants/${numericShopifyId(variant.id)}`;
}

function adminProductUrl(domain, product) {
  const storeHandle = domain.replace(/\.myshopify\.com$/i, "");
  return `https://admin.shopify.com/store/${storeHandle}/products/${numericShopifyId(product.id)}`;
}

function variantRow(variant, shopDomain) {
  const profile = variant.deliveryProfile;
  return {
    productId: numericShopifyId(variant.product.id),
    product: variant.product.title,
    productStatus: variant.product.status,
    onlineStoreUrl: variant.product.onlineStoreUrl ?? "",
    variantId: numericShopifyId(variant.id),
    variant: variant.title,
    sku: variant.sku ?? "",
    price: Number(variant.price),
    requiresShipping: variant.inventoryItem?.requiresShipping ? "Yes" : "No",
    availableForSale: variant.availableForSale ? "Yes" : "No",
    sellableOnlineQuantity: variant.sellableOnlineQuantity,
    inventoryQuantity: variant.inventoryQuantity,
    inventoryPolicy: variant.inventoryPolicy,
    profileId: profile ? numericShopifyId(profile.id) : "",
    profile: profile?.name ?? "",
    policyType: variant.policyTypeLabel,
    activeRates: profile?.activeMethodDefinitionsCount ?? "",
    countriesWithRates: profile?.zoneCountryCount ?? "",
    originLocations: profile?.originLocationCount ?? "",
    locationsWithoutRates: profile?.locationsWithoutRatesCount ?? "",
    shippingBlocksOrdering: variant.shippingBlocksOrdering ? "Yes" : "No",
    unavailableInOnlineStore: variant.unavailableInOnlineStore ? "Yes" : "No",
    reasons: variant.availabilityReasons.join("; "),
    adminUrl: adminVariantUrl(shopDomain, variant),
  };
}

const VARIANT_COLUMNS = [
  { header: "Product ID", key: "productId", width: 15 },
  { header: "Product", key: "product", width: 35 },
  { header: "Product Status", key: "productStatus", width: 16 },
  { header: "Storefront URL", key: "onlineStoreUrl", width: 24 },
  { header: "Variant ID", key: "variantId", width: 16 },
  { header: "Variant", key: "variant", width: 28 },
  { header: "SKU", key: "sku", width: 20 },
  { header: "Price", key: "price", width: 12 },
  { header: "Requires Shipping", key: "requiresShipping", width: 20 },
  { header: "Available for Sale", key: "availableForSale", width: 22 },
  { header: "Sellable Online Qty", key: "sellableOnlineQuantity", width: 22 },
  { header: "Inventory Qty", key: "inventoryQuantity", width: 18 },
  { header: "Continue Selling", key: "inventoryPolicy", width: 20 },
  { header: "Delivery Profile ID", key: "profileId", width: 19 },
  { header: "Delivery Profile", key: "profile", width: 32 },
  { header: "Profile Type", key: "policyType", width: 24 },
  { header: "Active Rates", key: "activeRates", width: 17 },
  { header: "Countries with Rates", key: "countriesWithRates", width: 20 },
  { header: "Origin Locations", key: "originLocations", width: 21 },
  { header: "Locations Without Rates", key: "locationsWithoutRates", width: 23 },
  { header: "Shipping Blocker", key: "shippingBlocksOrdering", width: 18 },
  { header: "Unavailable Online", key: "unavailableInOnlineStore", width: 22 },
  { header: "Reasons", key: "reasons", width: 55 },
  { header: "Shopify Admin", key: "adminUrl", width: 22 },
];

const PRODUCT_POLICY_COLUMNS = [
  { header: "Product ID", key: "productId", width: 15 },
  { header: "Product", key: "product", width: 38 },
  { header: "Variants Without Custom Policy", key: "variantsWithoutOwnPolicy", width: 29 },
  { header: "Total Variants", key: "variantsTotal", width: 18 },
  { header: "Variants With Custom Policy", key: "variantsWithOwnPolicy", width: 27 },
  { header: "No Delivery Profile", key: "variantsWithoutAnyProfile", width: 20 },
  { header: "Status", key: "status", width: 14 },
  { header: "Applied Profile", key: "appliedFallbackProfiles", width: 30 },
  { header: "Storefront URL", key: "onlineStoreUrl", width: 22 },
  { header: "Shopify Admin", key: "adminUrl", width: 22 },
];

function styleHeader(row) {
  row.height = 28;
  row.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
  row.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
}

function addVariantSheet(workbook, name, variants, shopDomain, emptyMessage) {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 1, xSplit: 2, showGridLines: false }],
  });
  sheet.columns = VARIANT_COLUMNS;
  sheet.properties.defaultRowHeight = 18;
  styleHeader(sheet.getRow(1));
  sheet.autoFilter = { from: "A1", to: `${sheet.getColumn(VARIANT_COLUMNS.length).letter}1` };

  if (!variants.length) {
    const row = sheet.addRow({ product: emptyMessage });
    row.font = { name: "Arial", size: 10 };
    return sheet;
  }

  for (const variant of variants) {
    const row = sheet.addRow(variantRow(variant, shopDomain));
    row.font = { name: "Arial", size: 10, color: { argb: "FF222222" } };
    row.alignment = { vertical: "top", wrapText: true };
    row.getCell("price").numFmt = "0.00";
    for (const key of ["sellableOnlineQuantity", "inventoryQuantity", "activeRates", "countriesWithRates", "originLocations", "locationsWithoutRates"]) {
      row.getCell(key).numFmt = "#,##0";
    }
    const onlineStoreCell = row.getCell("onlineStoreUrl");
    if (onlineStoreCell.value) {
      onlineStoreCell.value = { text: "Open Product", hyperlink: onlineStoreCell.value };
      onlineStoreCell.font = { color: { argb: "FF0563C1" }, underline: true };
    }
    const adminCell = row.getCell("adminUrl");
    adminCell.value = { text: "Open in Admin", hyperlink: adminCell.value };
    adminCell.font = { color: { argb: "FF0563C1" }, underline: true };
    if (variant.shippingBlocksOrdering) {
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCE4D6" } };
    }
  }
  return sheet;
}

function addProductPolicySheet(workbook, products, shopDomain) {
  const sheet = workbook.addWorksheet("Products Without Custom Policy", {
    views: [{ state: "frozen", ySplit: 1, xSplit: 2, showGridLines: false }],
  });
  sheet.columns = PRODUCT_POLICY_COLUMNS;
  sheet.properties.defaultRowHeight = 20;
  styleHeader(sheet.getRow(1));
  sheet.autoFilter = { from: "A1", to: `${sheet.getColumn(PRODUCT_POLICY_COLUMNS.length).letter}1` };

  if (!products.length) {
    const row = sheet.addRow({ product: "Every product except DRAFT and ARCHIVED has a custom delivery profile for each physical variant." });
    row.font = { name: "Arial", size: 10 };
    return sheet;
  }

  for (const item of products) {
    const row = sheet.addRow({
      productId: numericShopifyId(item.product.id),
      product: item.product.title,
      status: item.product.status,
      onlineStoreUrl: item.product.onlineStoreUrl ?? "",
      variantsTotal: item.variantsTotal,
      variantsWithOwnPolicy: item.variantsWithOwnPolicy,
      variantsWithoutOwnPolicy: item.variantsWithoutOwnPolicy,
      variantsWithoutAnyProfile: item.variantsWithoutAnyProfile,
      appliedFallbackProfiles: item.appliedFallbackProfiles.join(", "),
      adminUrl: adminProductUrl(shopDomain, item.product),
    });
    row.font = { name: "Arial", size: 10, color: { argb: "FF222222" } };
    row.alignment = { vertical: "top", wrapText: true };
    for (const key of [
      "variantsTotal",
      "variantsWithOwnPolicy",
      "variantsWithoutOwnPolicy",
      "variantsWithoutAnyProfile",
    ]) {
      row.getCell(key).numFmt = "#,##0";
    }
    const onlineStoreCell = row.getCell("onlineStoreUrl");
    if (onlineStoreCell.value) {
      onlineStoreCell.value = { text: "Open Product", hyperlink: onlineStoreCell.value };
      onlineStoreCell.font = { name: "Arial", size: 10, color: { argb: "FF0563C1" }, underline: true };
    }
    const adminCell = row.getCell("adminUrl");
    adminCell.value = { text: "Open in Admin", hyperlink: adminCell.value };
    adminCell.font = { name: "Arial", size: 10, color: { argb: "FF0563C1" }, underline: true };
    if (item.variantsWithoutAnyProfile > 0) {
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCE4D6" } };
    }
  }
  return sheet;
}

function addSummarySheet(workbook, report) {
  const { audit, shop, apiVersion, generatedAt } = report;
  const sheet = workbook.addWorksheet("Summary", { views: [{ showGridLines: false }] });
  sheet.columns = [{ width: 43 }, { width: 58 }];
  sheet.mergeCells("A1:B1");
  sheet.getCell("A1").value = "Shopify Shipping Policy Audit";
  sheet.getCell("A1").font = { name: "Arial", bold: true, size: 16, color: { argb: "FF1F4E78" } };
  sheet.getCell("A1").alignment = { vertical: "middle" };
  sheet.getRow(1).height = 34;
  sheet.addRow([]);

  const generatedAtLocal = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Sofia",
  }).format(new Date(generatedAt));

  const summaryRows = [
    ["Shop", `${shop.name} (${shop.myshopifyDomain})`],
    ["Generated At", `${generatedAtLocal} (Europe/Sofia)`],
    ["Data Source", "Shopify Admin GraphQL API"],
    ["Shopify API Version", apiVersion],
    ["Products Checked", audit.summary.products],
    ["Variants Checked", audit.summary.variants],
    ["Physical Variants", audit.summary.physicalVariants],
    ["Variants Not Requiring Shipping", audit.summary.nonShippableVariants],
    ["Variants With Custom Policy", audit.summary.variantsWithOwnPolicy],
    ["Variants Without Custom Policy", audit.summary.variantsWithoutOwnPolicy],
    ["Products Without Custom Policy (excluding DRAFT/ARCHIVED)", audit.summary.productsWithoutOwnPolicy],
    ["Variants Without Any Delivery Profile", audit.summary.variantsWithoutAnyProfile],
    ["Variants Using General Shop Profile", audit.summary.variantsUsingGeneralProfile],
    ["Unavailable in Online Store", audit.summary.unavailableVariants],
    ["Definitely Blocked by Shipping", audit.summary.shippingBlockedVariants],
    ["Delivery Profiles Used", audit.summary.profilesUsed],
    ["Profiles With Locations Without Rates", audit.summary.profilesWithLocationsWithoutRates],
  ];
  for (const values of summaryRows) {
    const row = sheet.addRow(values);
    row.font = { name: "Arial", size: 10, color: { argb: "FF222222" } };
    row.getCell(1).font = { name: "Arial", size: 10, bold: true, color: { argb: "FF222222" } };
    row.getCell(2).alignment = { horizontal: "left", vertical: "top", wrapText: true };
    if (typeof values[1] === "number") row.getCell(2).numFmt = "#,##0";
  }

  sheet.addRow([]);
  const criteriaHeader = sheet.addRow(["How to Read the Report", "Definition"]);
  styleHeader(criteriaHeader);
  sheet.addRow([
    "Without Custom Policy",
    "A physical variant is not assigned to its own custom delivery profile. It uses the general/global profile or has no delivery profile.",
  ]);
  sheet.addRow([
    "Unavailable Online",
    "The product is not ACTIVE, is not published to the Online Store, has availableForSale=false, or has a definite shipping blocker.",
  ]);
  sheet.addRow([
    "Definite Shipping Blocker",
    "A physical variant has no delivery profile, origin location, or active shipping rate. An active rate does not guarantee delivery to every country.",
  ]);
  sheet.addRow([
    "Digital Products",
    "Variants with requiresShipping=false are not treated as shipping-policy errors.",
  ]);
  sheet.eachRow((row) => {
    row.alignment = { vertical: "top", wrapText: true };
    row.eachCell((cell) => {
      cell.font = { name: "Arial", size: cell.font?.size ?? 10, ...cell.font };
    });
  });
  return sheet;
}

async function writeReports({ output, jsonOutput, report }) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(path.dirname(jsonOutput), { recursive: true });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Etsy Shipping Policy OCR";
  workbook.created = new Date(report.generatedAt);
  addSummarySheet(workbook, report);
  addProductPolicySheet(workbook, report.audit.productsWithoutOwnPolicy, report.shop.myshopifyDomain);
  addVariantSheet(
    workbook,
    "Variants Without Custom Policy",
    report.audit.withoutOwnPolicy,
    report.shop.myshopifyDomain,
    "Every physical variant has its own custom delivery profile.",
  );
  addVariantSheet(
    workbook,
    "Unavailable Variants",
    report.audit.unavailable,
    report.shop.myshopifyDomain,
    "Every checked variant is available in the Online Store.",
  );
  addVariantSheet(
    workbook,
    "All Variants",
    report.audit.allVariants,
    report.shop.myshopifyDomain,
    "The shop has no variants.",
  );
  await workbook.xlsx.writeFile(output);

  const serializable = {
    generatedAt: report.generatedAt,
    shop: report.shop,
    apiVersion: report.apiVersion,
    definitions: {
      withoutOwnPolicy: "A physical variant that uses the general/global profile or has no delivery profile.",
      productsWithoutOwnPolicy: "One row per non-draft, non-archived product that has at least one physical variant without its own delivery profile.",
      unavailableInOnlineStore: "The product is not active or published, the variant is not available for sale, or shipping has a definite blocker.",
      shippingBlocksOrdering: "A physical variant has no delivery profile, no origin location, or no active shipping rate.",
    },
    summary: report.audit.summary,
    profiles: report.audit.profiles,
    productsWithoutOwnPolicy: report.audit.productsWithoutOwnPolicy,
    withoutOwnPolicy: report.audit.withoutOwnPolicy,
    unavailable: report.audit.unavailable,
    shippingBlocked: report.audit.shippingBlocked,
    allVariants: report.audit.allVariants,
  };
  await fs.writeFile(jsonOutput, `${JSON.stringify(serializable, null, 2)}\n`, "utf8");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  await loadLocalEnv();
  const store = normalizeStore(options.store || process.env.SHOPIFY_STORE);
  const token = process.env.SHOPIFY_API_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) throw new Error("SHOPIFY_API_TOKEN is missing. Add it to .env or the process environment.");
  const apiVersion = options.apiVersion || process.env.SHOPIFY_API_VERSION || "2026-07";
  if (!/^\d{4}-(01|04|07|10)$/.test(apiVersion)) throw new Error(`Invalid Shopify API version: ${apiVersion}`);

  const client = new ShopifyClient({ store, token, apiVersion });
  const context = await getShopContext(client);
  const missingScopes = checkRequiredScopes(context.scopes);
  if (missingScopes.length) throw new Error(`The Shopify token is missing required scopes: ${missingScopes.join(", ")}`);

  const variants = await getAllVariants(client);
  const audit = buildAudit(variants);
  const report = {
    generatedAt: new Date().toISOString(),
    shop: context.shop,
    apiVersion,
    audit,
  };
  await writeReports({ ...options, report });

  console.log(`Shop: ${context.shop.name} (${context.shop.myshopifyDomain})`);
  console.log(`Products checked: ${audit.summary.products}`);
  console.log(`Variants checked: ${audit.summary.variants}`);
  console.log(`Without own shipping policy: ${audit.summary.variantsWithoutOwnPolicy}`);
  console.log(`Products with at least one such variant (excluding DRAFT/ARCHIVED): ${audit.summary.productsWithoutOwnPolicy}`);
  console.log(`Unavailable in Online Store: ${audit.summary.unavailableVariants}`);
  console.log(`Definitely blocked by shipping: ${audit.summary.shippingBlockedVariants}`);
  console.log(`Excel report: ${options.output}`);
  console.log(`JSON report: ${options.jsonOutput}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
