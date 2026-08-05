#!/usr/bin/env node
/**
 * Automatic catalog hygiene — clean without burying discover work.
 *
 * Default philosophy (HYGIENE_STRICT=0):
 *   • Discover rows should stay VISIBLE (auto-promote to consider)
 *   • Only hide TRUE ASIN duplicates (same B0… → keep best row)
 *   • Never hide a draft just because ASIN is missing
 *   • Fill images (from ASIN) + FPS class templates
 *
 * Strict mode (HYGIENE_STRICT=1): old aggressive soft-dedupe + hide no-ID drafts
 *
 * Env:
 *   HYGIENE_PROMOTE=0     disable auto-promote
 *   HYGIENE_DELETE=1      hard-delete ASIN-dupe losers instead of status=pass
 *   HYGIENE_SOFT_DEDUPE=1 enable near-title soft dedupe (off by default)
 *   HYGIENE_STRICT=1      soft-dedupe + hide no-ID auto drafts
 *   HYGIENE_DRY=1         report only
 */
const path = require("path");
const {
  root,
  loadDotEnv,
  loadJson,
  saveJson,
  laptopSheet,
  inferBrand,
  inferGpuId,
} = require("./lib/catalog_utils");
const {
  normalizeAsin,
  normalizeEan,
  rowPriority,
} = require("./lib/sku_ids");
const { ensurePerfTemplate, ensureImageFromAsin } = require("./lib/perf_templates");

loadDotEnv();

const dataPath = path.join(root, "data.json");
const regPath = path.join(root, "tools", "sku_registry.json");

function normTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(laptop|gaming|notebook|with|and|the|gen|inch|uk)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scrubAsins(row, reg) {
  let n = 0;
  const det = row.cells.col_detail || {};
  const sm = det.sku_map || {};
  const e = reg.entries?.[row.id];

  const scrubField = (obj, key) => {
    if (!obj || !obj[key]) return;
    const bad = obj[key];
    const good = normalizeAsin(bad);
    if (!good) {
      obj[key] = "";
      n++;
    } else if (good !== String(bad).toUpperCase()) {
      obj[key] = good;
      n++;
    }
  };

  scrubField(sm, "asin_uk");
  scrubField(sm, "asin_de");
  if (e?.asin) {
    scrubField(e.asin, "uk");
    scrubField(e.asin, "de");
  }
  if (sm.ean) {
    const ean = normalizeEan(sm.ean);
    if (!ean) {
      sm.ean = "";
      n++;
    } else sm.ean = ean;
  }
  if (e?.ean) {
    const ean = normalizeEan(e.ean);
    if (!ean) {
      e.ean = "";
      n++;
    } else e.ean = ean;
  }

  det.sku_map = sm;
  row.cells.col_detail = det;
  return n;
}

function collectAsins(row, reg) {
  const sm = row.cells?.col_detail?.sku_map || {};
  const e = reg.entries?.[row.id];
  const set = new Set();
  for (const a of [
    normalizeAsin(sm.asin_uk),
    normalizeAsin(sm.asin_de),
    normalizeAsin(e?.asin?.uk),
    normalizeAsin(e?.asin?.de),
  ]) {
    if (a) set.add(a);
  }
  return [...set];
}

function dedupeByAsin(sheet, reg) {
  const byAsin = new Map();
  for (const row of sheet.rows) {
    for (const a of collectAsins(row, reg)) {
      if (!byAsin.has(a)) byAsin.set(a, []);
      byAsin.get(a).push(row);
    }
  }

  const remove = new Set();
  let merged = 0;
  for (const [asin, rows] of byAsin) {
    if (rows.length < 2) continue;
    const uniq = [...new Map(rows.map((r) => [r.id, r])).values()];
    if (uniq.length < 2) continue;
    uniq.sort((a, b) => rowPriority(b) - rowPriority(a));
    const keep = uniq[0];
    for (let i = 1; i < uniq.length; i++) {
      const loser = uniq[i];
      const kc = keep.cells;
      const lc = loser.cells;
      if (!kc.col_image && lc.col_image) kc.col_image = lc.col_image;
      if (!kc.col_detail?.images?.length && lc.col_detail?.images?.length) {
        kc.col_detail = kc.col_detail || {};
        kc.col_detail.images = lc.col_detail.images;
      }
      if (
        !kc.col_detail?.performance?.gaming?.games?.length &&
        lc.col_detail?.performance?.gaming?.games?.length
      ) {
        kc.col_detail = kc.col_detail || {};
        kc.col_detail.performance = lc.col_detail.performance;
      }
      // Prefer better notes
      if (
        String(lc.col_notes || "").length > String(kc.col_notes || "").length + 40
      ) {
        /* keep winner notes; optional merge skipped to avoid mess */
      }
      remove.add(loser.id);
      merged++;
      if (reg.entries?.[loser.id]) {
        reg.entries[loser.id]._merged_into = keep.id;
        reg.entries[loser.id]._merge_asin = asin;
      }
    }
  }
  return { remove, merged };
}

/** Only exact same normalized title + same gpu among auto drafts (optional). */
function softDedupeDrafts(sheet) {
  const remove = new Set();
  const drafts = sheet.rows.filter(
    (r) => r.cells?.col_status === "draft" || /^lap_auto_/.test(r.id)
  );
  const buckets = new Map();
  for (const r of drafts) {
    const brand = inferBrand(r.cells?.col_model || r.id);
    const gpu = inferGpuId(r.cells?.col_gpu || r.cells?.col_model || "");
    const t = normTitle(r.cells?.col_model);
    // full title key — not a short prefix (that was killing Yoga variants)
    const key = [brand, gpu, t].join("|");
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  let n = 0;
  for (const rows of buckets.values()) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => rowPriority(b) - rowPriority(a));
    for (let i = 1; i < rows.length; i++) {
      remove.add(rows[i].id);
      n++;
    }
  }
  return { remove, n };
}

/**
 * Undo previous over-aggressive hygiene that buried discover work.
 */
function restoreOverHidden(sheet, reg) {
  let n = 0;
  for (const row of sheet.rows) {
    if (row.cells?.col_status !== "pass") continue;
    if (!/^lap_auto_/.test(row.id)) continue;
    const notes = String(row.cells.col_notes || "");
    const wasHygiene =
      /\[auto-hygiene:\s*no retail ID/i.test(notes) ||
      /\[auto-hygiene:\s*duplicate/i.test(notes) ||
      reg.entries?.[row.id]?.hygiene === "deduped_pass";
    if (!wasHygiene) continue;

    row.cells.col_notes = notes
      .replace(/\s*\[auto-hygiene:[^\]]+\]/gi, "")
      .trim();
    // Back to draft first; promote step will lift ready ones
    row.cells.col_status = "draft";
    if (reg.entries?.[row.id]) {
      delete reg.entries[row.id].hygiene;
      reg.entries[row.id].restored_from_hygiene = true;
    }
    n++;
  }
  return n;
}

/**
 * Liberal promote: discover work should enter the finder.
 * Require: draft + price + model. ASIN preferred but NOT required.
 */
function isPromoteReady(row) {
  const c = row.cells || {};
  if (c.col_status !== "draft") return false;
  if (!c.col_model) return false;
  if (c.col_price?.GBP == null && c.col_price?.EUR == null) return false;
  // Auto rows from discover always promote if priced
  if (/^lap_auto_/.test(row.id)) return true;
  // Hand drafts: need a bit of substance
  const notes = String(c.col_notes || "");
  return notes.length >= 20 || !!c.col_detail?.sonar;
}

function applyRemovals(sheet, reg, removeIds, { hardDelete }) {
  if (!removeIds.size) return 0;
  const before = sheet.rows.length;
  if (hardDelete) {
    sheet.rows = sheet.rows.filter((r) => !removeIds.has(r.id));
    for (const id of removeIds) {
      if (reg.entries?.[id]) {
        reg.entries[id]._orphan = true;
        reg.entries[id]._hygiene_removed = true;
      }
    }
    return before - sheet.rows.length;
  }
  let n = 0;
  for (const r of sheet.rows) {
    if (!removeIds.has(r.id)) continue;
    // Never demote curated non-auto rows
    if (!/^lap_auto_/.test(r.id) && r.cells?.col_status !== "draft") continue;
    r.cells = r.cells || {};
    r.cells.col_status = "pass";
    r.cells.col_notes = [
      String(r.cells.col_notes || "").replace(/\s*\[auto-hygiene:[^\]]+\]/gi, ""),
      "[auto-hygiene: ASIN duplicate — kept better row]",
    ]
      .filter(Boolean)
      .join(" ");
    if (reg.entries?.[r.id]) reg.entries[r.id].hygiene = "asin_dupe_pass";
    n++;
  }
  return n;
}

function main() {
  const dry = process.env.HYGIENE_DRY === "1";
  const hardDelete = process.env.HYGIENE_DELETE === "1";
  const promote = process.env.HYGIENE_PROMOTE !== "0";
  const strict = process.env.HYGIENE_STRICT === "1";
  const softDedupe =
    strict || process.env.HYGIENE_SOFT_DEDUPE === "1";

  const data = loadJson(dataPath);
  const reg = fsExistsReg();
  const sheet = laptopSheet(data);
  if (!sheet) {
    console.log("No laptop sheet");
    return { ok: false };
  }

  const stats = {
    restored: 0,
    scrubbed_asin_fields: 0,
    dedupe_asin_merged: 0,
    soft_dedupe: 0,
    images: 0,
    perf_templates: 0,
    promoted: 0,
    removed: 0,
    before: sheet.rows.length,
  };

  // 0) Undo previous over-bury of discover work
  stats.restored = restoreOverHidden(sheet, reg);

  // 1) Scrub bad ASINs
  for (const row of sheet.rows) {
    stats.scrubbed_asin_fields += scrubAsins(row, reg);
  }

  // 2) True ASIN collisions only
  const { remove: remAsin, merged } = dedupeByAsin(sheet, reg);
  stats.dedupe_asin_merged = merged;

  // 3) Soft dedupe OFF by default (was burying Yoga / LOQ variants)
  let remSoft = new Set();
  if (softDedupe) {
    const soft = softDedupeDrafts(sheet);
    remSoft = soft.remove;
    stats.soft_dedupe = soft.n;
  }

  const allRemove = new Set([...remAsin, ...remSoft]);
  for (const id of [...allRemove]) {
    const row = sheet.rows.find((r) => r.id === id);
    if (row && !/^lap_auto_/.test(id) && row.cells?.col_status !== "draft") {
      allRemove.delete(id);
    }
  }

  if (!dry) {
    stats.removed = applyRemovals(sheet, reg, allRemove, { hardDelete });
  } else {
    stats.removed = allRemove.size;
  }

  // 4–5) Images + FPS templates for anything finder might show
  for (const row of sheet.rows) {
    if (row.cells?.col_status === "pass" && allRemove.has(row.id)) continue;
    if (ensureImageFromAsin(row)) stats.images++;
    if (ensurePerfTemplate(row)) stats.perf_templates++;
  }

  // 6) Liberal auto-promote → consider (discover work becomes visible)
  if (promote) {
    for (const row of sheet.rows) {
      if (allRemove.has(row.id)) continue;
      if (!isPromoteReady(row)) continue;
      if (dry) {
        stats.promoted++;
        continue;
      }
      row.cells.col_status = "consider";
      const det = row.cells.col_detail || {};
      det.auto_promoted_at = new Date().toISOString();
      det.auto_promoted = true;
      const sm = det.sku_map || {};
      const hasId =
        normalizeAsin(sm.asin_uk) ||
        normalizeAsin(sm.asin_de) ||
        normalizeEan(sm.ean);
      if (!hasId) sm.needs_retail_id = true;
      det.sku_map = sm;
      row.cells.col_detail = det;
      if (reg.entries?.[row.id]) {
        reg.entries[row.id].auto_promoted = true;
      }
      stats.promoted++;
    }
  }

  // NOTE: We do NOT auto-pass drafts for missing ASIN anymore.
  // Missing ASIN = still a valid discovered product; show it, flag needs_retail_id.

  stats.after = sheet.rows.length;
  stats.finder_visible = sheet.rows.filter((r) =>
    ["top", "consider", "alt"].includes(r.cells?.col_status)
  ).length;
  stats.drafts = sheet.rows.filter(
    (r) => r.cells?.col_status === "draft"
  ).length;
  stats.pass = sheet.rows.filter((r) => r.cells?.col_status === "pass").length;

  if (!dry) {
    saveJson(dataPath, data);
    saveJson(regPath, reg);
  }

  console.log(
    "catalog_hygiene" +
      (dry ? " [DRY]" : "") +
      (strict ? " [STRICT]" : " [keep-discover]") +
      ":"
  );
  for (const [k, v] of Object.entries(stats)) {
    console.log(`  ${k}: ${v}`);
  }
  return stats;
}

function fsExistsReg() {
  const fs = require("fs");
  if (!fs.existsSync(regPath)) return { entries: {} };
  return loadJson(regPath);
}

if (require.main === module) {
  main();
}

module.exports = { main };
