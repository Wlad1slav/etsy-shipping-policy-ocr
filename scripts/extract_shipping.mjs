#!/usr/bin/env node

import { execFile } from "node:child_process";
import ExcelJS from "exceljs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { makeUniqueSheetNames, parseScreenshot } from "./shipping_parser.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(scriptDirectory);
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".heic", ".tif", ".tiff"]);

function parseArguments(argv) {
  const options = {
    input: path.join(projectDirectory, "screenshots"),
    output: path.join(projectDirectory, "outputs", "shipping_policies.xlsx"),
    keepOcr: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--input") options.input = path.resolve(argv[++index]);
    else if (argument === "--output") options.output = path.resolve(argv[++index]);
    else if (argument === "--keep-ocr") options.keepOcr = true;
    else if (argument === "--help" || argument === "-h") {
      console.log(`Usage: node scripts/extract_shipping.mjs [options]\n\nOptions:\n  --input <dir>    Screenshot root (default: screenshots)\n  --output <file>  Output .xlsx file (default: outputs/shipping_policies.xlsx)\n  --keep-ocr       Save raw OCR JSON beside the workbook\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (path.extname(options.output).toLowerCase() !== ".xlsx") {
    throw new Error("--output must end in .xlsx");
  }
  return options;
}

async function findImages(directory) {
  const images = [];
  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && imageExtensions.has(path.extname(entry.name).toLowerCase())) images.push(entryPath);
    }
  }
  await visit(directory);
  return images;
}

async function runOcr(imagePaths) {
  if (process.platform !== "darwin") {
    throw new Error("OCR currently requires macOS because it uses Apple's Vision framework.");
  }
  const buildDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "etsy-shipping-ocr-"));
  const binaryPath = path.join(buildDirectory, "vision_ocr");
  const sourcePath = path.join(scriptDirectory, "vision_ocr.swift");
  await execFileAsync("swiftc", [sourcePath, "-O", "-o", binaryPath], { maxBuffer: 10 * 1024 * 1024 });
  const { stdout } = await execFileAsync(binaryPath, imagePaths, { maxBuffer: 100 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function displayOcrStatus(value) {
  if (value === "OK") return "OK";
  const missing = value.replace(/^Review:\s*missing\s*/, "").split(", ");
  if (missing.includes("charge type") && missing.includes("one-item price") && missing.includes("additional-item price")) {
    return "Review: screenshot block is cropped";
  }
  if (missing.includes("one-item price") && missing.includes("additional-item price")) {
    return "Review: both prices are missing";
  }
  return "Review OCR";
}

async function createWorkbook(screenshots, outputPath) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Etsy Shipping Policy OCR";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;
  const sheetNames = makeUniqueSheetNames(screenshots);

  for (let index = 0; index < screenshots.length; index += 1) {
    const screenshot = screenshots[index];
    const sheet = workbook.addWorksheet(sheetNames[index], {
      views: [{ state: "frozen", ySplit: 6, showGridLines: false }],
      pageSetup: {
        orientation: "landscape",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
      },
    });

    sheet.mergeCells("A1:H1");
    sheet.getCell("A1").value = `Etsy shipping policy - ${screenshot.sku}`;
    sheet.getCell("A1").font = { name: "Aptos Display", bold: true, color: { argb: "FFFFFFFF" }, size: 16 };
    sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1641E" } };
    sheet.getCell("A1").alignment = { vertical: "middle", horizontal: "left" };
    sheet.getRow(1).height = 30;

    sheet.getCell("A3").value = "SKU";
    sheet.mergeCells("B3:D3");
    sheet.getCell("B3").value = screenshot.sku;
    sheet.getCell("E3").value = "Source file";
    sheet.mergeCells("F3:H3");
    sheet.getCell("F3").value = screenshot.sourceFile;
    sheet.getCell("A4").value = "Profile";
    sheet.mergeCells("B4:D4");
    sheet.getCell("B4").value = screenshot.profileName || "—";
    sheet.getCell("E4").value = "Ships from";
    sheet.mergeCells("F4:H4");
    const origin = [screenshot.originCountry, screenshot.originPostalCode].filter(Boolean).join(", ");
    sheet.getCell("F4").value = origin || "—";
    for (const address of ["A3", "A4", "E3", "E4"]) {
      sheet.getCell(address).font = { name: "Aptos", bold: true, color: { argb: "FF5A3E36" } };
    }
    for (const address of ["B3", "F3", "B4", "F4"]) {
      sheet.getCell(address).alignment = { vertical: "middle", wrapText: true };
    }

    const headers = [
      "#",
      "Country / region",
      "Shipping service",
      "Delivery estimate",
      "Charge type",
      "One item (USD)",
      "Additional item (USD)",
      "OCR status",
    ];
    const body = screenshot.rows.map((row, rowIndex) => [
      rowIndex + 1,
      row.destination,
      row.shippingService,
      row.deliveryEstimate,
      row.chargeType,
      row.oneItemUsd,
      row.additionalItemUsd,
      displayOcrStatus(row.ocrStatus),
    ]);
    const tableRows = body.length
      ? body
      : [[null, "No data recognized", null, null, null, null, null, "Review"]];
    sheet.addTable({
      name: `ShippingTable${index + 1}`,
      ref: "A6",
      headerRow: true,
      totalsRow: false,
      style: { theme: "TableStyleMedium2", showRowStripes: true },
      columns: headers.map((name) => ({ name })),
      rows: tableRows,
    });

    const lastRow = 6 + tableRows.length;
    for (let rowNumber = 7; rowNumber <= lastRow; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      row.height = 30;
      row.alignment = { vertical: "middle" };
      for (let column = 2; column <= 5; column += 1) row.getCell(column).alignment = { vertical: "middle", wrapText: true };
      row.getCell(8).alignment = { vertical: "middle", wrapText: true };
      row.getCell(1).alignment = { vertical: "middle", horizontal: "center" };
      for (let column = 6; column <= 7; column += 1) {
        row.getCell(column).numFmt = "$#,##0.00";
        row.getCell(column).alignment = { vertical: "middle", horizontal: "right" };
      }
      if (String(row.getCell(8).value).startsWith("Review")) {
        row.height = 38;
        row.getCell(8).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDECEC" } };
        row.getCell(8).font = { name: "Aptos", bold: true, color: { argb: "FFA61B1B" } };
      }
    }
    sheet.getRow(6).height = 32;
    sheet.getRow(6).alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    sheet.columns = [
      { width: 11 },
      { width: 22 },
      { width: 38 },
      { width: 20 },
      { width: 22 },
      { width: 18 },
      { width: 24 },
      { width: 29 },
    ];
    sheet.autoFilter = `A6:H${lastRow}`;
    sheet.headerFooter.oddFooter = `&L${screenshot.sku}&RPage &P of &N`;
    sheet.properties.defaultRowHeight = 18;
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);
  return workbook;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const imagePaths = await findImages(options.input);
  if (!imagePaths.length) throw new Error(`No supported images found under ${options.input}`);

  console.log(`OCR: ${imagePaths.length} screenshot(s)`);
  const rawOcr = await runOcr(imagePaths);
  const screenshots = rawOcr.map((image) => parseScreenshot(image, options.input));
  for (const screenshot of screenshots) {
    console.log(`${screenshot.sku}: ${screenshot.rows.length} shipping block(s)`);
  }

  if (options.keepOcr) {
    const ocrPath = options.output.replace(/\.xlsx$/i, ".ocr.json");
    await fs.mkdir(path.dirname(ocrPath), { recursive: true });
    await fs.writeFile(ocrPath, JSON.stringify(rawOcr, null, 2));
  }

  await createWorkbook(screenshots, options.output);
  console.log(`Saved: ${options.output}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
