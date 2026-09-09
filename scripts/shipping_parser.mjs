import path from "node:path";

const normalizeText = (value = "") =>
  value
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const lineCenterY = (line) => line.y + line.height / 2;

function countryForAnchor(lines, anchor) {
  return lines
    .filter(
      (line) =>
        line.x >= 150 &&
        line.x < 420 &&
        Math.abs(lineCenterY(line) - lineCenterY(anchor)) < 45,
    )
    .sort(
      (left, right) =>
        Math.abs(lineCenterY(left) - lineCenterY(anchor)) -
        Math.abs(lineCenterY(right) - lineCenterY(anchor)),
    )[0];
}

function serviceForAnchor(lines, anchor, blockEnd) {
  const candidates = lines.filter(
    (line) =>
      line.x > 430 &&
      line.x < 1050 &&
      line.y > anchor.y + 15 &&
      line.y < Math.min(blockEnd, anchor.y + 125) &&
      line.text.length >= 8 &&
      !/shipping service|what you.*charge|delivery time/i.test(line.text),
  );

  return candidates.sort((left, right) => {
    const preferred = (line) =>
      /business days|ukrposhta|ups|international|other/i.test(line.text) ? 1 : 0;
    return (
      preferred(right) - preferred(left) ||
      right.text.length - left.text.length ||
      left.y - right.y
    );
  })[0];
}

function cleanService(rawService) {
  const raw = normalizeText(rawService).replace(/[\s~→•=–—-]+$/, "").trim();
  const deliveryMatch = raw.match(/(\d+)\s*[-–]\s*(\d+)\s+business days/i);
  const deliveryEstimate = deliveryMatch
    ? `${deliveryMatch[1]}–${deliveryMatch[2]} business days`
    : "";
  const service = raw
    .replace(/\s*\([^)]*business days[^)]*\)?\s*$/i, "")
    .replace(/\s+$/, "")
    .trim();

  return { service, deliveryEstimate };
}

function parseMoney(rawValue) {
  const normalized = normalizeText(rawValue)
    .replace(/[^0-9,.-]/g, "")
    .replace(/(?<=\d)[,.](?=\d{2}$)/, ".");
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : null;
}

function findMetadataValue(lines, labelPattern) {
  const label = lines.find((line) => line.x < 430 && labelPattern.test(line.text));
  if (!label) return "";

  return (
    lines
      .filter(
        (line) =>
          line.x > 430 &&
          line.x < 1050 &&
          line.y >= label.y - 15 &&
          line.y <= label.y + 65 &&
          line.text.length > 1,
      )
      .sort((left, right) => Math.abs(left.y - label.y) - Math.abs(right.y - label.y))[0]
      ?.text ?? ""
  );
}

export function parseScreenshot(ocrImage, inputDirectory) {
  const lines = ocrImage.lines
    .map((line) => ({ ...line, text: normalizeText(line.text) }))
    .sort((left, right) => left.y - right.y || left.x - right.x);

  const allAnchors = lines.filter(
    (line) => line.x > 430 && /shipping service/i.test(line.text),
  );
  const rows = [];

  for (const anchor of allAnchors) {
    const countryLine = countryForAnchor(lines, anchor);
    if (!countryLine) continue; // Shipping-upgrade rows have no destination country.

    const nextAnchor = allAnchors.find((candidate) => candidate.y > anchor.y + 20);
    const blockEnd = nextAnchor?.y ?? anchor.y + 520;
    const serviceLine = serviceForAnchor(lines, anchor, blockEnd);
    const { service, deliveryEstimate } = cleanService(serviceLine?.text ?? "");
    const chargeLine = lines.find(
      (line) =>
        line.x > 430 &&
        line.y > anchor.y &&
        line.y < blockEnd &&
        /(free shipping|fixed price)/i.test(line.text),
    );
    const priceLines = lines
      .filter(
        (line) =>
          line.x > 430 &&
          line.x < 1050 &&
          line.y > anchor.y &&
          line.y < blockEnd &&
          /US\s*[$S]/i.test(line.text),
      )
      .sort((left, right) => left.x - right.x);

    const isFree = /free shipping/i.test(chargeLine?.text ?? "");
    const oneItemLine = priceLines.find((line) => line.x < 650);
    const additionalItemLine = priceLines.find((line) => line.x >= 650);
    const row = {
      destination: countryLine.text,
      shippingService: service,
      deliveryEstimate,
      chargeType: isFree
        ? "Free shipping"
        : /fixed price/i.test(chargeLine?.text ?? "")
          ? "Fixed price"
          : "",
      oneItemUsd: isFree ? 0 : parseMoney(oneItemLine?.text ?? ""),
      additionalItemUsd: isFree ? 0 : parseMoney(additionalItemLine?.text ?? ""),
      sourceY: Math.round(anchor.y),
    };

    const missing = [];
    if (!row.shippingService) missing.push("service");
    if (!row.chargeType) missing.push("charge type");
    if (!isFree && row.oneItemUsd === null) missing.push("one-item price");
    if (!isFree && row.additionalItemUsd === null) missing.push("additional-item price");
    row.ocrStatus = missing.length ? `Review: missing ${missing.join(", ")}` : "OK";
    rows.push(row);
  }

  const relativePath = path.relative(inputDirectory, ocrImage.path);
  const relativeParts = relativePath.split(path.sep);
  const directorySku = relativeParts.length > 1 ? relativeParts[0] : path.basename(relativePath, path.extname(relativePath));
  const sku = directorySku.normalize("NFC").trim();

  return {
    sku,
    sourcePath: ocrImage.path,
    sourceFile: path.basename(ocrImage.path),
    profileName: findMetadataValue(lines, /profile name/i),
    originCountry: findMetadataValue(lines, /ship from country/i),
    originPostalCode: findMetadataValue(lines, /origin postal code/i),
    pixelWidth: ocrImage.pixelWidth,
    pixelHeight: ocrImage.pixelHeight,
    rows,
  };
}

export function makeUniqueSheetNames(screenshots) {
  const counts = new Map();
  const used = new Set();

  return screenshots.map((screenshot) => {
    const safeBase = screenshot.sku
      .replace(/[\\/?*:[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 31) || "Screenshot";
    const count = (counts.get(safeBase) ?? 0) + 1;
    counts.set(safeBase, count);
    let candidate = count === 1 ? safeBase : `${safeBase.slice(0, 27)} (${count})`;
    let suffix = count;
    while (used.has(candidate.toLocaleLowerCase())) {
      suffix += 1;
      candidate = `${safeBase.slice(0, 27)} (${suffix})`;
    }
    used.add(candidate.toLocaleLowerCase());
    return candidate;
  });
}

