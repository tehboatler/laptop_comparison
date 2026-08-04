#!/usr/bin/env node
/**
 * ONE-CLICK catalog sync
 * ----------------------
 *   npm run catalog:sync
 *   node tools/sync_catalog.js
 *
 * Always runs (no API keys):
 *   1. Ensure sku_registry.json has an entry for every laptop id
 *   2. normalize chassis grades
 *   3. refresh buy links (live stock-check URLs)
 *   4. apply registry → data.json (ASINs, EANs, official URLs, availability overrides)
 *   5. optional Amazon PA-API price/title/EAN pull for mapped ASINs
 *   6. validate catalog
 *   7. embed data.json into sheet.html + index.html
 *   8. write tools/out/sync_report.json + research_queue.csv
 *
 * Official API reality:
 *   • Amazon Product Advertising API 5.0 = the main *official* retail product API
 *     you can actually use for ASINs (requires Associates + PA-API access).
 *   • There is NO free universal API for “all EU laptops + perfect specs”.
 *   • Idealo Partner API is for merchants *pushing* their own offers, not reading competitors.
 *   • Geizhals commercial data is via partners (e.g. PriceAPI), not a free public API.
 *
 * Env for Amazon (optional):
 *   AMAZON_ACCESS_KEY, AMAZON_SECRET_KEY, AMAZON_PARTNER_TAG
 *   AMAZON_HOST=webservices.amazon.co.uk  AMAZON_REGION=eu-west-1
 *   AMAZON_MARKET=uk|de  (default uk)
 *
 * Env for metoda Price API / priceapi.com (recommended over Amazon for multi-shop EU):
 *   PRICEAPI_TOKEN   (from https://www.priceapi.com/users/sign_up — trial credits)
 *   PRICEAPI_SOURCE  default google_shopping_uk-ish: google_shopping | amazon | idealo | geizhals
 *   PRICEAPI_COUNTRY default gb (use de for Germany)
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const dataPath = path.join(root, "data.json");
const regPath = path.join(__dirname, "sku_registry.json");
const outDir = path.join(__dirname, "out");

// Load .env if present (no dependency)
(function loadDotEnv() {
  const p = path.join(root, ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null) process.env[k] = v;
  }
})();

const { hasAmazonCreds, getItems, parseGetItems } = require("./lib/amazon_paapi");
const {
  hasPriceApiKey,
  fetchProductAndOffers,
  summarizeResults,
} = require("./lib/priceapi");

function runNode(scriptRel) {
  const script = path.join(root, scriptRel);
  console.log("\n→", scriptRel);
  const r = spawnSync(process.execPath, [script], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) {
    throw new Error(`${scriptRel} failed with code ${r.status}`);
  }
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

function ensureRegistry(data, reg) {
  const sheet = data.sheets.find((s) =>
    String(s.name || "").toLowerCase().includes("laptop")
  );
  if (!reg.entries || typeof reg.entries !== "object") reg.entries = {};
  let added = 0;
  for (const row of sheet.rows) {
    if (!reg.entries[row.id]) {
      reg.entries[row.id] = {
        model: row.cells.col_model || row.id,
        asin: { uk: "", de: "" },
        ean: "",
        mpn: "",
        geizhals_id: "",
        official_url: row.cells.col_url || row.cells.col_detail?.link || "",
        search_query: String(row.cells.col_model || "")
          .replace(/\([^)]*\)/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
      };
      added++;
    } else {
      // keep model label in sync
      reg.entries[row.id].model =
        reg.entries[row.id].model || row.cells.col_model || row.id;
    }
  }
  // drop orphan registry keys (except we keep them for history - no, keep orphans with flag)
  for (const id of Object.keys(reg.entries)) {
    if (!sheet.rows.find((r) => r.id === id)) {
      reg.entries[id]._orphan = true;
    } else {
      delete reg.entries[id]._orphan;
    }
  }
  return { reg, added, total: sheet.rows.length };
}

function applyRegistryToCatalog(data, reg) {
  const sheet = data.sheets.find((s) =>
    String(s.name || "").toLowerCase().includes("laptop")
  );
  let applied = 0;
  for (const row of sheet.rows) {
    const e = reg.entries[row.id];
    if (!e) continue;
    const det = row.cells.col_detail || {};
    det.sku_map = {
      asin_uk: e.asin?.uk || "",
      asin_de: e.asin?.de || "",
      ean: e.ean || "",
      mpn: e.mpn || "",
      geizhals_id: e.geizhals_id || "",
      official_url: e.official_url || "",
      search_query: e.search_query || "",
      last_sync: e.last_sync || null,
      amazon_snapshot: e.amazon_snapshot || null,
    };
    if (e.official_url) {
      row.cells.col_url = e.official_url;
      det.link = e.official_url;
    }
    if (e.availability_override && det.availability) {
      det.availability.status = e.availability_override;
    }
    // Prefer Amazon image if we have one and catalog image empty
    if (e.amazon_snapshot?.image && !row.cells.col_image) {
      row.cells.col_image = e.amazon_snapshot.image;
      det.images = det.images?.length
        ? det.images
        : [e.amazon_snapshot.image];
    }
    // Price from Amazon if currency matches and amount present
    if (e.amazon_snapshot?.price != null && e.amazon_snapshot.currency) {
      const cur = e.amazon_snapshot.currency;
      const amt = Math.round(Number(e.amazon_snapshot.price));
      if (!row.cells.col_price) row.cells.col_price = {};
      if (cur === "GBP") {
        row.cells.col_price.GBP = amt;
        det.price_gbp = amt;
      } else if (cur === "EUR") {
        row.cells.col_price.EUR = amt;
        det.price_eur = amt;
      } else if (cur === "USD") {
        det.price_note = [
          det.price_note || "",
          `Amazon USD snapshot ~$${amt}`,
        ]
          .filter(Boolean)
          .join(" · ");
      }
      if (e.amazon_snapshot.availability) {
        if (!det.availability) det.availability = {};
        det.availability.amazon_message = e.amazon_snapshot.availability;
        det.availability.amazon_in_stock = !!e.amazon_snapshot.inStock;
        det.availability.checked = new Date().toISOString().slice(0, 10);
      }
    }
    // metoda Price API min street price (often better multi-shop signal)
    if (e.priceapi_snapshot?.min_price != null) {
      const amt = Math.round(Number(e.priceapi_snapshot.min_price));
      const cur = String(e.priceapi_snapshot.currency || "").toUpperCase();
      if (!row.cells.col_price) row.cells.col_price = {};
      if (cur === "GBP" || (!cur && e.priceapi_snapshot.country === "gb")) {
        row.cells.col_price.GBP = amt;
        det.price_gbp = amt;
      } else if (cur === "EUR" || e.priceapi_snapshot.country === "de") {
        row.cells.col_price.EUR = amt;
        det.price_eur = amt;
      }
      if (!det.availability) det.availability = {};
      det.availability.priceapi_offers = e.priceapi_snapshot.offer_count || 0;
      det.availability.priceapi_shops = e.priceapi_snapshot.shops || [];
      det.availability.priceapi_source = e.priceapi_snapshot.source;
      det.availability.checked = new Date().toISOString().slice(0, 10);
      if ((e.priceapi_snapshot.offer_count || 0) === 0) {
        // leave status alone unless clearly dead
      } else if (det.availability.status === "aftermarket") {
        /* keep aftermarket if manually set */
      } else if ((e.priceapi_snapshot.offer_count || 0) >= 3) {
        det.availability.status = det.availability.status || "retail";
      }
      det.sku_map = det.sku_map || {};
      det.sku_map.priceapi_snapshot = e.priceapi_snapshot;
    }
    row.cells.col_detail = det;
    applied++;
  }
  return applied;
}

function researchQueue(data, reg) {
  const sheet = data.sheets.find((s) =>
    String(s.name || "").toLowerCase().includes("laptop")
  );
  const rows = [];
  for (const row of sheet.rows) {
    const e = reg.entries[row.id] || {};
    const missing = [];
    if (!e.asin?.uk && !e.asin?.de) missing.push("asin");
    if (!e.ean) missing.push("ean");
    if (!e.mpn) missing.push("mpn");
    const q =
      e.search_query ||
      String(row.cells.col_model || "")
        .replace(/\([^)]*\)/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    rows.push({
      id: row.id,
      model: row.cells.col_model,
      missing: missing.join("|") || "ok",
      geizhals: `https://geizhals.eu/?fs=${encodeURIComponent(q)}`,
      idealo_uk: `https://www.idealo.co.uk/presisearch?q=${encodeURIComponent(q)}`,
      amazon_uk: `https://www.amazon.co.uk/s?k=${encodeURIComponent(q)}`,
      amazon_de: `https://www.amazon.de/s?k=${encodeURIComponent(q)}`,
      scan: `https://www.scan.co.uk/search?q=${encodeURIComponent(q)}`,
      mapped_asin_uk: e.asin?.uk || "",
      mapped_ean: e.ean || "",
    });
  }
  return rows;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join(
    "\n"
  );
}

/**
 * Allowed lookup keys by source (product_and_offers).
 * google_shopping (esp. gb) only accepts gtin/id — NOT free-text "term".
 * See metoda "Available Sources" + API error detail.
 */
const PRICEAPI_SOURCE_KEYS = {
  google_shopping: ["gtin", "id"],
  amazon: ["asin", "gtin", "id"],
  idealo: ["gtin", "id"],
  geizhals: ["gtin", "id", "mpn"],
  billiger: ["gtin", "id"],
  pricerunner: ["gtin", "id"],
  skinflint: ["gtin", "id"],
  ebay: ["gtin", "id"],
};

function allowedKeysForSource(source) {
  return PRICEAPI_SOURCE_KEYS[source] || ["gtin", "id"];
}

/**
 * metoda Price API enrichment
 * Priority: EAN/GTIN > ASIN (amazon source) — free-text search is NOT reliable on many sources
 */
async function enrichPriceApi(reg) {
  if (!hasPriceApiKey()) {
    console.log(
      "\nmetoda Price API: skipped (set PRICEAPI_TOKEN from priceapi.com / metoda)"
    );
    return { fetched: 0, errors: [] };
  }

  let source = (process.env.PRICEAPI_SOURCE || "google_shopping").toLowerCase();
  const country = (process.env.PRICEAPI_COUNTRY || "gb").toLowerCase();
  const maxPerRun = Math.min(
    50,
    Math.max(1, parseInt(process.env.PRICEAPI_MAX || "15", 10) || 15)
  );
  const allowed = allowedKeysForSource(source);

  // Build work list only with keys this source accepts
  const work = [];
  let skippedNoId = 0;
  for (const [id, e] of Object.entries(reg.entries)) {
    if (e._orphan) continue;
    if (e.ean && allowed.includes("gtin")) {
      work.push({ id, key: "gtin", value: String(e.ean).replace(/\s/g, "") });
      continue;
    }
    const asin = (e.asin?.uk || e.asin?.de || "").trim();
    if (asin && allowed.includes("asin")) {
      work.push({ id, key: "asin", value: asin });
      continue;
    }
    if (e.mpn && allowed.includes("mpn")) {
      work.push({ id, key: "mpn", value: String(e.mpn).trim() });
      continue;
    }
    if (e.geizhals_id && allowed.includes("id")) {
      work.push({ id, key: "id", value: String(e.geizhals_id).trim() });
      continue;
    }
    skippedNoId++;
  }

  // If user picked google_shopping but has ASINs not EANs, auto-switch those to amazon
  if (!work.length && source === "google_shopping") {
    const asinWork = [];
    for (const [id, e] of Object.entries(reg.entries)) {
      if (e._orphan) continue;
      const asin = (e.asin?.uk || e.asin?.de || "").trim();
      if (asin) asinWork.push({ id, key: "asin", value: asin });
    }
    if (asinWork.length) {
      source = "amazon";
      work.push(...asinWork);
      console.log(
        "\nmetoda Price API: no GTINs for google_shopping — auto-using source=amazon with ASINs"
      );
    }
  }

  const batch = work.slice(0, maxPerRun);
  if (!batch.length) {
    console.log("\nmetoda Price API: nothing to query with valid keys.");
    console.log(
      `  Source "${source}" only accepts: ${allowedKeysForSource(source).join(", ")}`
    );
    console.log(
      `  ${skippedNoId} catalog rows have no EAN/GTIN (and no usable ASIN for this source).`
    );
    console.log("  Fix: open tools/out/research_queue.csv → find product → paste EAN into");
    console.log('       tools/sku_registry.json → entries.<id>.ean = "0194…"');
    console.log("  Then: npm run catalog:sync");
    console.log("  Tip: EAN is on Geizhals product pages / Amazon product details / box barcode.");
    return {
      fetched: 0,
      errors: [
        "no_valid_identifiers: fill ean (gtin) in sku_registry.json for google_shopping",
      ],
    };
  }

  console.log(
    `\nmetoda Price API: ${batch.length} item(s) via ${source}/${country} (cap ${maxPerRun})…`
  );
  if (skippedNoId) {
    console.log(
      `  (skipped ${skippedNoId} rows without EAN/ASIN/MPN usable for this source)`
    );
  }

  const errors = [];
  let fetched = 0;

  const byKey = new Map();
  for (const w of batch) {
    if (!byKey.has(w.key)) byKey.set(w.key, []);
    byKey.get(w.key).push(w);
  }

  for (const [key, items] of byKey) {
    try {
      const values = items.map((i) => i.value);
      console.log(`  job key=${key} n=${values.length}`);
      const { jobId, results } = await fetchProductAndOffers({
        source,
        country,
        key,
        values,
        max_age: process.env.PRICEAPI_MAX_AGE
          ? parseInt(process.env.PRICEAPI_MAX_AGE, 10)
          : 3600,
      });
      const summary = summarizeResults(results, {
        currencyHint: country === "de" || country === "at" ? "EUR" : "GBP",
      });
      console.log(
        `  ✓ job ${jobId}: products=${summary.products} min=${summary.currency || ""} ${summary.min_price ?? "?"} offers=${summary.offer_count ?? 0}`
      );

      const resultList = Array.isArray(results)
        ? results
        : results?.results || results?.data || [];

      for (const item of items) {
        let matched = null;
        if (Array.isArray(resultList)) {
          matched =
            resultList.find((p) => {
              const ids = [
                p.gtin,
                p.ean,
                p.asin,
                p.identifier,
                p.gtins,
                p.value,
                p.query,
                p.id,
              ]
                .flat()
                .filter(Boolean)
                .map(String);
              const v = String(item.value);
              return ids.some((x) => x === v || x.includes(v) || v.includes(x));
            }) || null;
        }
        // 1:1 when single value job, or when count matches values length and order preserved
        if (!matched && Array.isArray(resultList) && resultList.length === items.length) {
          matched = resultList[items.indexOf(item)] || null;
        }
        const localSummary = matched
          ? summarizeResults([matched], { currencyHint: summary.currency })
          : items.length === 1
            ? summary
            : { products: 0, min_price: null, currency: summary.currency, offer_count: 0 };

        reg.entries[item.id].priceapi_snapshot = {
          source,
          country,
          key,
          query: item.value,
          job_id: jobId,
          ...localSummary,
          fetched_at: new Date().toISOString(),
        };
        reg.entries[item.id].last_sync = new Date().toISOString();
        if (localSummary.min_price != null) fetched++;
        else if (matched || items.length === 1) fetched++;
      }
    } catch (err) {
      errors.push(`${key}: ${err.message}`);
      console.warn("  ✗", err.message);
      if (/Allowed values/i.test(err.message)) {
        console.warn(
          "  → This source does not accept that key. Use EAN (gtin) in sku_registry.json."
        );
      }
    }
  }

  return { fetched, errors };
}

async function enrichAmazon(reg) {
  if (!hasAmazonCreds()) {
    console.log(
      "\nAmazon PA-API: skipped (set AMAZON_ACCESS_KEY, AMAZON_SECRET_KEY, AMAZON_PARTNER_TAG)"
    );
    return { fetched: 0, errors: [] };
  }
  const market = (process.env.AMAZON_MARKET || "uk").toLowerCase();
  const pairs = [];
  for (const [id, e] of Object.entries(reg.entries)) {
    const asin = market === "de" ? e.asin?.de : e.asin?.uk;
    if (asin) pairs.push({ id, asin: asin.trim() });
  }
  if (!pairs.length) {
    console.log(
      "Amazon PA-API: no ASINs in sku_registry.json yet — fill asin.uk / asin.de first"
    );
    return { fetched: 0, errors: [] };
  }

  console.log(`\nAmazon PA-API: fetching ${pairs.length} ASIN(s) (${market})…`);
  const errors = [];
  let fetched = 0;
  // batch of 10
  for (let i = 0; i < pairs.length; i += 10) {
    const batch = pairs.slice(i, i + 10);
    try {
      // gentle rate limit
      if (i > 0) await new Promise((r) => setTimeout(r, 1200));
      const raw = await getItems(
        batch.map((b) => b.asin),
        market === "de" ? "de" : "uk"
      );
      const map = parseGetItems(raw);
      for (const { id, asin } of batch) {
        const snap = map[asin];
        if (!snap) {
          errors.push(`${id}: no item for ASIN ${asin}`);
          continue;
        }
        reg.entries[id].amazon_snapshot = {
          ...snap,
          marketplace: market,
          fetched_at: new Date().toISOString(),
        };
        reg.entries[id].last_sync = new Date().toISOString();
        // backfill EAN/MPN if empty
        if (!reg.entries[id].ean && snap.ean) reg.entries[id].ean = snap.ean;
        if (!reg.entries[id].mpn && snap.mpn) reg.entries[id].mpn = snap.mpn;
        fetched++;
        console.log(
          `  ✓ ${id}: ${snap.currency || ""} ${snap.price ?? "?"} · ${snap.availability || "n/a"}`
        );
      }
    } catch (err) {
      errors.push(`batch ${i}: ${err.message}`);
      console.warn("  ✗", err.message);
    }
  }
  return { fetched, errors };
}

async function main() {
  console.log("══════════════════════════════════════════════");
  console.log(" Catalog sync (one-click)");
  console.log("══════════════════════════════════════════════");

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  let data = loadJson(dataPath);
  let reg = fs.existsSync(regPath)
    ? loadJson(regPath)
    : { _meta: {}, entries: {} };

  // 1) Registry coverage
  const { added, total } = ensureRegistry(data, reg);
  saveJson(regPath, reg);
  console.log(`\nSKU registry: ${total} laptops, +${added} new stub entries`);

  // 2–3) Local transforms
  runNode("tools/normalize_chassis.js");
  runNode("tools/refresh_buy_links.js");

  // reload after transforms
  data = loadJson(dataPath);
  reg = loadJson(regPath);

  // 4a) metoda Price API (preferred multi-shop enrichment)
  const priceapi = await enrichPriceApi(reg);
  saveJson(regPath, reg);

  // 4b) Amazon PA-API (optional, ASIN-mapped only)
  const amazon = await enrichAmazon(reg);
  saveJson(regPath, reg);

  // 5) Apply registry into catalog
  data = loadJson(dataPath);
  const applied = applyRegistryToCatalog(data, reg);
  saveJson(dataPath, data);
  console.log(`\nApplied SKU map to ${applied} catalog rows`);

  // 6) Validate
  runNode("tools/validate_catalog.js");

  // 7) Embed
  runNode("tools/embed_data.js");

  // 8) Reports
  data = loadJson(dataPath);
  reg = loadJson(regPath);
  const queue = researchQueue(data, reg);
  const incomplete = queue.filter((r) => r.missing !== "ok");
  fs.writeFileSync(path.join(outDir, "research_queue.csv"), toCsv(queue));
  const report = {
    ran_at: new Date().toISOString(),
    laptops: total,
    registry_stubs_added: added,
    metoda_price_api: {
      credentials: hasPriceApiKey(),
      fetched: priceapi.fetched,
      errors: priceapi.errors,
      source: process.env.PRICEAPI_SOURCE || "google_shopping",
      country: process.env.PRICEAPI_COUNTRY || "gb",
    },
    amazon: {
      credentials: hasAmazonCreds(),
      fetched: amazon.fetched,
      errors: amazon.errors,
    },
    incomplete_sku_maps: incomplete.length,
    next_steps: !hasPriceApiKey()
      ? [
          "Easiest automation: sign up at https://www.priceapi.com/users/sign_up (metoda Price API)",
          "Copy token into .env as PRICEAPI_TOKEN=...",
          "Optionally set PRICEAPI_COUNTRY=gb and PRICEAPI_SOURCE=google_shopping (or amazon, idealo, geizhals)",
          "npm run catalog:sync",
          "For perfect matching, fill EAN/GTIN in tools/sku_registry.json (better than free-text search)",
        ]
      : incomplete.length
        ? [
            "Open tools/out/research_queue.csv",
            "Fill EAN (best) or ASIN in tools/sku_registry.json for tighter matching",
            "Re-run: npm run catalog:sync",
          ]
        : ["SKU maps look complete — re-run weekly to refresh prices"],
  };
  saveJson(path.join(outDir, "sync_report.json"), report);

  console.log("\n══════════════════════════════════════════════");
  console.log(` Done. Incomplete SKU maps: ${incomplete.length}/${total}`);
  console.log(` Report: tools/out/sync_report.json`);
  console.log(` Queue:  tools/out/research_queue.csv`);
  if (!hasPriceApiKey()) {
    console.log("\n Recommended: metoda Price API (easier than Amazon Associates)");
    console.log("  1. https://www.priceapi.com/users/sign_up  (free trial credits)");
    console.log("  2. Copy token → .env  PRICEAPI_TOKEN=...");
    console.log("  3. Optional: PRICEAPI_COUNTRY=gb  PRICEAPI_SOURCE=google_shopping");
    console.log("  4. npm run catalog:sync");
  }
  if (!hasAmazonCreds()) {
    console.log("\n Optional: Amazon PA-API (Associates) for ASIN-perfect Amazon rows");
  }
  console.log("══════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("\nSYNC FAILED:", err.message || err);
  process.exit(1);
});
