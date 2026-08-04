#!/usr/bin/env node
/**
 * Discover candidate laptops via metoda Price API search_results.
 * Writes tools/out/discover_candidates.json (never invents EANs).
 *
 * Optionally applies new draft rows into data.json + sku_registry:
 *   DISCOVER_APPLY=1 node tools/discover_laptops.js
 *   npm run catalog:discover
 *
 * Env:
 *   PRICEAPI_TOKEN
 *   DISCOVER_SOURCE   default amazon
 *   DISCOVER_COUNTRY  default gb
 *   DISCOVER_MAX      max seed queries per run (default 8)
 *   DISCOVER_APPLY=1  promote new non-dup hits into catalog as col_status=draft
 *   DISCOVER_MIN_SCORE  default 0.45 (looser than resolve — discovery is broader)
 */
const fs = require("fs");
const path = require("path");
const {
  root,
  loadDotEnv,
  loadJson,
  saveJson,
  laptopSheet,
  pickBestHit,
  buildDraftRow,
  existingSignatures,
  isDuplicateHit,
  inferGpuId,
  inferBrand,
} = require("./lib/catalog_utils");
const {
  hasPriceApiKey,
  fetchSearchResults,
  parseSearchResults,
} = require("./lib/priceapi");

loadDotEnv();
if (process.argv.includes("--apply")) process.env.DISCOVER_APPLY = "1";

const queriesPath = path.join(root, "tools", "discover_queries.json");
const dataPath = path.join(root, "data.json");
const regPath = path.join(root, "tools", "sku_registry.json");
const outDir = path.join(root, "tools", "out");

async function main() {
  if (!hasPriceApiKey()) {
    console.log("discover_laptops: set PRICEAPI_TOKEN in .env");
    process.exitCode = 0;
    return { candidates: 0 };
  }

  const source = (process.env.DISCOVER_SOURCE || "amazon").toLowerCase();
  const country = (
    process.env.DISCOVER_COUNTRY ||
    process.env.PRICEAPI_COUNTRY ||
    "gb"
  ).toLowerCase();
  const maxQ = Math.min(
    25,
    Math.max(1, parseInt(process.env.DISCOVER_MAX || "8", 10) || 8)
  );
  const minScore = Number(process.env.DISCOVER_MIN_SCORE || "0.45");
  const apply = process.env.DISCOVER_APPLY === "1";

  const seed = loadJson(queriesPath);
  const queries = (seed.queries || []).slice(0, maxQ);

  const data = loadJson(dataPath);
  const reg = loadJson(regPath);
  const sigs = existingSignatures(data, reg);

  console.log(
    `\ndiscover_laptops: ${queries.length} queries via ${source}/${country}${apply ? " [APPLY drafts]" : ""}`
  );

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const candidates = [];
  const errors = [];

  for (const q of queries) {
    try {
      console.log(`  → "${q}"`);
      const { jobId, results } = await fetchSearchResults({
        source,
        country,
        values: [q],
        max_pages: 1,
      });
      const hits = parseSearchResults(results, { values: [q] });
      // Keep laptop-ish hits with GPU or known brand
      const filtered = hits.filter((h) => {
        const t = h.title || "";
        if (/\b(bag|sleeve|charger|dock|stand|cooler|mouse|headset)\b/i.test(t))
          return false;
        const gpu = inferGpuId(t) || inferGpuId(q);
        const brand = inferBrand(t);
        return !!(gpu || brand !== "unknown");
      });

      const { ranked } = pickBestHit(q, filtered, { minScore: 0 });
      let addedForQuery = 0;
      for (const h of ranked.slice(0, 6)) {
        if (h.match_score < minScore) continue;
        const dup = isDuplicateHit(h, sigs);
        const cand = {
          query: q,
          job_id: jobId,
          title: h.title,
          asin: h.asin || "",
          ean: h.ean || h.gtin || "",
          mpn: h.mpn || "",
          price: h.price,
          currency: h.currency,
          url: h.url,
          image: h.image,
          brand: inferBrand(h.title),
          gpu: inferGpuId(h.title) || inferGpuId(q),
          match_score: h.match_score,
          duplicate_of: dup,
          is_new: !dup,
        };
        candidates.push(cand);
        if (!dup) {
          // reserve so later queries don't re-add same ASIN
          if (cand.asin) sigs.asins.add(cand.asin.toUpperCase());
          if (cand.ean) sigs.eans.add(String(cand.ean).replace(/\D/g, ""));
          sigs.titles.add(String(cand.title).toLowerCase());
          addedForQuery++;
        }
      }
      console.log(
        `    hits=${hits.length} kept=${filtered.length} new≈${addedForQuery}`
      );
    } catch (err) {
      errors.push(`${q}: ${err.message}`);
      console.warn(`    ✗ ${err.message}`);
    }
  }

  const fresh = candidates.filter((c) => c.is_new);
  const report = {
    ran_at: new Date().toISOString(),
    source,
    country,
    queries: queries.length,
    candidates: candidates.length,
    new_candidates: fresh.length,
    errors,
    items: candidates,
  };
  saveJson(path.join(outDir, "discover_candidates.json"), report);

  let applied = 0;
  if (apply && fresh.length) {
    const sheet = laptopSheet(data);
    if (!reg.entries) reg.entries = {};
    for (const c of fresh.slice(0, 20)) {
      // Prefer hits with ASIN or EAN so later price enrich works
      if (!c.asin && !c.ean) continue;
      const draft = buildDraftRow(
        {
          title: c.title,
          asin: c.asin,
          ean: c.ean,
          gtin: c.ean,
          mpn: c.mpn,
          price: c.price,
          currency: c.currency,
          url: c.url,
          image: c.image,
          query: c.query,
        },
        { query: c.query }
      );
      // Avoid id collision
      if (sheet.rows.some((r) => r.id === draft.id) || reg.entries[draft.id]) {
        continue;
      }
      sheet.rows.push(draft);
      reg.entries[draft.id] = {
        model: draft.cells.col_model,
        asin: {
          uk: country === "de" ? "" : c.asin || "",
          de: country === "de" ? c.asin || "" : "",
        },
        ean: c.ean || "",
        mpn: c.mpn || "",
        geizhals_id: "",
        official_url: c.url || "",
        search_query: c.query,
        auto_draft: true,
        resolve_meta: {
          source,
          country,
          query: c.query,
          title: c.title,
          score: c.match_score,
          auto: true,
          discover: true,
          at: new Date().toISOString(),
        },
      };
      applied++;
      console.log(`  + draft ${draft.id}: ${draft.cells.col_model.slice(0, 60)}`);
    }
    if (applied) {
      saveJson(dataPath, data);
      saveJson(regPath, reg);
      console.log(
        `\nApplied ${applied} draft laptop(s). Run: npm run catalog:sync`
      );
      console.log(
        "  Drafts have col_status=draft — refine TGP/scores before relying on them."
      );
    }
  } else if (!apply && fresh.length) {
    console.log(
      `\n${fresh.length} new candidate(s) written. To add as draft catalog rows:`
    );
    console.log("  DISCOVER_APPLY=1 npm run catalog:discover");
    console.log("  or: npm run catalog:discover:apply");
  }

  console.log(`\ndiscover report: tools/out/discover_candidates.json`);
  console.log(
    `  total=${candidates.length} new=${fresh.length} applied=${applied} errors=${errors.length}`
  );
  return { candidates: candidates.length, fresh: fresh.length, applied };
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main };
