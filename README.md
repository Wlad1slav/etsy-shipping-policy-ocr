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

## Importing flat shipping rates into Shopify

The Shopify importer reads one worksheet from `outputs/shipping_policies.xlsx`, creates or updates a Shopify delivery profile, and associates every variant of the selected Shopify product with that profile.

The importer intentionally creates **flat rates**. For each destination it uses the value from `One item (USD)`. The Etsy value in `Additional item (USD)` is not imported and does not affect the Shopify checkout rate.

### Shopify API setup

Create or configure a Shopify custom app with these Admin API scopes:

```text
read_products
read_locations
read_shipping
write_shipping
```

Copy `.env.example` to `.env` and fill in the store and Admin API access token:

```bash
cp .env.example .env
```

```dotenv
SHOPIFY_STORE=your-store.myshopify.com
SHOPIFY_API_TOKEN=shpat_your_admin_api_access_token
SHOPIFY_API_VERSION=2026-07
```

`SHOPIFY_STORE` can also be the short store name, such as `your-store`; the importer adds `.myshopify.com` automatically. Keep the real `shpat_...` token only in `.env`. The file is excluded from Git.

The workbook stores rates in USD. To prevent unintended conversions, the importer stops if the Shopify store currency is not USD.

### Dry run

Pass the exact worksheet name and a Shopify **product ID**, not a variant ID:

```bash
npm run import:shopify -- \
  --sheet "Desk XL" \
  --product-id 1234567890123
```

A numeric ID and a full GraphQL ID are both accepted:

```bash
npm run import:shopify -- \
  --sheet "Desk XL" \
  --product-id "gid://shopify/Product/1234567890123"
```

Dry-run mode is the default. It reads the workbook and Shopify configuration, validates the product, variants, location, permissions, currency, countries, prices, and existing delivery profile, but makes no Shopify changes.

Review the console summary and warning report before applying the import.

### Apply the import

Add `--apply` only after the dry run is correct:

```bash
npm run import:shopify -- \
  --sheet "Desk XL" \
  --product-id 1234567890123 \
  --apply
```

The default profile name is deterministic:

```text
Etsy OCR | PRODUCT_ID | WORKSHEET
```

If no profile with that exact name exists, the importer creates it. On a repeated run, it replaces the zones and rates inside that profile instead of creating a duplicate. All variants of the supplied product are associated with the profile.

You can set a custom profile name when needed:

```bash
npm run import:shopify -- \
  --sheet "Vanity table" \
  --product-id 1234567890123 \
  --profile-name "Vanity table shipping" \
  --apply
```

### Warning reports and ambiguity rules

Every run writes a JSON report using this naming convention:

```text
warning/PRODUCT_ID_WORKSHEET.json
```

For example:

```text
warning/1234567890123_Desk_XL.json
```

The report contains the selected product and variants, location, planned Shopify zones and rates, detected ambiguities, skipped rows, and the final dry-run or apply result.

When the same country or region appears more than once in a worksheet, the **first worksheet row wins**. Its `One item (USD)` value becomes the flat Shopify rate. Every ignored alternative, including its row number and prices, is recorded as `DUPLICATE_DESTINATION` in the JSON report.

Other warning types include:

- an `OCR status` other than `OK`;
- a missing or invalid first-item price;
- an unknown destination that cannot be mapped to Shopify;
- multiple names mapping to the same Shopify country code;
- missing shipping-service text;
- multiple Shopify locations or conflicting delivery profiles.

Rows without a valid `One item (USD)` price and unknown destinations are skipped. A `Free shipping` row with a missing price is imported as `0.00` and recorded in the report.

Explicit country rows take priority over regional fallback rows. `European Union` and `Europe non-EU` are expanded to Shopify country codes after removing countries already configured explicitly. `Everywhere else` is imported as Shopify's rest-of-world zone.

If the shop has exactly one active location that fulfills online orders, it is selected automatically. For a shop with multiple locations, specify the intended location:

```bash
npm run import:shopify -- \
  --sheet "Desk XL" \
  --product-id 1234567890123 \
  --location-id 987654321 \
  --apply
```

### Shopify importer options

| Option | Description |
| --- | --- |
| `--sheet <name>` | Required exact worksheet name. |
| `--product-id <id>` | Required numeric Shopify product ID or Product GID. |
| `--input <file>` | Source workbook; defaults to `outputs/shipping_policies.xlsx`. |
| `--location-id <id>` | Shopify location ID; required only when it cannot be selected automatically. |
| `--profile-name <name>` | Overrides the deterministic delivery-profile name. |
| `--warning-dir <dir>` | Warning report directory; defaults to `warning/`. |
| `--store <store>` | Overrides `SHOPIFY_STORE`. |
| `--api-version <version>` | Overrides `SHOPIFY_API_VERSION`; defaults to `2026-07`. |
| `--dry-run` | Validates and reports without changing Shopify; this is the default. |
| `--apply` | Creates or updates the Shopify delivery profile. |
| `--help` | Displays CLI help. |

View the importer help:

```bash
npm run import:shopify -- --help
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
