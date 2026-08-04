#!/usr/bin/env node
/**
 * Flesh out laptop details + (optionally) retail listing IDs via Perplexity Sonar.
 *
 *   npm run catalog:sonar:ids          # ALL rows missing ASIN/EAN (paced)
 *   npm run catalog:sonar:unenriched   # ALL rows never Sonar-enriched
 *   npm run catalog:sonar -- --id lap_xxx
 *   npm run catalog:sonar -- unenriched --max 5   # optional cap
 *
 * Batch size:
 *   --max all | --max 0 | SONAR_MAX=0   process every match (default for bulk jobs)
 *   --max 5 | SONAR_MAX=5               stop after N rows
 * Progress is saved after each row — Ctrl+C and re-run resumes remaining work.
 *
 * Requires PERPLEXITY_API_KEY in .env
 *
 * Honesty: ASINs/EANs from Sonar are research-sourced (web citations).
 * We validate format only — they are NOT "listing-checked" until a human opens the page.
 * Never invent IDs; never overwrite human_listing / price_verified mappings.
 */
const path = require("path");
const {
  root,
  loadDotEnv,
  loadJson,
  saveJson,
  laptopSheet,
} = require("./lib/catalog_utils");
const {
  hasSonarKey,
  sonarChat,
  sonarDelayMs,
  sonarDefaultMax,
} = require("./lib/sonar");

loadDotEnv();

/**
 * Robust CLI parse (Windows npm often mangles flags).
 * Supports:
 *   --status unenriched | --status=unenriched | unenriched (positional)
 *   --max 3 | --max=3
 *   --id lap_xxx | --id=lap_xxx
 */
function parseArgs(argv = process.argv.slice(2)) {
  const out = { status: null, max: null, id: null, idsOnly: false, positional: [] };
  const STATUS_WORDS = new Set([
    "draft",
    "unenriched",
    "missing",
    "noids",
    "missing-ids",
    "ids",
    "all",
    "top",
    "consider",
    "alt",
    "pass",
  ]);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;

    // --key=value
    const eq = a.match(/^--([a-zA-Z0-9_-]+)=(.*)$/);
    if (eq) {
      const k = eq[1].toLowerCase();
      const v = eq[2];
      if (k === "status") out.status = v;
      else if (k === "max") out.max = v;
      else if (k === "id") out.id = v;
      else if (k === "ids-only" || k === "ids_only") out.idsOnly = true;
      continue;
    }

    // --key value
    if (a.startsWith("--")) {
      const k = a.slice(2).toLowerCase();
      const next = argv[i + 1];
      const nextIsVal = next != null && !String(next).startsWith("--");
      if (k === "status" && nextIsVal) {
        out.status = next;
        i++;
      } else if (k === "max" && nextIsVal) {
        out.max = next;
        i++;
      } else if (k === "id" && nextIsVal) {
        out.id = next;
        i++;
      } else if (k === "ids-only" || k === "ids_only") {
        out.idsOnly = true;
      }
      continue;
    }

    // bare tokens (npm on Windows sometimes strips --flags)
    if (a.toLowerCase() === "ids-only") {
      out.idsOnly = true;
      continue;
    }
    if (STATUS_WORDS.has(a.toLowerCase()) && !out.status) {
      out.status = a.toLowerCase();
      continue;
    }
    if (/^\d+$/.test(a) && out.max == null) {
      out.max = a;
      continue;
    }
    if (/^(all|unlimited|inf)$/i.test(a) && out.max == null) {
      out.max = "all";
      continue;
    }
    if (/^lap_/i.test(a) && !out.id) {
      out.id = a;
      continue;
    }
    out.positional.push(a);
  }

  return out;
}

const SYSTEM = `You research specific laptop SKUs for EU/UK shoppers using live web results.
Return ONLY a JSON object (no markdown) with these keys.
Use null when you cannot find a real source — NEVER invent or guess ASINs, EANs, or barcodes.
If you return an ASIN, it MUST appear on a real Amazon product URL you found (…/dp/B0…).
If you return an EAN/GTIN, it MUST appear on a retailer/spec page you found.

{
  "model_name": string,
  "cpu": string,
  "gpu": string,
  "gpu_tgp_w": string,
  "ram": string,
  "storage": string,
  "display": string,
  "battery_wh": number|null,
  "weight_kg": number|null,
  "chassis_material": string,
  "chassis_grade": "plastic"|"hybrid"|"metal"|"premium",
  "ports_summary": string,
  "price_gbp_street": number|null,
  "price_eur_street": number|null,
  "availability": "retail"|"limited"|"clearance"|"aftermarket",
  "scores": {
    "gaming": number, "gpu": number, "cpu": number, "battery": number,
    "thermals": number, "display": number, "build": number
  },
  "config_one_liner": string,
  "notes": string,
  "confidence": "high"|"medium"|"low",
  "sources_note": string,
  "asin_uk": string|null,
  "asin_de": string|null,
  "ean": string|null,
  "mpn": string|null,
  "amazon_uk_url": string|null,
  "amazon_de_url": string|null,
  "ids_confidence": "high"|"medium"|"low"|null,
  "ids_note": string|null
}
Scores 1–10 vs midrange gaming laptops. Prefer review-backed TGP/battery.
Retail IDs: prefer UK Amazon for asin_uk; only fill what you can evidence.`;

function looksLikeAsin(s) {
  const v = String(s || "").trim().toUpperCase();
  // Amazon ASINs are 10 alphanumeric; laptop ASINs are almost always B0…
  if (!/^[A-Z0-9]{10}$/.test(v)) return "";
  if (!/^B0[A-Z0-9]{8}$/.test(v)) return ""; // strict: modern catalog ASINs
  return v;
}

function looksLikeEan(s) {
  const digits = String(s || "").replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(digits.length)) return "";
  // reject obviously fake runs
  if (/^(\d)\1+$/.test(digits)) return "";
  if (digits === "0000000000000" || digits === "000000000000") return "";
  return digits;
}

function asinFromUrl(url) {
  const m = String(url || "").match(
    /\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})(?:[/?]|$)/i
  );
  return m ? looksLikeAsin(m[1]) : "";
}

function applyRetailIds(parsed, regEntry, det, { forceIds = false } = {}) {
  const filled = [];
  if (!regEntry.asin) regEntry.asin = { uk: "", de: "" };
  if (!det.sku_map) det.sku_map = {};
  const sm = det.sku_map;

  // Human listing-checked rows: never overwrite ASINs/EANs
  const locked =
    sm.price_verified ||
    sm.price_source === "human_listing" ||
    regEntry.price_verified;

  const fromUrlUk = asinFromUrl(parsed.amazon_uk_url);
  const fromUrlDe = asinFromUrl(parsed.amazon_de_url);
  const asinUk = looksLikeAsin(parsed.asin_uk) || fromUrlUk;
  const asinDe = looksLikeAsin(parsed.asin_de) || fromUrlDe;
  const ean = looksLikeEan(parsed.ean);
  const mpn = String(parsed.mpn || "").trim().slice(0, 48);

  const idsConf = String(parsed.ids_confidence || parsed.confidence || "low").toLowerCase();
  // Only auto-write medium/high for IDs; low stays candidates only
  const writeOk = forceIds || idsConf === "high" || idsConf === "medium";

  const candidates = {
    asin_uk: asinUk || null,
    asin_de: asinDe || null,
    ean: ean || null,
    mpn: mpn || null,
    amazon_uk_url: parsed.amazon_uk_url || null,
    amazon_de_url: parsed.amazon_de_url || null,
    ids_confidence: idsConf,
    ids_note: parsed.ids_note || null,
  };

  if (!writeOk || locked) {
    sm.sonar_id_candidates = candidates;
    sm.sonar_ids_at = new Date().toISOString();
    return {
      filled,
      candidates,
      locked: !!locked,
      skipped: writeOk ? "locked" : "low_confidence",
    };
  }

  if (asinUk && !regEntry.asin.uk && !sm.asin_uk) {
    regEntry.asin.uk = asinUk;
    sm.asin_uk = asinUk;
    filled.push("asin_uk=" + asinUk);
  }
  if (asinDe && !regEntry.asin.de && !sm.asin_de) {
    regEntry.asin.de = asinDe;
    sm.asin_de = asinDe;
    filled.push("asin_de=" + asinDe);
  }
  if (ean && !regEntry.ean && !sm.ean) {
    regEntry.ean = ean;
    sm.ean = ean;
    filled.push("ean=" + ean);
  }
  if (mpn && !regEntry.mpn && !sm.mpn) {
    regEntry.mpn = mpn;
    sm.mpn = mpn;
    filled.push("mpn=" + mpn);
  }

  if (filled.length) {
    sm.ids_source = "sonar";
    sm.ids_confidence = idsConf;
    sm.ids_note = parsed.ids_note || null;
    sm.price_verified = false; // research-found ≠ human listing-checked
    if (parsed.amazon_uk_url && !sm.official_url && !regEntry.listing_url) {
      regEntry.listing_url = String(parsed.amazon_uk_url);
      sm.official_url = String(parsed.amazon_uk_url);
    }
    regEntry.resolve_meta = {
      ...(regEntry.resolve_meta || {}),
      source: "sonar",
      auto: true,
      confidence: idsConf,
      at: new Date().toISOString(),
      note: parsed.ids_note || null,
    };
  } else {
    sm.sonar_id_candidates = candidates;
  }
  sm.sonar_ids_at = new Date().toISOString();
  return { filled, candidates, locked: false, skipped: filled.length ? null : "none_new" };
}

function rowMissingRetailIds(row, regEntry) {
  const sm = row.cells?.col_detail?.sku_map || {};
  const asin =
    sm.asin_uk ||
    sm.asin_de ||
    regEntry?.asin?.uk ||
    regEntry?.asin?.de ||
    "";
  const ean = sm.ean || regEntry?.ean || "";
  return !asin && !ean;
}

async function enrichRow(row, regEntry, opts = {}) {
  const idsOnly = !!opts.idsOnly;
  const c = row.cells;
  const det = c.col_detail || {};
  const sku = det.sku_map || {};
  const asin =
    sku.asin_uk ||
    sku.asin_de ||
    regEntry?.asin?.uk ||
    regEntry?.asin?.de ||
    "";
  const ean = sku.ean || regEntry?.ean || "";
  const url =
    regEntry?.listing_url || regEntry?.official_url || c.col_url || "";

  const idFocus = idsOnly || !asin || !ean;

  const prompt = idsOnly
    ? `Find REAL retail listing identifiers for this laptop (EU/UK preference).

Display name: ${c.col_model}
Brand: ${c.col_brand}
GPU: ${c.col_gpu}
CPU: ${c.col_cpu}
Config: ${c.col_config || det.priced_config || ""}
Known ASIN: ${asin || "none"}
Known EAN: ${ean || "none"}

Search Amazon.co.uk / Amazon.de / Geizhals / manufacturer for the closest matching retail config (same GPU class).
Return JSON with asin_uk, asin_de, ean, mpn, amazon_uk_url, amazon_de_url, ids_confidence, ids_note, plus brief config_one_liner and notes if clear.
If you cannot find a real listing, set all id fields to null — do not invent B0… strings.`
    : `Research this exact laptop config for a shopping catalog.

Display name: ${c.col_model}
Brand: ${c.col_brand}
GPU id hint: ${c.col_gpu}
Known ASIN: ${asin || "unknown"}
Known EAN: ${ean || "unknown"}
Listing URL: ${url || "unknown"}
Current price fields: GBP ${c.col_price?.GBP ?? "?"} · EUR ${c.col_price?.EUR ?? "?"}
Config hint: ${c.col_config || det.priced_config || ""}

1) Specs: TGP for THIS chassis, dual-channel RAM, battery Wh, weight, chassis grade, honest notes, scores.
2) Retail IDs: if ASIN/EAN unknown, search Amazon UK/DE for a matching listing and return asin_uk / ean only when evidenced by a real product page URL.
Street prices optional (GBP UK / EUR DE). Never invent ASINs or EANs.`;

  const { parsed, citations, model } = await sonarChat({
    prompt,
    system: SYSTEM,
    json: true,
  });

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "no JSON from Sonar" };
  }

  // Apply carefully — never clobber SKU-verified price or hard IDs
  const verified =
    sku.price_verified ||
    regEntry?.price_verified ||
    det.sku_map?.price_source === "human_listing";

  if (parsed.model_name && c.col_status === "draft") {
    // keep human title unless it's a placeholder
    if (/^Amazon B0|^Untitled/i.test(c.col_model)) {
      c.col_model = parsed.model_name;
    }
  }
  if (parsed.cpu) c.col_cpu = parsed.cpu;
  if (parsed.display) c.col_display = parsed.display;
  if (parsed.ram) c.col_ram = parsed.ram;
  if (parsed.battery_wh != null && !isNaN(Number(parsed.battery_wh))) {
    c.col_battery = Number(parsed.battery_wh);
  }
  if (parsed.weight_kg != null && !isNaN(Number(parsed.weight_kg))) {
    c.col_weight = Number(parsed.weight_kg);
  }
  if (parsed.config_one_liner) {
    c.col_config = parsed.config_one_liner;
    det.priced_config = parsed.config_one_liner;
  }
  if (!idsOnly) {
    if (parsed.notes) c.col_notes = parsed.notes;

    if (!verified) {
      if (parsed.price_gbp_street != null) {
        c.col_price = c.col_price || {};
        c.col_price.GBP = Math.round(Number(parsed.price_gbp_street));
        det.price_gbp = c.col_price.GBP;
      }
      if (parsed.price_eur_street != null) {
        c.col_price = c.col_price || {};
        c.col_price.EUR = Math.round(Number(parsed.price_eur_street));
        det.price_eur = c.col_price.EUR;
      }
    }

    if (parsed.scores && typeof parsed.scores === "object") {
      const map = {
        gaming: "col_s_gaming",
        gpu: "col_s_gpu",
        cpu: "col_s_cpu",
        battery: "col_s_battery",
        thermals: "col_s_thermals",
        display: "col_s_display",
        build: "col_s_build",
      };
      for (const [k, col] of Object.entries(map)) {
        if (parsed.scores[k] != null) c[col] = Number(parsed.scores[k]);
      }
    }

    det.processor = det.processor || {};
    if (parsed.cpu) det.processor.model = parsed.cpu;
    det.graphics = det.graphics || {};
    if (parsed.gpu) det.graphics.model = parsed.gpu;
    if (parsed.gpu_tgp_w) det.graphics.tgp_this_chassis_w = parsed.gpu_tgp_w;
    det.memory = det.memory || {};
    if (parsed.ram) det.memory.installed = parsed.ram;
    det.storage = det.storage || {};
    if (parsed.storage) det.storage.primary = parsed.storage;
    det.battery = det.battery || {};
    if (parsed.battery_wh != null) det.battery.capacity_wh = Number(parsed.battery_wh);
    det.chassis = det.chassis || {};
    if (parsed.chassis_material) det.chassis.material = parsed.chassis_material;
    if (parsed.chassis_grade) det.chassis.grade = parsed.chassis_grade;
    if (parsed.weight_kg != null) det.chassis.weight_kg = Number(parsed.weight_kg);
    det.availability = det.availability || {};
    if (parsed.availability) det.availability.status = parsed.availability;
    det.availability.checked = new Date().toISOString().slice(0, 10);
  } else if (parsed.notes && !c.col_notes) {
    c.col_notes = parsed.notes;
  }

  // Retail listing IDs (ASIN/EAN) — format-validated, not listing-checked
  const idResult = applyRetailIds(parsed, regEntry, det, {
    forceIds: false,
  });

  det.sonar = {
    model,
    confidence: parsed.confidence || null,
    sources_note: parsed.sources_note || null,
    citations: citations.slice(0, 12),
    enriched_at: new Date().toISOString(),
    price_left_alone: !!verified,
    ids_only: idsOnly,
    ids_filled: idResult.filled,
    ids_confidence: parsed.ids_confidence || null,
    ids_note: parsed.ids_note || null,
  };
  // Only mark auto_draft on actual drafts — don't demote top/consider rows
  if (c.col_status === "draft") det.auto_draft = true;
  c.col_detail = det;

  return {
    ok: true,
    confidence: parsed.confidence,
    verified,
    ids_filled: idResult.filled,
    ids_skipped: idResult.skipped,
  };
}

async function main() {
  if (!hasSonarKey()) {
    console.log(`catalog:sonar needs PERPLEXITY_API_KEY in .env
  Get a key: https://www.perplexity.ai/api-platform
  Then: npm run catalog:sonar`);
    process.exitCode = 0;
    return;
  }

  const cli = parseArgs(process.argv.slice(2));
  const onlyId = cli.id;
  // draft | unenriched | noids | all | top | consider | alt | pass
  let status = cli.status || "draft";
  const idsOnly =
    !!cli.idsOnly ||
    status === "noids" ||
    status === "missing-ids" ||
    status === "ids";
  if (idsOnly && (status === "draft" || status === "ids")) status = "noids";

  // Bulk jobs default to ALL matching rows. Cap only if --max N or SONAR_MAX=N.
  // 0 / "all" = unlimited.
  const bulkJob =
    idsOnly ||
    status === "unenriched" ||
    status === "missing" ||
    status === "noids" ||
    status === "missing-ids" ||
    status === "all";
  const envDefault = sonarDefaultMax(); // 0 = all
  let maxN;
  if (cli.max != null && cli.max !== "") {
    const raw = String(cli.max).toLowerCase();
    if (raw === "all" || raw === "unlimited" || raw === "inf" || raw === "0") {
      maxN = 0;
    } else {
      maxN = Math.max(0, parseInt(raw, 10) || 0);
    }
  } else if (onlyId) {
    maxN = 1;
  } else if (bulkJob) {
    // Unlimited unless env sets a positive SONAR_MAX
    maxN = envDefault;
  } else {
    // draft / status filters: env default, or all if 0
    maxN = envDefault;
  }

  const delayMs = sonarDelayMs();
  const maxLabel = maxN === 0 ? "all" : String(maxN);
  console.log(
    `args: status=${status} max=${maxLabel} id=${onlyId || "—"} idsOnly=${idsOnly} delay=${delayMs}ms  (raw: ${process.argv.slice(2).join(" ") || "∅"})`
  );
  console.log(
    `  pacing: SONAR_DELAY_MS=${delayMs} · save-after-each-row · re-run skips finished`
  );

  const dataPath = path.join(root, "data.json");
  const regPath = path.join(root, "tools", "sku_registry.json");
  const data = loadJson(dataPath);
  const reg = loadJson(regPath);
  const sheet = laptopSheet(data);

  const byStatus = {};
  let withoutSonar = 0;
  for (const r of sheet.rows) {
    const st = r.cells.col_status || "(empty)";
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (!r.cells.col_detail?.sonar) withoutSonar++;
  }

  function matches(r) {
    if (onlyId) return r.id === onlyId;
    if (status === "all") return true;
    if (status === "unenriched" || status === "missing") {
      return !r.cells.col_detail?.sonar;
    }
    if (status === "noids" || status === "missing-ids" || status === "ids") {
      return rowMissingRetailIds(r, reg.entries?.[r.id] || {});
    }
    return (r.cells.col_status || "") === status;
  }

  let targets = sheet.rows.filter(matches);
  const missingIdsCount = sheet.rows.filter((r) =>
    rowMissingRetailIds(r, reg.entries?.[r.id] || {})
  ).length;

  // If user asked for drafts and there are none, explain (don't burn credits on surprise rows)
  if (!targets.length && !onlyId && status === "draft") {
    console.log("No draft laptops yet — catalog:sonar defaults to col_status=draft.\n");
    console.log("Catalog right now:");
    for (const [k, v] of Object.entries(byStatus)) {
      console.log(`  ${k}: ${v}`);
    }
    console.log(`  without Sonar enrich: ${withoutSonar}/${sheet.rows.length}`);
    console.log(`  missing retail ASIN/EAN: ${missingIdsCount}/${sheet.rows.length}`);
    console.log(`
Pick one:

  # A) Hunt real ASIN/EAN via Sonar (format-checked, still verify in app)
  npm run catalog:sonar:ids

  # B) Enrich specs for every row never Sonar'd (one long run)
  npm run catalog:sonar:unenriched

  # C) One specific laptop
  npm run catalog:sonar -- --id lap_lenovo_loq_5060
`);
    return;
  }

  const totalMatched = targets.length;
  if (maxN > 0) targets = targets.slice(0, maxN);

  if (!targets.length) {
    console.log(`No rows matched (id=${onlyId || "—"} status=${status})`);
    console.log("Statuses:", byStatus);
    return;
  }

  console.log(
    `\nsonar_enrich: ${targets.length} row(s)${maxN > 0 && totalMatched > targets.length ? ` of ${totalMatched} matched` : ""} via ${process.env.SONAR_MODEL || "sonar"}${idsOnly ? " [IDs focus]" : ""}`
  );
  console.log(
    `  est. wait ≥ ${Math.round((targets.length * delayMs) / 60000)} min at ${delayMs}ms spacing (+ API time)\n`
  );

  let ok = 0;
  let fail = 0;
  let idsFilled = 0;
  let consecutiveFails = 0;
  const failStop = Math.max(
    3,
    parseInt(process.env.SONAR_FAIL_STOP || "5", 10) || 5
  );

  for (let i = 0; i < targets.length; i++) {
    const row = targets[i];
    process.stdout.write(`  [${i + 1}/${targets.length}] ${row.id} … `);
    try {
      if (!reg.entries[row.id]) {
        reg.entries[row.id] = {
          model: row.cells.col_model || row.id,
          asin: { uk: "", de: "" },
          ean: "",
          mpn: "",
          search_query: String(row.cells.col_model || "")
            .replace(/\([^)]*\)/g, " ")
            .replace(/\s+/g, " ")
            .trim(),
        };
      }
      const res = await enrichRow(row, reg.entries[row.id], { idsOnly });
      if (res.ok) {
        ok++;
        consecutiveFails = 0;
        const idBits = (res.ids_filled || []).join(", ") || "no new ids";
        if (res.ids_filled?.length) idsFilled++;
        console.log(
          `ok conf=${res.confidence || "?"} price_locked=${!!res.verified} ids=[${idBits}]${res.ids_skipped ? ` (${res.ids_skipped})` : ""}`
        );
        reg.entries[row.id].sonar_enriched_at = new Date().toISOString();
      } else {
        fail++;
        consecutiveFails++;
        console.log(`fail: ${res.error}`);
      }
    } catch (e) {
      fail++;
      consecutiveFails++;
      console.log(`err: ${e.message}`);
      // Hard rate-limit exhaustion: stop rather than spinning forever
      if (/rate limit after/i.test(String(e.message || ""))) {
        console.warn(
          `\nStopped early: rate limit retries exhausted. Progress saved. Re-run the same command later to continue.`
        );
        break;
      }
    }

    // Persist after every row so Ctrl+C / crash doesn't lose work
    try {
      saveJson(dataPath, data);
      saveJson(regPath, reg);
    } catch (saveErr) {
      console.warn(`  (save warning: ${saveErr.message})`);
    }

    if (consecutiveFails >= failStop) {
      console.warn(
        `\nStopped early: ${failStop} consecutive failures. Progress saved. Fix errors / wait, then re-run.`
      );
      break;
    }
  }

  saveJson(dataPath, data);
  saveJson(regPath, reg);
  console.log(`\nDone. ok=${ok} fail=${fail} rows_with_new_ids=${idsFilled}`);
  if (maxN > 0 && totalMatched > ok + fail) {
    console.log(
      `  ${totalMatched - (ok + fail)} matched row(s) not attempted this run (cap or early stop). Re-run to continue.`
    );
  } else if (status === "noids" || status === "unenriched" || status === "missing") {
    const still = sheet.rows.filter(matches).length;
    // re-filter on updated data for honest remaining count
    const remaining = sheet.rows.filter((r) => {
      if (status === "unenriched" || status === "missing") {
        return !r.cells.col_detail?.sonar;
      }
      if (status === "noids" || status === "missing-ids" || status === "ids") {
        return rowMissingRetailIds(r, reg.entries?.[r.id] || {});
      }
      return false;
    }).length;
    if (remaining > 0) {
      console.log(`  Still left in queue: ${remaining} — re-run same command to finish.`);
    } else {
      console.log("  Queue empty for this filter. 🎉");
    }
  }
  console.log("IDs from Sonar are research-sourced — open Amazon link in the app to confirm.");
  console.log("Next: npm run catalog:sync  (buy links use ASINs when present)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
