#!/usr/bin/env node
/**
 * Auto-resolve missing ASIN / EAN for sku_registry entries via metoda Price API.
 *
 * Uses topic=search_results + key=term (works on amazon for free-text),
 * then writes high-confidence ASIN/EAN back into tools/sku_registry.json.
 *
 *   node tools/resolve_identifiers.js
 *   npm run catalog:resolve
 *
 * Env:
 *   PRICEAPI_TOKEN          required
 *   RESOLVE_SOURCE          default amazon  (search_results + term)
 *   RESOLVE_COUNTRY         default gb
 *   RESOLVE_MAX             max products to resolve per run (default 12, credits!)
 *   RESOLVE_MIN_SCORE       0–1 match threshold (default 0.58)
 *   RESOLVE_DRY_RUN=1       report only, do not write registry
 *   RESOLVE_ONLY=id1,id2    optional id filter
 */
const path = require("path");
const {
  root,
  loadDotEnv,
  loadJson,
  saveJson,
  pickBestHit,
} = require("./lib/catalog_utils");
const {
  hasPriceApiKey,
  fetchSearchResults,
  parseSearchResults,
} = require("./lib/priceapi");

loadDotEnv();
if (process.argv.includes("--dry-run")) process.env.RESOLVE_DRY_RUN = "1";

const regPath = path.join(root, "tools", "sku_registry.json");
const outDir = path.join(root, "tools", "out");
const fs = require("fs");

async function main() {
  if (!hasPriceApiKey()) {
    console.log(
      "resolve_identifiers: set PRICEAPI_TOKEN in .env (metoda / priceapi.com)"
    );
    process.exitCode = 0;
    return { resolved: 0, skipped: 0 };
  }

  const source = (process.env.RESOLVE_SOURCE || "amazon").toLowerCase();
  const country = (process.env.RESOLVE_COUNTRY || process.env.PRICEAPI_COUNTRY || "gb").toLowerCase();
  const maxN = Math.min(
    40,
    Math.max(1, parseInt(process.env.RESOLVE_MAX || "12", 10) || 12)
  );
  const minScore = Number(process.env.RESOLVE_MIN_SCORE || "0.58");
  const dryRun = process.env.RESOLVE_DRY_RUN === "1";
  const only = new Set(
    (process.env.RESOLVE_ONLY || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const reg = loadJson(regPath);
  const missing = [];
  for (const [id, e] of Object.entries(reg.entries || {})) {
    if (e._orphan) continue;
    if (only.size && !only.has(id)) continue;
    const hasEan = !!(e.ean && String(e.ean).replace(/\D/g, "").length >= 8);
    const hasAsin = !!(e.asin?.uk || e.asin?.de);
    if (hasEan && hasAsin) continue;
    if (e.resolve_skip) continue;
    const q =
      e.search_query ||
      String(e.model || id)
        .replace(/\([^)]*\)/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!q) continue;
    missing.push({ id, e, q, hasEan, hasAsin });
  }

  // Prefer rows that lack both, then lack EAN
  missing.sort((a, b) => {
    const sa = (a.hasEan ? 0 : 2) + (a.hasAsin ? 0 : 1);
    const sb = (b.hasEan ? 0 : 2) + (b.hasAsin ? 0 : 1);
    return sb - sa;
  });

  const batch = missing.slice(0, maxN);
  console.log(
    `\nresolve_identifiers: ${batch.length}/${missing.length} missing via ${source}/${country} search_results (minScore=${minScore})${dryRun ? " [DRY RUN]" : ""}`
  );

  if (!batch.length) {
    console.log("  nothing to resolve");
    return { resolved: 0, skipped: 0, missing: 0 };
  }

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  let resolved = 0;
  let lowConfidence = 0;
  const log = [];
  const errors = [];

  // One job per term keeps matching reliable (API result grouping varies)
  for (const item of batch) {
    try {
      console.log(`  → ${item.id}: "${item.q}"`);
      const { jobId, results } = await fetchSearchResults({
        source,
        country,
        values: [item.q],
        max_pages: 1,
        max_age: process.env.PRICEAPI_MAX_AGE
          ? parseInt(process.env.PRICEAPI_MAX_AGE, 10)
          : 1440,
      });
      const hits = parseSearchResults(results, { values: [item.q] });
      const { best, ranked, accepted } = pickBestHit(item.q, hits, {
        minScore,
      });

      const entry = {
        id: item.id,
        query: item.q,
        job_id: jobId,
        hits: hits.length,
        accepted,
        best: best
          ? {
              title: best.title,
              asin: best.asin,
              ean: best.ean || best.gtin,
              price: best.price,
              currency: best.currency,
              match_score: best.match_score,
              url: best.url,
            }
          : null,
        alternatives: ranked.slice(0, 5).map((h) => ({
          title: h.title,
          asin: h.asin,
          ean: h.ean || h.gtin,
          score: h.match_score,
        })),
      };
      log.push(entry);

      if (!accepted || !best) {
        lowConfidence++;
        console.log(
          `    ✗ no confident match (best=${ranked[0]?.match_score?.toFixed(2) ?? "n/a"} title="${(ranked[0]?.title || "").slice(0, 60)}")`
        );
        if (!dryRun) {
          reg.entries[item.id].resolve_candidates = ranked.slice(0, 5).map((h) => ({
            title: h.title,
            asin: h.asin,
            ean: h.ean || h.gtin,
            score: h.match_score,
            url: h.url,
          }));
          reg.entries[item.id].resolve_checked_at = new Date().toISOString();
        }
        continue;
      }

      console.log(
        `    ✓ score=${best.match_score.toFixed(2)} asin=${best.asin || "—"} ean=${best.ean || best.gtin || "—"}`
      );
      console.log(`      ${best.title.slice(0, 90)}`);

      if (!dryRun) {
        if (best.asin) {
          if (country === "de") {
            if (!reg.entries[item.id].asin) reg.entries[item.id].asin = { uk: "", de: "" };
            if (!reg.entries[item.id].asin.de) reg.entries[item.id].asin.de = best.asin;
          } else {
            if (!reg.entries[item.id].asin) reg.entries[item.id].asin = { uk: "", de: "" };
            if (!reg.entries[item.id].asin.uk) reg.entries[item.id].asin.uk = best.asin;
          }
        }
        const ean = best.ean || best.gtin;
        if (ean && !reg.entries[item.id].ean) {
          reg.entries[item.id].ean = ean;
        }
        if (best.mpn && !reg.entries[item.id].mpn) {
          reg.entries[item.id].mpn = best.mpn;
        }
        reg.entries[item.id].resolve_meta = {
          source,
          country,
          query: item.q,
          title: best.title,
          score: best.match_score,
          job_id: jobId,
          at: new Date().toISOString(),
          auto: true,
        };
        reg.entries[item.id].last_sync = new Date().toISOString();
        delete reg.entries[item.id].resolve_candidates;
      }
      resolved++;
    } catch (err) {
      errors.push(`${item.id}: ${err.message}`);
      console.warn(`    ✗ ${err.message}`);
    }
  }

  if (!dryRun) saveJson(regPath, reg);
  saveJson(path.join(outDir, "resolve_log.json"), {
    ran_at: new Date().toISOString(),
    source,
    country,
    resolved,
    low_confidence: lowConfidence,
    errors,
    items: log,
  });

  console.log(
    `\nresolve_identifiers: resolved=${resolved} low_confidence=${lowConfidence} errors=${errors.length}`
  );
  console.log(`  log: tools/out/resolve_log.json`);
  if (lowConfidence) {
    console.log(
      "  Tip: open resolve_log.json alternatives → paste correct ASIN/EAN into sku_registry.json"
    );
  }
  return { resolved, lowConfidence, errors };
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main };
