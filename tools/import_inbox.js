#!/usr/bin/env node
/**
 * Import tools/inbox/*.json into data.json + sku_registry.json as drafts.
 * Skips _template.json and already-imported ids.
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
const { buildInboxItem, inboxToCatalog } = require("./lib/listing");

loadDotEnv();

function main() {
  const inboxDir = path.join(root, "tools", "inbox");
  if (!fs.existsSync(inboxDir)) {
    console.log("No tools/inbox/ yet");
    return;
  }

  const files = fs
    .readdirSync(inboxDir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("_"));

  if (!files.length) {
    console.log("Inbox empty. Add JSON files or: npm run catalog:add -- --url ...");
    return;
  }

  const dataPath = path.join(root, "data.json");
  const regPath = path.join(root, "tools", "sku_registry.json");
  const data = loadJson(dataPath);
  const reg = loadJson(regPath);
  const sheet = laptopSheet(data);
  if (!reg.entries) reg.entries = {};

  let added = 0;
  let skipped = 0;

  for (const f of files) {
    const raw = loadJson(path.join(inboxDir, f));
    const item = buildInboxItem({
      id: raw.id,
      url: raw.listing_url || raw.url,
      title: raw.model || raw.title,
      price_gbp: raw.price_gbp ?? raw.gbp,
      price_eur: raw.price_eur ?? raw.eur,
      ean: raw.ean,
      notes: raw.notes,
    });
    // preserve explicit asin
    if (raw.asin && !item.asin) item.asin = raw.asin;

    if (sheet.rows.some((r) => r.id === item.id) || reg.entries[item.id]) {
      console.log(`  skip exists ${item.id}`);
      skipped++;
      continue;
    }

    const { row, reg: regEntry } = inboxToCatalog(item);
    sheet.rows.push(row);
    reg.entries[item.id] = regEntry;
    console.log(
      `  + ${item.id}  ${item.model.slice(0, 50)}  verified=${item.price_verified}`
    );
    added++;
  }

  if (added) {
    saveJson(dataPath, data);
    saveJson(regPath, reg);
  }
  console.log(`\nImported ${added}, skipped ${skipped}`);
  if (added) {
    console.log("Next: npm run catalog:sonar && npm run catalog:sync");
  }
}

main();
