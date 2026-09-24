const REQUIRED_HEADERS = [
  "Country / region",
  "Shipping service",
  "Delivery estimate",
  "Charge type",
  "One item (USD)",
  "Additional item (USD)",
  "OCR status",
];

const COUNTRY_CODES = new Map(
  [
    ["Albania", "AL"],
    ["Armenia", "AM"],
    ["Australia", "AU"],
    ["Austria", "AT"],
    ["Belgium", "BE"],
    ["Bulgaria", "BG"],
    ["Canada", "CA"],
    ["Croatia", "HR"],
    ["Cyprus", "CY"],
    ["Czech Republic", "CZ"],
    ["Czechia", "CZ"],
    ["Denmark", "DK"],
    ["Estonia", "EE"],
    ["Finland", "FI"],
    ["France", "FR"],
    ["Georgia", "GE"],
    ["Germany", "DE"],
    ["Greece", "GR"],
    ["Hong Kong", "HK"],
    ["Hungary", "HU"],
    ["Iceland", "IS"],
    ["India", "IN"],
    ["Ireland", "IE"],
    ["Italy", "IT"],
    ["Japan", "JP"],
    ["Latvia", "LV"],
    ["Lithuania", "LT"],
    ["Luxembourg", "LU"],
    ["Malta", "MT"],
    ["Moldova", "MD"],
    ["Moldova, Republic of", "MD"],
    ["Monaco", "MC"],
    ["Netherlands", "NL"],
    ["The Netherlands", "NL"],
    ["New Zealand", "NZ"],
    ["Norway", "NO"],
    ["Poland", "PL"],
    ["Portugal", "PT"],
    ["Romania", "RO"],
    ["Singapore", "SG"],
    ["South Korea", "KR"],
    ["Korea, Republic of", "KR"],
    ["Spain", "ES"],
    ["Sweden", "SE"],
    ["Switzerland", "CH"],
    ["Turkey", "TR"],
    ["Türkiye", "TR"],
    ["Ukraine", "UA"],
    ["United Kingdom", "GB"],
    ["United States", "US"],
    ["United States of America", "US"],
  ].map(([name, code]) => [normalizeKey(name), code]),
);

const PROVINCE_DESTINATIONS = new Map(
  [
    ["Puerto Rico", { countryCode: "US", provinceCode: "PR" }],
  ].map(([name, destination]) => [normalizeKey(name), destination]),
);

const COUNTRY_PROVINCE_CODES = new Map([
  [
    "US",
    [
      "AA",
      "AE",
      "AK",
      "AL",
      "AP",
      "AR",
      "AS",
      "AZ",
      "CA",
      "CO",
      "CT",
      "DC",
      "DE",
      "FL",
      "FM",
      "GA",
      "GU",
      "HI",
      "IA",
      "ID",
      "IL",
      "IN",
      "KS",
      "KY",
      "LA",
      "MA",
      "MD",
      "ME",
      "MH",
      "MI",
      "MN",
      "MO",
      "MP",
      "MS",
      "MT",
      "NC",
      "ND",
      "NE",
      "NH",
      "NJ",
      "NM",
      "NV",
      "NY",
      "OH",
      "OK",
      "OR",
      "PA",
      "PR",
      "PW",
      "RI",
      "SC",
      "SD",
      "TN",
      "TX",
      "UT",
      "VA",
      "VI",
      "VT",
      "WA",
      "WI",
      "WV",
      "WY",
    ],
  ],
]);

export const EUROPEAN_UNION_CODES = Object.freeze([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
]);

export const EUROPE_NON_EU_CODES = Object.freeze([
  "AD",
  "AL",
  "AM",
  "AZ",
  "BA",
  "BY",
  "CH",
  "FO",
  "GB",
  "GE",
  "GI",
  "GG",
  "IS",
  "IM",
  "JE",
  "LI",
  "MC",
  "MD",
  "ME",
  "MK",
  "NO",
  "RS",
  "RU",
  "SM",
  "TR",
  "UA",
  "VA",
  "XK",
]);

function normalizeKey(value = "") {
  return String(value)
    .normalize("NFKC")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en");
}

function valueAsText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if ("result" in value) return valueAsText(value.result);
    if ("text" in value) return valueAsText(value.text);
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text ?? "").join("");
  }
  return String(value).replace(/\s+/g, " ").trim();
}

function valueAsMoney(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = valueAsText(value).replace(/[^0-9,.-]/g, "");
  if (!text) return null;
  const normalized = text.replace(/(?<=\d),(?=\d{1,2}$)/, ".").replace(/,/g, "");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function warningRow(row) {
  return {
    row: row.rowNumber,
    destination: row.destination,
    shippingService: row.shippingService,
    deliveryEstimate: row.deliveryEstimate,
    chargeType: row.chargeType,
    oneItemUsd: row.oneItemUsd,
    additionalItemUsd: row.additionalItemUsd,
    ocrStatus: row.ocrStatus,
  };
}

function truncate(value, maxLength) {
  const text = String(value ?? "").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function rateMethod(row, sheetName, currencyCode) {
  const service = row.shippingService || "Shipping";
  const estimate = row.deliveryEstimate ? ` (${row.deliveryEstimate})` : "";
  return {
    name: truncate(`${service}${estimate}`, 255),
    description: truncate(
      `Flat rate imported from worksheet "${sheetName}". Source column: One item (USD).`,
      255,
    ),
    active: true,
    rateDefinition: {
      price: {
        amount: row.oneItemUsd.toFixed(2),
        currencyCode,
      },
    },
  };
}

function destinationType(destination) {
  const key = normalizeKey(destination);
  if (key === "european union") return { type: "region", codes: EUROPEAN_UNION_CODES };
  if (key === "europe non-eu") return { type: "region", codes: EUROPE_NON_EU_CODES };
  if (key === "everywhere else") return { type: "restOfWorld" };
  const province = PROVINCE_DESTINATIONS.get(key);
  if (province) return { type: "province", ...province };
  const code = COUNTRY_CODES.get(key);
  return code ? { type: "country", code } : { type: "unknown" };
}

export function readWorksheetRows(workbook, sheetName) {
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) {
    const available = workbook.worksheets.map((sheet) => sheet.name).join(", ");
    throw new Error(`Worksheet "${sheetName}" was not found. Available worksheets: ${available}`);
  }

  let headerRowNumber = null;
  let headerColumns = null;
  const lastCandidateRow = Math.min(worksheet.rowCount, 50);

  for (let rowNumber = 1; rowNumber <= lastCandidateRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const columns = new Map();
    for (let columnNumber = 1; columnNumber <= row.cellCount; columnNumber += 1) {
      const text = valueAsText(row.getCell(columnNumber).value);
      if (REQUIRED_HEADERS.includes(text)) columns.set(text, columnNumber);
    }
    if (REQUIRED_HEADERS.every((header) => columns.has(header))) {
      headerRowNumber = rowNumber;
      headerColumns = columns;
      break;
    }
  }

  if (!headerColumns) {
    throw new Error(
      `Worksheet "${sheetName}" does not contain the expected shipping table headers: ${REQUIRED_HEADERS.join(", ")}`,
    );
  }

  const rows = [];
  for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const get = (header) => worksheet.getRow(rowNumber).getCell(headerColumns.get(header)).value;
    const destination = valueAsText(get("Country / region"));
    if (!destination || normalizeKey(destination) === "no data recognized") continue;
    rows.push({
      rowNumber,
      destination,
      shippingService: valueAsText(get("Shipping service")),
      deliveryEstimate: valueAsText(get("Delivery estimate")),
      chargeType: valueAsText(get("Charge type")),
      oneItemUsd: valueAsMoney(get("One item (USD)")),
      additionalItemUsd: valueAsMoney(get("Additional item (USD)")),
      ocrStatus: valueAsText(get("OCR status")),
    });
  }

  return rows;
}

export function buildRatePlan(rows, { sheetName, currencyCode = "USD" }) {
  const warnings = [];
  const destinationGroups = new Map();

  for (const row of rows) {
    const key = normalizeKey(row.destination);
    if (!destinationGroups.has(key)) destinationGroups.set(key, []);
    destinationGroups.get(key).push(row);
  }

  const selectedRows = [];
  for (const alternatives of destinationGroups.values()) {
    const selected = alternatives[0];
    selectedRows.push(selected);
    if (alternatives.length > 1) {
      warnings.push({
        code: "DUPLICATE_DESTINATION",
        message: `Multiple prices were found for ${selected.destination}; the first worksheet row was selected.`,
        destination: selected.destination,
        selected: warningRow(selected),
        ignored: alternatives.slice(1).map(warningRow),
      });
    }
  }
  selectedRows.sort((left, right) => left.rowNumber - right.rowNumber);

  const validRows = [];
  for (const selectedRow of selectedRows) {
    let row = selectedRow;
    if (row.ocrStatus && normalizeKey(row.ocrStatus) !== "ok") {
      warnings.push({
        code: "OCR_REVIEW",
        message: `Row ${row.rowNumber} is marked for OCR review.`,
        selected: warningRow(row),
      });
    }

    if ((!Number.isFinite(row.oneItemUsd) || row.oneItemUsd < 0) && normalizeKey(row.chargeType) === "free shipping") {
      row = { ...row, oneItemUsd: 0 };
      warnings.push({
        code: "FREE_SHIPPING_PRICE_INFERRED",
        message: `Row ${row.rowNumber} is free shipping, so its missing flat price was set to 0.`,
        selected: warningRow(row),
      });
    }

    if (!Number.isFinite(row.oneItemUsd) || row.oneItemUsd < 0) {
      warnings.push({
        code: "INVALID_FIRST_ITEM_PRICE",
        message: `Row ${row.rowNumber} has no valid One item (USD) price and was skipped.`,
        skipped: warningRow(row),
      });
      continue;
    }

    const destination = destinationType(row.destination);
    if (destination.type === "unknown") {
      warnings.push({
        code: "UNKNOWN_DESTINATION",
        message: `Destination "${row.destination}" cannot be mapped to a Shopify country and was skipped.`,
        skipped: warningRow(row),
      });
      continue;
    }

    if (!row.shippingService) {
      warnings.push({
        code: "MISSING_SHIPPING_SERVICE",
        message: `Row ${row.rowNumber} has no shipping service; the checkout label "Shipping" will be used.`,
        selected: warningRow(row),
      });
    }

    validRows.push({ row, destination });
  }

  const explicitCountriesByCode = new Map();
  const explicitProvincesByCode = new Map();
  const regionRows = [];
  for (const entry of validRows) {
    if (entry.destination.type === "province") {
      const code = `${entry.destination.countryCode}:${entry.destination.provinceCode}`;
      const previous = explicitProvincesByCode.get(code);
      if (!previous) {
        explicitProvincesByCode.set(code, entry);
        continue;
      }
      warnings.push({
        code: "PROVINCE_CODE_COLLISION",
        message: `${entry.row.destination} maps to the same Shopify province as ${previous.row.destination}; the first worksheet row was selected.`,
        countryCode: entry.destination.countryCode,
        provinceCode: entry.destination.provinceCode,
        selected: warningRow(previous.row),
        ignored: [warningRow(entry.row)],
      });
      continue;
    }
    if (entry.destination.type !== "country") {
      regionRows.push(entry);
      continue;
    }
    const previous = explicitCountriesByCode.get(entry.destination.code);
    if (!previous) {
      explicitCountriesByCode.set(entry.destination.code, entry);
      continue;
    }
    warnings.push({
      code: "COUNTRY_CODE_COLLISION",
      message: `${entry.row.destination} maps to the same Shopify country as ${previous.row.destination}; the first worksheet row was selected.`,
      countryCode: entry.destination.code,
      selected: warningRow(previous.row),
      ignored: [warningRow(entry.row)],
    });
  }

  const explicitCodes = new Set(explicitCountriesByCode.keys());
  const excludedProvincesByCountry = new Map();
  for (const entry of explicitProvincesByCode.values()) {
    const { countryCode, provinceCode } = entry.destination;
    if (!excludedProvincesByCountry.has(countryCode)) {
      excludedProvincesByCountry.set(countryCode, new Set());
    }
    excludedProvincesByCountry.get(countryCode).add(provinceCode);
  }
  const zoneEntries = [
    ...explicitCountriesByCode.values(),
    ...explicitProvincesByCode.values(),
    ...regionRows,
  ].sort((left, right) => left.row.rowNumber - right.row.rowNumber);

  const zones = [];
  for (const { row, destination } of zoneEntries) {
    let countries;
    if (destination.type === "country") {
      const excludedProvinces = excludedProvincesByCountry.get(destination.code);
      if (!excludedProvinces?.size) {
        countries = [{ code: destination.code, includeAllProvinces: true }];
      } else {
        const provinceCodes = COUNTRY_PROVINCE_CODES.get(destination.code);
        if (!provinceCodes) {
          throw new Error(
            `Cannot separate province-specific rates from ${row.destination}: no Shopify province list is configured for ${destination.code}.`,
          );
        }
        countries = [{
          code: destination.code,
          provinces: provinceCodes
            .filter((code) => !excludedProvinces.has(code))
            .map((code) => ({ code })),
        }];
      }
    } else if (destination.type === "province") {
      countries = [{
        code: destination.countryCode,
        provinces: [{ code: destination.provinceCode }],
      }];
    } else if (destination.type === "restOfWorld") {
      countries = [{ restOfWorld: true }];
    } else {
      const codes = destination.codes.filter((code) => !explicitCodes.has(code));
      if (!codes.length) {
        warnings.push({
          code: "EMPTY_REGION",
          message: `All countries in ${row.destination} are already covered by explicit country rows; the region was skipped.`,
          skipped: warningRow(row),
        });
        continue;
      }
      countries = codes.map((code) => ({ code, includeAllProvinces: true }));
    }

    zones.push({
      name: truncate(row.destination, 255),
      countries,
      methodDefinitionsToCreate: [rateMethod(row, sheetName, currencyCode)],
    });
  }

  return {
    zones,
    warnings,
    stats: {
      worksheetRows: rows.length,
      selectedDestinationRows: selectedRows.length,
      zonesPrepared: zones.length,
      warnings: warnings.length,
    },
  };
}

export function normalizeShopifyId(value, resourceName) {
  const text = String(value ?? "").trim();
  if (/^\d+$/.test(text)) {
    return { gid: `gid://shopify/${resourceName}/${text}`, numericId: text };
  }
  const match = text.match(new RegExp(`^gid://shopify/${resourceName}/(\\d+)$`, "i"));
  if (!match) {
    throw new Error(`Expected a numeric ${resourceName} ID or gid://shopify/${resourceName}/<id>, received "${text}".`);
  }
  return { gid: `gid://shopify/${resourceName}/${match[1]}`, numericId: match[1] };
}

export function warningReportFilename(productNumericId, sheetName) {
  const safeSheet = String(sheetName)
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120) || "worksheet";
  return `${productNumericId}_${safeSheet}.json`;
}
