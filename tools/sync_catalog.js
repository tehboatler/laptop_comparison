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
 *   4. optional auto-resolve ASIN/EAN (Price API search_results) when token set
 *   5. apply registry → data.json + metoda price enrich + optional Amazon PA-API
 *   6. validate catalog
 *   7. embed data.json into sheet.html + index.html
 *   8. write tools/out/sync_report.json + research_queue.csv
 *
 * Default path is FREE (no metoda):
 *   registry stubs → chassis → buy links → apply SKU map → validate → embed
 *
 * Recommended JTBD workflow (no paid price API):
 *   1. npm run catalog:add -- --url "https://amazon.co.uk/dp/B0..." --gbp 1259 --title "..."
 *   2. npm run catalog:sonar -- --id <id>     # Perplexity: flesh out specs
 *   3. npm run catalog:sync                   # free publish path
 *
 * Optional paid metoda (opt-in only — burns credits):
 *   CATALOG_PRICEAPI=1  enable product+offers enrich
 *   CATALOG_RESOLVE=1   enable ASIN search resolve
 *   PRICEAPI_TOKEN=...
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
  getResultBlocks,
  extractContentItems,
  normalizeProductHit,
  parseResultErrors,
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
    const hasAsin = !!(e.asin?.uk || e.asin?.de);
    const hasEan = !!(e.ean && String(e.ean).replace(/\D/g, "").length >= 8);
    const missing = [];
    if (!hasAsin) missing.push("asin");
    if (!hasEan) missing.push("ean");
    if (!e.mpn) missing.push("mpn");
    // Priceable if ASIN (amazon) or EAN (google_shopping) — mpn optional
    const priceable = hasAsin || hasEan;
    const q =
      e.search_query ||
      String(row.cells.col_model || "")
        .replace(/\([^)]*\)/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    rows.push({
      id: row.id,
      model: row.cells.col_model,
      missing: priceable
        ? missing.length
          ? `ok(${missing.join("|")})`
          : "ok"
        : missing.join("|") || "ok",
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
  const asinFallback = [];
  let skippedNoId = 0;
  for (const [id, e] of Object.entries(reg.entries)) {
    if (e._orphan) continue;
    if (e.ean && allowed.includes("gtin")) {
      work.push({
        id,
        key: "gtin",
        value: String(e.ean).replace(/\s/g, ""),
        source,
      });
      continue;
    }
    const asin = (e.asin?.uk || e.asin?.de || "").trim();
    if (asin && allowed.includes("asin")) {
      work.push({ id, key: "asin", value: asin, source });
      continue;
    }
    if (e.mpn && allowed.includes("mpn")) {
      work.push({ id, key: "mpn", value: String(e.mpn).trim(), source });
      continue;
    }
    if (e.geizhals_id && allowed.includes("id")) {
      work.push({ id, key: "id", value: String(e.geizhals_id).trim(), source });
      continue;
    }
    // google_shopping can't use ASIN — queue amazon fallback
    if (asin && source === "google_shopping") {
      asinFallback.push({ id, key: "asin", value: asin, source: "amazon" });
      continue;
    }
    skippedNoId++;
  }

  if (asinFallback.length) {
    work.push(...asinFallback);
    console.log(
      `\nmetoda Price API: ${asinFallback.length} ASIN-only row(s) → source=amazon fallback`
    );
  }

  const batch = work.slice(0, maxPerRun);
  if (!batch.length) {
    console.log("\nmetoda Price API: nothing to query with valid keys.");
    console.log(
      `  Source "${source}" product_and_offers accepts: ${allowedKeysForSource(source).join(", ")}`
    );
    console.log(
      `  ${skippedNoId} catalog rows still have no EAN/ASIN after resolve.`
    );
    console.log("  Fix: npm run catalog:resolve  (or paste EAN into sku_registry.json)");
    console.log("  Or: PRICEAPI_SOURCE=amazon after ASINs are filled");
    return {
      fetched: 0,
      errors: [
        "no_valid_identifiers: run catalog:resolve or fill ean/asin in sku_registry.json",
      ],
    };
  }

  console.log(
    `\nmetoda Price API: ${batch.length} item(s) for product_and_offers (cap ${maxPerRun})…`
  );
  if (skippedNoId) {
    console.log(
      `  (skipped ${skippedNoId} rows without EAN/ASIN/MPN usable yet)`
    );
  }

  const errors = [];
  let fetched = 0;

  // Group by source+key so amazon ASIN fallback can run next to google gtin
  const byJob = new Map();
  for (const w of batch) {
    const src = w.source || source;
    const k = `${src}::${w.key}`;
    if (!byJob.has(k)) byJob.set(k, []);
    byJob.get(k).push(w);
  }

  for (const [jobKey, items] of byJob) {
    const [jobSource, key] = jobKey.split("::");
    try {
      const values = items.map((i) => i.value);
      console.log(`  job source=${jobSource} key=${key} n=${values.length}`);
      const { jobId, results } = await fetchProductAndOffers({
        source: jobSource,
        country,
        key,
        values,
        max_age: process.env.PRICEAPI_MAX_AGE
          ? parseInt(process.env.PRICEAPI_MAX_AGE, 10)
          : 1440,
      });
      const summary = summarizeResults(results, {
        currencyHint: country === "de" || country === "at" ? "EUR" : "GBP",
      });
      console.log(
        `  ✓ job ${jobId}: products=${summary.products} min=${summary.currency || ""} ${summary.min_price ?? "?"} offers=${summary.offer_count ?? 0}`
      );
      if (summary.errors?.length) {
        console.log(`    block errors: ${summary.errors.slice(0, 3).join("; ")}`);
      }

      // Official v2: one results[] block per requested value
      const blocks = getResultBlocks(results);
      for (const item of items) {
        const v = String(item.value);
        const block =
          blocks.find((b) => {
            const qv = String(b?.query?.value || b?.query?.term || "");
            return qv === v || qv.includes(v) || v.includes(qv);
          }) ||
          (blocks.length === items.length
            ? blocks[items.indexOf(item)]
            : null);

        let product = null;
        if (block?.success !== false && block?.content) {
          const contentItems = extractContentItems(block.content);
          product = contentItems[0] || null;
        }

        const hit = product
          ? normalizeProductHit(product, { query: v })
          : null;

        // Per-item price summary from product + offers
        let minPrice = hit?.price ?? null;
        let currency = hit?.currency || summary.currency;
        let offerCount = 0;
        const shops = [];
        const offers = product?.offers || block?.content?.offers || [];
        if (Array.isArray(offers)) {
          for (const o of offers) {
            offerCount++;
            const price = Number(
              typeof o.price === "string"
                ? o.price.replace(/[^0-9.]/g, "")
                : o.price ?? o.price_with_shipping
            );
            if (!isNaN(price) && price > 0) {
              if (minPrice == null || price < minPrice) minPrice = price;
            }
            if (o.currency) currency = o.currency;
            if (o.shop_name || o.shop) shops.push(String(o.shop_name || o.shop));
          }
        }
        // Buybox fallback / offer-count (Amazon often uses min_price)
        if (block?.content?.buybox) {
          const bp =
            block.content.buybox.price ??
            block.content.buybox.min_price ??
            block.content.buybox.price_with_shipping;
          if (minPrice == null && bp != null) {
            minPrice = Number(String(bp).replace(/[^0-9.]/g, ""));
          }
          if (bp != null && !offerCount) offerCount = 1;
          if (block.content.buybox.currency) {
            currency = block.content.buybox.currency || currency;
          }
          if (block.content.buybox.shop_name) {
            shops.push(String(block.content.buybox.shop_name));
          }
        }

        const localSummary = {
          products: product || hit ? 1 : 0,
          min_price: minPrice != null && !isNaN(minPrice) ? minPrice : null,
          currency: currency || null,
          offer_count: offerCount,
          shops: [...new Set(shops)].slice(0, 8),
          sample_title: hit?.title || product?.name || null,
          success: block ? block.success !== false : false,
          reason: block?.success === false ? block.reason : null,
        };

        reg.entries[item.id].priceapi_snapshot = {
          source: jobSource,
          country,
          key,
          query: item.value,
          job_id: jobId,
          ...localSummary,
          fetched_at: new Date().toISOString(),
        };
        reg.entries[item.id].last_sync = new Date().toISOString();

        // Backfill identifiers from product payload
        if (product || hit) {
          const ean =
            hit?.ean ||
            hit?.gtin ||
            product?.ean ||
            (Array.isArray(product?.eans) ? product.eans[0] : "") ||
            (Array.isArray(product?.gtins) ? product.gtins[0] : "");
          if (ean && !reg.entries[item.id].ean) {
            reg.entries[item.id].ean = String(ean).replace(/\D/g, "");
          }
          const mpn =
            hit?.mpn ||
            product?.mpn ||
            (Array.isArray(product?.mpns) ? product.mpns[0] : "");
          if (mpn && !reg.entries[item.id].mpn) {
            reg.entries[item.id].mpn = String(mpn);
          }
          const asin = hit?.asin || product?.asin || product?.id;
          if (asin && /^B0[A-Z0-9]{8}$/i.test(String(asin))) {
            if (!reg.entries[item.id].asin) {
              reg.entries[item.id].asin = { uk: "", de: "" };
            }
            if (country === "de") {
              if (!reg.entries[item.id].asin.de) {
                reg.entries[item.id].asin.de = String(asin);
              }
            } else if (!reg.entries[item.id].asin.uk) {
              reg.entries[item.id].asin.uk = String(asin);
            }
          }
        }

        if (localSummary.min_price != null) {
          fetched++;
          console.log(
            `    ✓ ${item.id}: ${currency || ""} ${minPrice} (${offerCount} offers) ${(localSummary.sample_title || "").slice(0, 50)}`
          );
        } else if (block?.success === false) {
          errors.push(`${item.id}: ${block.reason || "failed"}`);
          console.log(`    ✗ ${item.id}: ${block.reason || "failed"}`);
        } else {
          console.log(`    · ${item.id}: no price in payload`);
        }
      }
      // surface remaining parse errors
      for (const err of parseResultErrors(results)) {
        if (!errors.includes(err)) errors.push(err);
      }
    } catch (err) {
      errors.push(`${jobKey}: ${err.message}`);
      console.warn("  ✗", err.message);
      if (/Allowed values/i.test(err.message)) {
        console.warn(
          "  → This source does not accept that key. Prefer EAN (gtin) or source=amazon + ASIN."
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

  // 1b) Optional discover new laptops (seed queries → candidates / drafts)
  let discover = { ran: false, fresh: 0, applied: 0 };
  if (process.env.CATALOG_DISCOVER === "1") {
    console.log("\n→ tools/discover_laptops.js (CATALOG_DISCOVER=1)");
    try {
      const disc = require("./discover_laptops");
      const dres = await disc.main();
      discover = {
        ran: true,
        fresh: dres?.fresh || 0,
        applied: dres?.applied || 0,
      };
      data = loadJson(dataPath);
      reg = loadJson(regPath);
      const again = ensureRegistry(data, reg);
      saveJson(regPath, reg);
      if (again.added) console.log(`  registry +${again.added} after discover`);
    } catch (err) {
      console.warn("  discover failed:", err.message);
    }
  }

  // 2) Automatic quality gates (dedupe, scrub ASINs, images, FPS templates, promote)
  console.log("\n→ tools/catalog_hygiene.js");
  runNode("tools/catalog_hygiene.js");
  data = loadJson(dataPath);
  reg = loadJson(regPath);

  // 3) Local transforms
  runNode("tools/normalize_chassis.js");
  runNode("tools/refresh_buy_links.js");

  // reload after transforms
  data = loadJson(dataPath);
  reg = loadJson(regPath);

  // 3b) Optional metoda resolve — OPT-IN only (CATALOG_RESOLVE=1)
  let resolve = { ran: false, resolved: 0 };
  if (process.env.CATALOG_RESOLVE === "1" && hasPriceApiKey()) {
    console.log("\n→ tools/resolve_identifiers.js (CATALOG_RESOLVE=1, uses metoda credits)");
    try {
      const resMod = require("./resolve_identifiers");
      const rres = await resMod.main();
      resolve = { ran: true, resolved: rres?.resolved || 0 };
      reg = loadJson(regPath);
    } catch (err) {
      console.warn("  resolve failed:", err.message);
    }
  }

  // 4a) metoda prices — OPT-IN only (CATALOG_PRICEAPI=1)
  let priceapi = { fetched: 0, errors: [] };
  if (process.env.CATALOG_PRICEAPI === "1") {
    priceapi = await enrichPriceApi(reg);
    saveJson(regPath, reg);
  } else if (hasPriceApiKey()) {
    console.log(
      "\nmetoda Price API: idle (set CATALOG_PRICEAPI=1 to spend credits)"
    );
  } else {
    console.log("\nPrice refresh: free mode (SKU prices from inbox / human / Sonar)");
  }

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
  const incomplete = queue.filter((r) => !String(r.missing).startsWith("ok"));
  fs.writeFileSync(path.join(outDir, "research_queue.csv"), toCsv(queue));
  const finalTotal = researchQueue(data, reg).length;
  const report = {
    ran_at: new Date().toISOString(),
    laptops: finalTotal,
    registry_stubs_added: added,
    resolve: resolve,
    discover: discover,
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
    next_steps: [
      "Add laptop: npm run catalog:add -- --url \"https://amazon.co.uk/dp/B0...\" --gbp 999 --title \"...\"",
      "Flesh out:  npm run catalog:sonar -- --id <id>",
      "Publish:    npm run catalog:sync",
      incomplete.length
        ? "Missing ASIN/EAN: paste Amazon /dp/ URL via catalog:add or fill sku_registry"
        : "SKU maps priceable — re-run catalog:sync weekly for buy links",
    ],
  };
  saveJson(path.join(outDir, "sync_report.json"), report);

  console.log("\n══════════════════════════════════════════════");
  console.log(` Done. Incomplete SKU maps: ${incomplete.length}/${finalTotal}`);
  if (resolve.ran) console.log(` Auto-resolved identifiers: ${resolve.resolved}`);
  if (discover.ran) {
    console.log(
      ` Discover: ${discover.fresh} new candidates, ${discover.applied} drafts applied`
    );
  }
  console.log(` Report: tools/out/sync_report.json`);
  console.log(` Queue:  tools/out/research_queue.csv`);
  console.log("\n Free JTBD workflow:");
  console.log('  1. npm run catalog:add -- --url "https://www.amazon.co.uk/dp/B0..." --gbp 1259 --title "..."');
  console.log("  2. npm run catalog:sonar -- --id <id>   # PERPLEXITY_API_KEY");
  console.log("  3. npm run catalog:sync                 # buy links + embed");
  console.log("══════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("\nSYNC FAILED:", err.message || err);
  process.exit(1);
});
