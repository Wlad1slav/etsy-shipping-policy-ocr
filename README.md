# Etsy Shipping Policy OCR

Etsy Shipping Policy OCR is a macOS command-line tool that converts screenshots of Etsy shipping profiles into a structured Excel workbook. It is useful for auditing delivery settings, comparing shipping prices between products, keeping backups, or moving policy data into another system.

The tool processes long scrolling screenshots locally with Apple Vision OCR. Every screenshot becomes a separate Excel worksheet, while the parent directory name is used as the SKU or product name.

## What it extracts

For each destination shown in an Etsy shipping profile, the tool extracts:

- country or region;
- shipping service;
- estimated delivery time;
- charge type;
- shipping price for one item in USD;
- shipping price for each additional item in USD.

Prices are stored as numeric Excel values, so they can be filtered, sorted, and used in calculations.

## Requirements

- macOS with Apple Vision and the `swiftc` command;
- Node.js 20 or newer;
- npm.

OCR currently requires macOS because the project uses Apple's built-in Vision framework. Screenshot processing is local; images are not uploaded to an external OCR service.

## Installation

```bash
git clone <repository-url>
cd <repository-directory>
npm install
```

## Preparing screenshots

1. Open Etsy Shop Manager and navigate to the shipping profile you want to export.
2. Open the profile in edit mode so that destination countries, shipping services, delivery estimates, and prices are visible.
3. Capture a full-page or scrolling screenshot of the profile. Mobile Chrome's long-screenshot feature works well with the current layout.
4. Keep the entire form width visible. Do not crop out country names or the price fields.
5. Use the browser's default zoom level when possible and close pop-ups, menus, or other overlays before capturing.
6. If the page is too long for one image, create several screenshots with a small overlap. Try to avoid cutting a destination block in the middle.

Supported image formats are JPEG, PNG, HEIC, and TIFF.

## Organizing screenshots

Create one directory per SKU or product under `screenshots/`. The directory name becomes the SKU shown in the workbook and the base worksheet name. Image filenames can be arbitrary.

```text
screenshots/
├── Desk XL/
│   └── shipping-profile.jpg
├── Step Stools/
│   ├── shipping-profile-part-1.jpg
│   └── shipping-profile-part-2.jpg
└── Vanity Table/
    └── shipping-profile.png
```

Every screenshot becomes a separate worksheet. When a directory contains multiple screenshots, worksheet names receive suffixes such as `Step Stools (2)` because Excel requires unique worksheet names.

## Usage

Process the default `screenshots/` directory:

```bash
npm run extract
```

The workbook is written to:

```text
outputs/shipping_policies.xlsx
```

Use custom input and output paths:

```bash
npm run extract -- \
  --input ./screenshots \
  --output ./outputs/shipping_policies.xlsx
```

Save the raw OCR response next to the workbook for troubleshooting:

```bash
npm run extract -- --keep-ocr
```

View all available options:

```bash
npm run extract -- --help
```

## Workbook structure

Each worksheet contains profile metadata followed by a filterable table with these columns:

| Column | Description |
| --- | --- |
| `#` | Destination block number in the screenshot |
| `Country / region` | Shipping destination |
| `Shipping service` | Carrier or Etsy shipping service |
| `Delivery estimate` | Estimated delivery time shown by Etsy |
| `Charge type` | Fixed price or free shipping |
| `One item (USD)` | Shipping price for the first item |
| `Additional item (USD)` | Shipping price for each additional item |
| `OCR status` | Recognition status or a review warning |

Rows that cannot be fully recognized are preserved and highlighted with a `Review` status. This commonly happens when a screenshot starts or ends in the middle of a destination block. The tool does not invent missing prices.

## Tests

Run the parser tests with:

```bash
npm test
```

## Limitations

- Recognition is optimized for Etsy's current shipping-profile layout and may need adjustments if Etsy changes the interface.
- Blurry, heavily compressed, zoomed, or partially cropped screenshots can reduce OCR accuracy.
- Review highlighted rows before using the workbook for operational updates.
