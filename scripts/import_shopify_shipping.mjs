#!/usr/bin/env node

import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRatePlan,
  normalizeShopifyId,
  readWorksheetRows,
  warningReportFilename,
} from "./shopify_shipping_importer.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(scriptDirectory);

function usage() {
  return `Usage:
  npm run import:shopify -- --sheet <worksheet> --product-id <Shopify product ID> [options]

Required:
  --sheet <name>          Excel worksheet to import, for example "Desk XL"
  --product-id <id>       Numeric Shopify product ID or gid://shopify/Product/<id>

Options:
  --input <file>          Source workbook (default: outputs/shipping_policies.xlsx)
  --location-id <id>      Shopify fulfillment location ID; auto-selected when the shop has one location
  --profile-name <name>   Delivery profile name (default: Etsy OCR | <product ID> | <worksheet>)
  --warning-dir <dir>     Warning report directory (default: warning)
  --store <store>         Shopify store name or *.myshopify.com domain (default: SHOPIFY_STORE)
  --api-version <version> Shopify Admin API version (default: SHOPIFY_API_VERSION or 2026-07)
  --dry-run               Validate and show the planned operation without changing Shopify (default)
  --apply                 Create or update the delivery profile in Shopify
  --help, -h              Show this help

Authentication:
  SHOPIFY_STORE and SHOPIFY_API_TOKEN are loaded from the environment or .env.
  SHOPIFY_ADMIN_TOKEN is also accepted as a token alias.
`;
}

function requireOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

export function parseArguments(argv) {
  const options = {
    input: path.join(projectDirectory, "outputs", "shipping_policies.xlsx"),
    warningDir: path.join(projectDirectory, "warning"),
    apply: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--sheet") options.sheet = requireOptionValue(argv, index++, argument);
    else if (argument === "--product-id") options.productId = requireOptionValue(argv, index++, argument);
    else if (argument === "--input") options.input = path.resolve(requireOptionValue(argv, index++, argument));
    else if (argument === "--location-id") options.locationId = requireOptionValue(argv, index++, argument);
    else if (argument === "--profile-name") options.profileName = requireOptionValue(argv, index++, argument);
    else if (argument === "--warning-dir") options.warningDir = path.resolve(requireOptionValue(argv, index++, argument));
    else if (argument === "--store") options.store = requireOptionValue(argv, index++, argument);
    else if (argument === "--api-version") options.apiVersion = requireOptionValue(argv, index++, argument);
    else if (argument === "--apply") options.apply = true;
    else if (argument === "--dry-run") options.apply = false;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (!options.help && !options.sheet) throw new Error("--sheet is required.");
  if (!options.help && !options.productId) throw new Error("--product-id is required.");
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
    if (!response.ok) throw new Error(`Shopify returned HTTP ${response.status}: ${formatGraphqlErrors(body.errors ?? []) || "request failed"}`);
    if (body.errors?.length) throw new Error(`Shopify GraphQL error: ${formatGraphqlErrors(body.errors)}`);
    return body.data;
  }
}

async function getShopContext(client) {
  const data = await client.request(`
    query ShopifyShippingImporterContext {
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

async function getProductWithVariants(client, productGid) {
  const variants = [];
  let after = null;
  let product = null;

  do {
    const data = await client.request(
      `query ShopifyShippingImporterProduct($id: ID!, $after: String) {
        product(id: $id) {
          id
          title
          variants(first: 250, after: $after) {
            nodes { id title sku }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { id: productGid, after },
    );
    if (!data.product) return null;
    product = { id: data.product.id, title: data.product.title };
    variants.push(...data.product.variants.nodes);
    after = data.product.variants.pageInfo.hasNextPage ? data.product.variants.pageInfo.endCursor : null;
  } while (after);

  return { ...product, variants };
}

async function getLocations(client) {
  const locations = [];
  let after = null;
  do {
    const data = await client.request(
      `query ShopifyShippingImporterLocations($after: String) {
        locations(first: 250, after: $after) {
          nodes {
            id
            name
            fulfillsOnlineOrders
            address { countryCode zip }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { after },
    );
    locations.push(...data.locations.nodes);
    after = data.locations.pageInfo.hasNextPage ? data.locations.pageInfo.endCursor : null;
  } while (after);
  return locations.filter((location) => location.fulfillsOnlineOrders);
}

async function findProfilesByName(client, profileName) {
  const matches = [];
  let after = null;
  do {
    const data = await client.request(
      `query ShopifyShippingImporterProfiles($after: String) {
        deliveryProfiles(first: 100, after: $after) {
          nodes { id name default }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { after },
    );
    matches.push(...data.deliveryProfiles.nodes.filter((profile) => profile.name === profileName));
    after = data.deliveryProfiles.pageInfo.hasNextPage ? data.deliveryProfiles.pageInfo.endCursor : null;
  } while (after);
  return matches;
}

async function getProfileDetails(client, profileId) {
  const data = await client.request(
    `query ShopifyShippingImporterProfile($id: ID!) {
      deliveryProfile(id: $id) {
        id
        name
        profileLocationGroups {
          locationGroup {
            id
            locations(first: 250) { nodes { id } }
          }
          locationGroupZones(first: 250) {
            nodes { zone { id name } }
          }
        }
      }
    }`,
    { id: profileId },
  );
  return data.deliveryProfile;
}

function checkRequiredScopes(scopes, apply) {
  const requirements = [
    { label: "read_products", accepted: ["read_products", "write_products"] },
    { label: "read_locations", accepted: ["read_locations", "write_locations"] },
    apply
      ? { label: "write_shipping", accepted: ["write_shipping"] }
      : { label: "read_shipping", accepted: ["read_shipping", "write_shipping"] },
  ];
  return requirements
    .filter((requirement) => !requirement.accepted.some((scope) => scopes.has(scope)))
    .map((requirement) => requirement.label);
}

function chooseLocation(locations, requestedLocationId, warnings) {
  if (requestedLocationId) {
    const requested = normalizeShopifyId(requestedLocationId, "Location");
    const location = locations.find((candidate) => candidate.id === requested.gid);
    if (!location) throw new Error(`Shopify location ${requested.gid} was not found among active online-fulfillment locations.`);
    return location;
  }
  if (locations.length === 1) return locations[0];
  if (!locations.length) throw new Error("The shop has no active location that fulfills online orders.");
  warnings.push({
    code: "MULTIPLE_SHOPIFY_LOCATIONS",
    message: "The shop has multiple online-fulfillment locations. No location was selected; rerun with --location-id.",
    locations: locations.map((location) => ({ id: location.id, name: location.name, countryCode: location.address?.countryCode })),
  });
  return null;
}

function buildProfileName(productNumericId, sheetName, override) {
  const name = override || `Etsy OCR | ${productNumericId} | ${sheetName}`;
  return name.length <= 255 ? name : `${name.slice(0, 254).trimEnd()}…`;
}

function createProfileInput({ profileName, variantIds, locationId, zones }) {
  return {
    name: profileName,
    variantsToAssociate: variantIds,
    locationGroupsToCreate: [{ locations: [locationId], zonesToCreate: zones }],
  };
}

function updateProfileInput({ profileName, variantIds, locationId, zones, profileDetails }) {
  const groups = profileDetails.profileLocationGroups;
  if (groups.length > 1) {
    throw new Error(`Existing profile ${profileDetails.id} has ${groups.length} location groups and cannot be safely replaced automatically.`);
  }

  const input = {
    name: profileName,
    variantsToAssociate: variantIds,
    zonesToDelete: groups.flatMap((group) => group.locationGroupZones.nodes.map((entry) => entry.zone.id)),
  };
  if (!groups.length) {
    input.locationGroupsToCreate = [{ locations: [locationId], zonesToCreate: zones }];
    return input;
  }

  const group = groups[0];
  const currentLocationIds = group.locationGroup.locations.nodes.map((location) => location.id);
  const groupUpdate = { id: group.locationGroup.id, zonesToCreate: zones };
  if (!currentLocationIds.includes(locationId)) groupUpdate.locationsToAdd = [locationId];
  const locationsToRemove = currentLocationIds.filter((id) => id !== locationId);
  if (locationsToRemove.length) groupUpdate.locationsToRemove = locationsToRemove;
  input.locationGroupsToUpdate = [groupUpdate];
  return input;
}

function getUserErrors(payload, fieldName) {
  const errors = payload[fieldName].userErrors ?? [];
  if (!errors.length) return [];
  return errors.map((error) => ({ field: error.field, message: error.message }));
}

async function createProfile(client, profile) {
  const data = await client.request(
    `mutation ShopifyShippingImporterCreate($profile: DeliveryProfileInput!) {
      deliveryProfileCreate(profile: $profile) {
        profile { id name }
        userErrors { field message }
      }
    }`,
    { profile },
  );
  const userErrors = getUserErrors(data, "deliveryProfileCreate");
  return { profile: data.deliveryProfileCreate.profile, userErrors };
}

async function updateProfile(client, id, profile) {
  const data = await client.request(
    `mutation ShopifyShippingImporterUpdate($id: ID!, $profile: DeliveryProfileInput!) {
      deliveryProfileUpdate(id: $id, profile: $profile) {
        profile { id name }
        userErrors { field message }
      }
    }`,
    { id, profile },
  );
  const userErrors = getUserErrors(data, "deliveryProfileUpdate");
  return { profile: data.deliveryProfileUpdate.profile, userErrors };
}

async function writeWarningReport(filePath, report) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  await loadLocalEnv();
  const productId = normalizeShopifyId(options.productId, "Product");
  const warningPath = path.join(options.warningDir, warningReportFilename(productId.numericId, options.sheet));
  const warnings = [];
  const report = {
    generatedAt: new Date().toISOString(),
    mode: options.apply ? "apply" : "dry-run",
    input: options.input,
    sheet: options.sheet,
    productId: productId.gid,
    selectionPolicy: "For duplicate destinations, the first worksheet row and its One item (USD) price win.",
    flatRateSource: "One item (USD)",
    warnings,
  };

  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(options.input);
    const rows = readWorksheetRows(workbook, options.sheet);
    const ratePlan = buildRatePlan(rows, { sheetName: options.sheet, currencyCode: "USD" });
    warnings.push(...ratePlan.warnings);
    report.workbook = ratePlan.stats;

    if (!ratePlan.zones.length) throw new Error("No valid Shopify shipping zones could be built from the selected worksheet.");

    const store = normalizeStore(options.store || process.env.SHOPIFY_STORE);
    const token = process.env.SHOPIFY_API_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN;
    if (!token) throw new Error("SHOPIFY_API_TOKEN is missing. Add it to .env or the process environment.");
    const apiVersion = options.apiVersion || process.env.SHOPIFY_API_VERSION || "2026-07";
    if (!/^\d{4}-(01|04|07|10)$/.test(apiVersion)) throw new Error(`Invalid Shopify API version: ${apiVersion}`);
    const client = new ShopifyClient({ store, token, apiVersion });

    const context = await getShopContext(client);
    report.shop = {
      name: context.shop.name,
      domain: context.shop.myshopifyDomain,
      currencyCode: context.shop.currencyCode,
      apiVersion,
    };
    const missingScopes = checkRequiredScopes(context.scopes, options.apply);
    if (missingScopes.length) throw new Error(`The Shopify token is missing required scopes: ${missingScopes.join(", ")}`);
    if (context.shop.currencyCode !== "USD") {
      throw new Error(`The workbook contains USD rates, but the Shopify store currency is ${context.shop.currencyCode}. Automatic currency conversion is intentionally disabled.`);
    }

    const [product, locations] = await Promise.all([
      getProductWithVariants(client, productId.gid),
      getLocations(client),
    ]);
    if (!product) throw new Error(`Shopify product ${productId.gid} was not found.`);
    if (!product.variants.length) throw new Error(`Shopify product ${productId.gid} has no variants to associate.`);
    const location = chooseLocation(locations, options.locationId, warnings);
    if (!location) throw new Error("A Shopify location must be selected before this import can continue.");

    const profileName = buildProfileName(productId.numericId, options.sheet, options.profileName);
    const matchingProfiles = await findProfilesByName(client, profileName);
    if (matchingProfiles.length > 1) {
      warnings.push({
        code: "DUPLICATE_DELIVERY_PROFILE_NAME",
        message: `More than one Shopify delivery profile is named "${profileName}"; no profile was selected.`,
        profiles: matchingProfiles,
      });
      throw new Error(`Multiple Shopify delivery profiles are named "${profileName}".`);
    }

    const existingProfile = matchingProfiles[0] ?? null;
    let profileDetails = null;
    if (existingProfile) {
      profileDetails = await getProfileDetails(client, existingProfile.id);
      if (profileDetails.profileLocationGroups.length > 1) {
        warnings.push({
          code: "MULTIPLE_PROFILE_LOCATION_GROUPS",
          message: "The existing delivery profile has multiple location groups and cannot be safely replaced automatically.",
          profileId: profileDetails.id,
          locationGroupIds: profileDetails.profileLocationGroups.map((group) => group.locationGroup.id),
        });
        throw new Error(`Existing profile ${profileDetails.id} has multiple location groups.`);
      }
    }

    const operation = existingProfile ? "update" : "create";
    report.plan = {
      operation,
      profileName,
      existingProfileId: existingProfile?.id ?? null,
      product: {
        id: product.id,
        title: product.title,
        variants: product.variants,
      },
      location,
      zones: ratePlan.zones.map((zone) => ({
        name: zone.name,
        countries: zone.countries,
        rate: zone.methodDefinitionsToCreate[0].rateDefinition.price,
        methodName: zone.methodDefinitionsToCreate[0].name,
      })),
    };

    if (!options.apply) {
      report.result = { changedShopify: false, message: "Dry run completed. Use --apply to perform this plan." };
    } else {
      const common = {
        profileName,
        variantIds: product.variants.map((variant) => variant.id),
        locationId: location.id,
        zones: ratePlan.zones,
      };
      const result = existingProfile
        ? await updateProfile(client, existingProfile.id, updateProfileInput({ ...common, profileDetails }))
        : await createProfile(client, createProfileInput(common));
      if (result.userErrors.length) {
        warnings.push({
          code: "SHOPIFY_USER_ERRORS",
          message: "Shopify rejected the delivery profile mutation.",
          errors: result.userErrors,
        });
        throw new Error(`Shopify rejected the ${operation}: ${result.userErrors.map((error) => error.message).join("; ")}`);
      }
      report.result = {
        changedShopify: true,
        operation,
        profile: result.profile,
      };
    }

    report.summary = {
      warnings: warnings.length,
      zonesPrepared: ratePlan.zones.length,
      variantsAssociated: product.variants.length,
    };
    await writeWarningReport(warningPath, report);

    console.log(`${options.apply ? "Applied" : "Dry run"}: ${operation} delivery profile`);
    console.log(`Product: ${product.title} (${product.id}), ${product.variants.length} variant(s)`);
    console.log(`Worksheet: ${options.sheet}, ${ratePlan.zones.length} zone(s)`);
    console.log(`Location: ${location.name} (${location.id})`);
    console.log(`Warnings: ${warnings.length}`);
    console.log(`Report: ${warningPath}`);
    if (!options.apply) console.log("No Shopify data was changed. Add --apply to execute this plan.");
  } catch (error) {
    warnings.push({ code: "IMPORT_FAILED", message: error.message });
    report.result = { changedShopify: false, error: error.message };
    report.summary = { warnings: warnings.length };
    await writeWarningReport(warningPath, report);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
