#!/usr/bin/env node
/**
 * Sonar-powered: find new laptops → retail IDs (ASIN/EAN) → street prices.
 *
 *   npm run catalog:sonar:discover
 *   npm run catalog:sonar:discover -- --dry-run
 *   npm run catalog:sonar:discover -- --max-queries 5
 *
 * Env:
 *   PERPLEXITY_API_KEY
 *   SONAR_DELAY_MS / SONAR_MAX (pacing)
 *   SONAR_DISCOVER_APPLY=0  dry-run candidates only
 *
 * Honesty:
 *   - Prices are research-sourced from web (Sonar citations), tied to ASIN when found.
 *   - Marked price_source=sonar_listing, price_verified=false until a human opens the page.
 *   - Never invents ASINs (format-validated B0…).
 */
const fs = require("fs");
const path = require("path");
const {
  root,
  loadDotEnv,
  loadJson,
  saveJson,
  laptopSheet,
  existingSignatures,
  isDuplicateHit,
  buildDraftRow,
  inferBrand,
  inferGpuId,
} = require("./lib/catalog_utils");
const { hasSonarKey, sonarChat, sonarDelayMs } = require("./lib/sonar");
const { pickRetailIds, hasRetailIds, normalizeAsin, normalizeEan } = require("./lib/sku_ids");
const { ensurePerfTemplate, ensureImageFromAsin } = require("./lib/perf_templates");
const hygiene = require("./catalog_hygiene");

loadDotEnv();

const queriesPath = path.join(root, "tools", "discover_queries.json");
const dataPath = path.join(root, "data.json");
const regPath = path.join(root, "tools", "sku_registry.json");
const outDir = path.join(root, "tools", "out");

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    dryRun: process.env.SONAR_DISCOVER_APPLY === "0",
    maxQueries: null,
    skipVerify: false,
    query: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run" || a === "--dry") out.dryRun = true;
    else if (a === "--apply") out.dryRun = false;
    else if (a === "--skip-verify") out.skipVerify = true;
    else if ((a === "--max-queries" || a === "--max") && argv[i + 1]) {
      out.maxQueries = parseInt(argv[++i], 10);
    } else if (a === "--query" && argv[i + 1]) {
      out.query = argv[++i];
    } else if (/^\d+$/.test(a) && out.maxQueries == null) {
      out.maxQueries = parseInt(a, 10);
    }
  }
  return out;
}

const DISCOVER_SYSTEM = `You are an EU/UK laptop retail researcher.
Return ONLY valid JSON (no markdown). Never invent Amazon ASINs or EANs.
If you include an ASIN it MUST come from a real amazon.co.uk or amazon.de product URL you found.
Prefer currently sellable retail configs (not rare CTO-only).

Schema:
{
  "products": [
    {
      "model": string,
      "brand": string,
      "gpu": string,
      "cpu": string,
      "ram": string,
      "storage": string,
      "config_one_liner": string,
      "asin_uk": string|null,
      "asin_de": string|null,
      "ean": string|null,
      "mpn": string|null,
      "amazon_uk_url": string|null,
      "amazon_de_url": string|null,
      "price_gbp": number|null,
      "price_eur": number|null,
      "availability": "retail"|"limited"|"clearance"|"aftermarket",
      "confidence": "high"|"medium"|"low",
      "notes": string,
      "why_new": string
    }
  ]
}`;

const VERIFY_SYSTEM = `You verify a specific Amazon product listing for EU/UK shoppers.
Return ONLY JSON. Never invent ASINs. If the page/ASIN cannot be confirmed, set confirmed=false.

{
  "confirmed": boolean,
  "title": string|null,
  "asin": string|null,
  "price_gbp": number|null,
  "price_eur": number|null,
  "currency_seen": "GBP"|"EUR"|null,
  "in_stock_hint": string|null,
  "matches_config": boolean|null,
  "confidence": "high"|"medium"|"low",
  "note": string
}`;

function parseProducts(parsed) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.products)) return parsed.products;
  if (Array.isArray(parsed.results)) return parsed.results;
  if (parsed.model || parsed.asin_uk || parsed.asin) return [parsed];
  return [];
}

function existingModelList(data) {
  const sheet = laptopSheet(data);
  return (sheet.rows || [])
    .map((r) => String(r.cells?.col_model || r.id))
    .slice(0, 80);
}

async function discoverQuery(query, existingNames) {
  const prompt = `Find currently available retail laptop configs in UK/EU matching this search intent:

"${query}"

Already in our catalog (do NOT repeat these or near-duplicates):
${existingNames
  .slice(0, 40)
  .map((n) => `- ${n}`)
  .join("\n")}

Return up to 4 DISTINCT sellable configs with:
- model name + GPU class matching the query when possible
- Amazon UK ASIN (B0…) and amazon.co.uk/dp/… URL when you can evidence them
- EAN if published
- current street price_gbp and/or price_eur
- short config_one_liner (CPU · GPU · RAM · SSD)
- confidence high only if ASIN URL is solid

Prefer value gaming / creator laptops with discrete NVIDIA GPUs or Apple Silicon. Skip bags/accessories.`;

  const { parsed, citations, model } = await sonarChat({
    prompt,
    system: DISCOVER_SYSTEM,
    json: true,
  });
  return {
    products: parseProducts(parsed),
    citations,
    model,
    raw: parsed,
  };
}

async function verifyListing(cand) {
  const ids = pickRetailIds(cand);
  if (!ids.asin_uk && !ids.asin_de) {
    return { confirmed: false, note: "no ASIN to verify" };
  }
  const asin = ids.asin_uk || ids.asin_de;
  const url =
    (ids.asin_uk && ids.amazon_uk_url) ||
    (ids.asin_de && ids.amazon_de_url) ||
    "";
  const market = ids.asin_uk ? "UK" : "DE";

  const prompt = `Verify this Amazon ${market} listing for catalog use.

Expected model/config: ${cand.model || cand.title || "?"}
GPU hint: ${cand.gpu || ""}
ASIN: ${asin}
URL: ${url || "(none)"}
Claimed price GBP: ${cand.price_gbp ?? "?"} · EUR: ${cand.price_eur ?? "?"}

Confirm the ASIN/page is a real laptop matching the config (same GPU class).
Return current street price if visible, and confirmed=true only if listing matches.`;

  const { parsed } = await sonarChat({
    prompt,
    system: VERIFY_SYSTEM,
    json: true,
  });
  return parsed && typeof parsed === "object"
    ? parsed
    : { confirmed: false, note: "no JSON" };
}

function normalizeCandidate(p, query) {
  const ids = pickRetailIds(p);
  const model = String(p.model || p.title || p.model_name || "").trim();
  if (!model) return null;

  let price_gbp =
    p.price_gbp != null && !isNaN(Number(p.price_gbp))
      ? Math.round(Number(p.price_gbp))
      : null;
  let price_eur =
    p.price_eur != null && !isNaN(Number(p.price_eur))
      ? Math.round(Number(p.price_eur))
      : null;

  return {
    query,
    model,
    brand: p.brand || inferBrand(model),
    gpu: p.gpu || inferGpuId(model) || "",
    cpu: p.cpu || "",
    ram: p.ram || "",
    storage: p.storage || "",
    config: p.config_one_liner || p.config || "",
    notes: p.notes || p.why_new || "",
    confidence: String(p.confidence || "low").toLowerCase(),
    availability: p.availability || "retail",
    ...ids,
    price_gbp,
    price_eur,
    verify: null,
  };
}

function applyCandidate(cand, data, reg, sigs) {
  const hit = {
    title: cand.model,
    asin: cand.asin_uk || cand.asin_de || "",
    ean: cand.ean || "",
    gtin: cand.ean || "",
    mpn: cand.mpn || "",
    price: cand.price_gbp || cand.price_eur,
    currency: cand.price_gbp != null ? "GBP" : cand.price_eur != null ? "EUR" : null,
    url: cand.amazon_uk_url || cand.amazon_de_url || "",
    image: null,
    query: cand.query,
  };

  const draft = buildDraftRow(hit, { query: cand.query });
  const sheet = laptopSheet(data);
  if (sheet.rows.some((r) => r.id === draft.id) || reg.entries[draft.id]) {
    return { applied: false, reason: "id_collision", id: draft.id };
  }

  // Prices
  if (cand.price_gbp != null) {
    draft.cells.col_price.GBP = cand.price_gbp;
    draft.cells.col_detail.price_gbp = cand.price_gbp;
  }
  if (cand.price_eur != null) {
    draft.cells.col_price.EUR = cand.price_eur;
    draft.cells.col_detail.price_eur = cand.price_eur;
  } else if (cand.price_gbp != null) {
    draft.cells.col_price.EUR = Math.round(cand.price_gbp * 1.15);
    draft.cells.col_detail.price_eur = draft.cells.col_price.EUR;
  }

  if (cand.config) {
    draft.cells.col_config = cand.config;
    draft.cells.col_detail.priced_config = cand.config;
  }
  if (cand.cpu) draft.cells.col_cpu = cand.cpu;
  if (cand.ram) draft.cells.col_ram = cand.ram;
  if (cand.notes) {
    draft.cells.col_notes =
      cand.notes +
      " [AUTO-DRAFT via Sonar discover — confirm ASIN page & price before promoting.]";
  }

  const v = cand.verify || {};
  const listingChecked = !!(
    v.confirmed &&
    (normalizeAsin(v.asin) === cand.asin_uk ||
      normalizeAsin(v.asin) === cand.asin_de) &&
    (v.confidence === "high" || v.confidence === "medium")
  );

  // Prefer verify prices when verify returned them
  if (v.price_gbp != null && !isNaN(Number(v.price_gbp))) {
    draft.cells.col_price.GBP = Math.round(Number(v.price_gbp));
    draft.cells.col_detail.price_gbp = draft.cells.col_price.GBP;
  }
  if (v.price_eur != null && !isNaN(Number(v.price_eur))) {
    draft.cells.col_price.EUR = Math.round(Number(v.price_eur));
    draft.cells.col_detail.price_eur = draft.cells.col_price.EUR;
  }

  draft.cells.col_status = "draft";
  draft.cells.col_detail.auto_draft = true;
  draft.cells.col_detail.sku_map = {
    asin_uk: cand.asin_uk || "",
    asin_de: cand.asin_de || "",
    ean: cand.ean || "",
    mpn: cand.mpn || "",
    official_url: cand.amazon_uk_url || cand.amazon_de_url || "",
    search_query: cand.query,
    price_verified: listingChecked,
    price_source: listingChecked ? "sonar_verified" : "sonar_research",
    ids_source: "sonar",
    ids_confidence: cand.confidence,
    verify_note: v.note || null,
    verify_confidence: v.confidence || null,
  };
  if (cand.availability) {
    draft.cells.col_detail.availability =
      draft.cells.col_detail.availability || {};
    draft.cells.col_detail.availability.status = cand.availability;
  }

  sheet.rows.push(draft);
  reg.entries[draft.id] = {
    model: cand.model,
    asin: {
      uk: cand.asin_uk || "",
      de: cand.asin_de || "",
    },
    ean: cand.ean || "",
    mpn: cand.mpn || "",
    geizhals_id: "",
    official_url: cand.amazon_uk_url || cand.amazon_de_url || "",
    listing_url: cand.amazon_uk_url || cand.amazon_de_url || "",
    search_query: cand.query,
    auto_draft: true,
    price_verified: listingChecked,
    resolve_meta: {
      source: "sonar_discover",
      auto: true,
      confidence: cand.confidence,
      verified: listingChecked,
      at: new Date().toISOString(),
    },
  };

  // update sigs
  if (cand.asin_uk) sigs.asins.add(cand.asin_uk.toUpperCase());
  if (cand.asin_de) sigs.asins.add(cand.asin_de.toUpperCase());
  if (cand.ean) sigs.eans.add(String(cand.ean).replace(/\D/g, ""));
  sigs.titles.add(cand.model.toLowerCase());

  return { applied: true, id: draft.id, listingChecked };
}

async function main() {
  if (!hasSonarKey()) {
    console.log("Set PERPLEXITY_API_KEY in .env first");
    process.exitCode = 0;
    return;
  }

  const cli = parseArgs();
  // Default: APPLY (user wants full JTBD). --dry-run to skip.
  const apply = !cli.dryRun;
  const skipVerify = cli.skipVerify;

  const seed = loadJson(queriesPath);
  let queries = cli.query
    ? [cli.query]
    : (seed.queries || []).slice();
  if (cli.maxQueries != null && cli.maxQueries > 0) {
    queries = queries.slice(0, cli.maxQueries);
  }

  const data = loadJson(dataPath);
  const reg = loadJson(regPath);
  if (!reg.entries) reg.entries = {};
  const sigs = existingSignatures(data, reg);
  const existingNames = existingModelList(data);

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  console.log(
    `\nsonar_discover: ${queries.length} quer${queries.length === 1 ? "y" : "ies"} · apply=${apply} · verify=${!skipVerify} · delay=${sonarDelayMs()}ms\n`
  );

  const allCandidates = [];
  const report = {
    ran_at: new Date().toISOString(),
    queries: [],
    applied: [],
    skipped: [],
    errors: [],
  };

  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi];
    console.log(`[${qi + 1}/${queries.length}] discover “${q}”`);
    try {
      const { products, citations } = await discoverQuery(q, existingNames);
      console.log(`  → ${products.length} product(s) returned`);
      const qReport = { query: q, products: products.length, kept: [] };

      for (const p of products) {
        const cand = normalizeCandidate(p, q);
        if (!cand) continue;

        const dup = isDuplicateHit(
          {
            title: cand.model,
            asin: cand.asin_uk || cand.asin_de,
            ean: cand.ean,
            gtin: cand.ean,
          },
          sigs
        );
        if (dup) {
          console.log(`  · skip dup (${dup}): ${cand.model.slice(0, 50)}`);
          report.skipped.push({ model: cand.model, reason: "duplicate:" + dup });
          continue;
        }

        // Prefer candidates with at least one retail id OR high confidence + price
        const idsOk = hasRetailIds(cand);
        if (!idsOk && cand.confidence === "low") {
          console.log(`  · skip weak (no ASIN/EAN): ${cand.model.slice(0, 50)}`);
          report.skipped.push({ model: cand.model, reason: "no_ids_low_conf" });
          continue;
        }

        // Verify price against ASIN when possible
        if (!skipVerify && (cand.asin_uk || cand.asin_de)) {
          process.stdout.write(`  · verify ${cand.asin_uk || cand.asin_de} … `);
          try {
            cand.verify = await verifyListing(cand);
            console.log(
              cand.verify?.confirmed
                ? `ok £${cand.verify.price_gbp ?? "?"} conf=${cand.verify.confidence}`
                : `weak (${cand.verify?.note || cand.verify?.confidence || "no"})`
            );
          } catch (e) {
            console.log(`err ${e.message}`);
            cand.verify = { confirmed: false, note: e.message };
          }
        }

        allCandidates.push(cand);
        qReport.kept.push({
          model: cand.model,
          asin: cand.asin_uk || cand.asin_de,
          ean: cand.ean,
          price_gbp: cand.price_gbp,
          verified: !!(cand.verify && cand.verify.confirmed),
        });

        if (apply) {
          // Skip if ASIN already in catalog (hard dedupe at insert time)
          const a = cand.asin_uk || cand.asin_de;
          if (a && sigs.asins.has(String(a).toUpperCase())) {
            console.log(`  · skip existing ASIN ${a}`);
            report.skipped.push({ model: cand.model, reason: "asin_exists" });
            continue;
          }
          const res = applyCandidate(cand, data, reg, sigs);
          if (res.applied) {
            // Immediate fill: FPS template + ASIN image
            const row = laptopSheet(data).rows.find((r) => r.id === res.id);
            if (row) {
              ensureImageFromAsin(row);
              ensurePerfTemplate(row);
            }
            console.log(
              `  + draft ${res.id}${res.listingChecked ? " (price sonar-checked)" : ""}`
            );
            report.applied.push(res);
            existingNames.push(cand.model);
            saveJson(dataPath, data);
            saveJson(regPath, reg);
          } else {
            report.skipped.push({ model: cand.model, reason: res.reason });
          }
        }
      }
      report.queries.push(qReport);
    } catch (e) {
      console.warn(`  ✗ ${e.message}`);
      report.errors.push({ query: q, error: e.message });
      if (/rate limit after/i.test(e.message)) {
        console.warn("Rate limit exhausted — progress saved. Re-run to continue.");
        break;
      }
    }
  }

  // Automatic hygiene after batch (dedupe, promote, templates)
  if (apply && report.applied.length) {
    console.log("\n→ catalog hygiene (dedupe / promote / templates)…");
    try {
      hygiene.main();
    } catch (e) {
      console.warn("  hygiene:", e.message);
    }
  }

  report.candidates = allCandidates;
  saveJson(path.join(outDir, "sonar_discover.json"), report);

  console.log(`\nDone. candidates=${allCandidates.length} applied=${report.applied.length} skipped=${report.skipped.length}`);
  console.log(`Report: tools/out/sonar_discover.json`);
  if (apply && report.applied.length) {
    console.log("\nNext: npm run catalog:sync  (buy links + embed — hygiene already ran)");
  } else if (!apply) {
    console.log("Dry-run only. Re-run without --dry-run (or with --apply) to add drafts.");
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main, normalizeCandidate, discoverQuery, verifyListing };
