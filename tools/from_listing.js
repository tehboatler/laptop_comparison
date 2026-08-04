#!/usr/bin/env node
/**
 * JTBD #1+#2: Add a laptop from a retailer URL + verified street price.
 * Free — no metoda/Price API.
 *
 *   npm run catalog:add -- --url "https://www.amazon.co.uk/dp/B0..." --gbp 1259 --title "..."
 *   node tools/from_listing.js --url "..." --eur 1399 --title "..."
 *
 * Writes tools/inbox/<id>.json then imports into data.json + sku_registry.
 */
const fs = require("fs");
const path = require("path");
const {
  root,
  loadDotEnv,
  loadJson,
  saveJson,
  laptopSheet,
} = require("./lib/catalog_utils");
const { buildInboxItem, inboxToCatalog, parseListingUrl } = require("./lib/listing");

loadDotEnv();

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? true;
}

function main() {
  const url = arg("url") || arg("u");
  const title = arg("title") || arg("t") || "";
  const gbp = arg("gbp") || arg("price-gbp");
  const eur = arg("eur") || arg("price-eur");
  const ean = arg("ean") || "";
  const notes = arg("notes") || "";
  const importNow = process.argv.includes("--import") || !process.argv.includes("--inbox-only");

  if (!url && !process.argv.includes("--help")) {
    console.log(`Usage:
  npm run catalog:add -- --url "https://www.amazon.co.uk/dp/B0..." --gbp 1259 --title "Lenovo LOQ 15 RTX 5060"

Options:
  --url / -u       Amazon or Geizhals product URL (ASIN extracted free)
  --title / -t     Display name (recommended)
  --gbp            Street price GBP you saw on that listing
  --eur            Street price EUR you saw on that listing
  --ean            Optional EAN/GTIN
  --notes          Free text
  --inbox-only     Only write tools/inbox/*.json (no catalog import)
`);
    process.exit(url ? 0 : 1);
  }

  const listing = parseListingUrl(url);
  if (!listing.asin && !listing.geizhals_id && !ean) {
    console.warn(
      "Warning: could not extract ASIN/Geizhals id from URL. Pass --ean or use a /dp/ASIN Amazon link for SKU-verified pricing."
    );
  }

  const item = buildInboxItem({
    url,
    title:
      title ||
      (listing.asin ? `Amazon ${listing.asin}` : "New laptop (set title)"),
    price_gbp: gbp,
    price_eur: eur,
    ean,
    notes,
  });

  const inboxDir = path.join(root, "tools", "inbox");
  if (!fs.existsSync(inboxDir)) fs.mkdirSync(inboxDir, { recursive: true });
  const inboxPath = path.join(inboxDir, `${item.id}.json`);
  saveJson(inboxPath, item);
  console.log(`Inbox: ${path.relative(root, inboxPath)}`);
  console.log(
    `  ASIN=${item.asin || "—"} EAN=${item.ean || "—"} verified=${item.price_verified}`
  );

  if (!importNow) {
    console.log("Stopped at inbox (--inbox-only). Run: npm run catalog:import");
    return;
  }

  const dataPath = path.join(root, "data.json");
  const regPath = path.join(root, "tools", "sku_registry.json");
  const data = loadJson(dataPath);
  const reg = loadJson(regPath);
  const sheet = laptopSheet(data);
  if (!reg.entries) reg.entries = {};

  if (sheet.rows.some((r) => r.id === item.id) || reg.entries[item.id]) {
    console.error(`Already exists: ${item.id} — edit data.json or pick another --title`);
    process.exit(1);
  }

  const { row, reg: regEntry } = inboxToCatalog(item);
  sheet.rows.push(row);
  reg.entries[item.id] = regEntry;
  saveJson(dataPath, data);
  saveJson(regPath, reg);

  console.log(`\nAdded draft: ${item.id}`);
  console.log(`  ${row.cells.col_model}`);
  console.log(`  GBP ${row.cells.col_price.GBP} · EUR ${row.cells.col_price.EUR}`);
  console.log(`\nNext:`);
  console.log(`  npm run catalog:sonar -- --id ${item.id}`);
  console.log(`  npm run catalog:sync`);
}

main();
