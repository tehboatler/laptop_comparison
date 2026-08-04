/**
 * Shared helpers for catalog automation (resolve IDs, discover SKUs, draft rows).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.join(__dirname, "..", "..");

function loadDotEnv(envPath = path.join(root, ".env")) {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\n/)) {
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
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

function laptopSheet(data) {
  return data.sheets.find((s) =>
    String(s.name || "").toLowerCase().includes("laptop")
  );
}

const STOP = new Set([
  "the",
  "and",
  "with",
  "for",
  "laptop",
  "notebook",
  "gaming",
  "geforce",
  "nvidia",
  "amd",
  "intel",
  "windows",
  "home",
  "pro",
  "inch",
  "gb",
  "tb",
  "ssd",
  "ram",
  "ddr4",
  "ddr5",
  "class",
  "series",
  "last",
  "gen",
  "new",
  "uk",
  "de",
  "eu",
]);

function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Pull GPU short code from free text: rtx5060, rtx4050, rx7700s, … */
function inferGpuId(text) {
  const s = String(text || "").toLowerCase();
  const m =
    s.match(/\brtx\s*([456]0[5-9]0)\b/) ||
    s.match(/\brtx\s*(30[5-9]0)\b/) ||
    s.match(/\brx\s*(7[67]00\s*s?)\b/) ||
    s.match(/\b(arc\s*a\d+)\b/);
  if (!m) {
    if (/\bm4\s*pro\b|\bm4\s*max\b|\bapple\s*m4\b|\bm4\b/.test(s)) return "apple_m4";
    if (/\bm3\b/.test(s)) return "apple_m3";
    return "";
  }
  let g = m[1].replace(/\s+/g, "");
  if (/^7/.test(g) || /^a/.test(g)) {
    if (/arc/.test(m[0])) return "arc_" + g.replace(/\s/g, "");
    return "rx" + g.replace(/s$/, "s");
  }
  return "rtx" + g;
}

function inferBrand(text) {
  const s = String(text || "").toLowerCase();
  const brands = [
    "lenovo",
    "asus",
    "msi",
    "acer",
    "hp",
    "dell",
    "razer",
    "apple",
    "gigabyte",
    "framework",
    "samsung",
    "lg",
    "microsoft",
  ];
  for (const b of brands) {
    if (s.includes(b)) return b;
  }
  if (/\brog\b|\btuf\b|\bvivobook\b|\bzephyrus\b/.test(s)) return "asus";
  if (/\bloq\b|\blegion\b|\bideapad\b|\byoga\b/.test(s)) return "lenovo";
  if (/\bnitro\b|\bpredator\b|\bhelios\b/.test(s)) return "acer";
  if (/\bvictus\b|\bomen\b|\bomnibook\b/.test(s)) return "hp";
  if (/\bkatana\b|\bthin\b|\bcyborg\b|\bstealth\b|\bsword\b/.test(s)) return "msi";
  return "unknown";
}

/**
 * Score how well a product title matches our catalog model / search query.
 * Returns 0–1+ (boosts can push slightly above 1 before clamp).
 */
function scoreTitleMatch(query, title, { requireGpu = true } = {}) {
  const q = String(query || "");
  const t = String(title || "");
  if (!q || !t) return 0;

  const qTokens = tokenize(q);
  const tTokens = tokenize(t);
  if (!qTokens.length || !tTokens.length) return 0;

  let hits = 0;
  for (const tok of qTokens) {
    if (tTokens.includes(tok) || tTokens.some((x) => x.includes(tok) || tok.includes(x))) {
      hits++;
    }
  }
  let score = hits / qTokens.length;

  const qGpu = inferGpuId(q);
  const tGpu = inferGpuId(t);
  if (qGpu && tGpu) {
    if (qGpu === tGpu) score += 0.35;
    else score -= 0.5; // wrong GPU is a hard fail signal
  } else if (requireGpu && qGpu && !tGpu) {
    score -= 0.15;
  }

  const qBrand = inferBrand(q);
  const tBrand = inferBrand(t);
  if (qBrand !== "unknown" && tBrand !== "unknown") {
    if (qBrand === tBrand) score += 0.12;
    else score -= 0.35;
  }

  // Prefer actual laptops over accessories
  if (/\b(bag|sleeve|charger|dock|stand|cooler|skin|case only)\b/i.test(t)) {
    score -= 0.6;
  }
  if (/\b(laptop|notebook|gaming)\b/i.test(t)) score += 0.05;

  return Math.max(0, Math.min(1.2, score));
}

function pickBestHit(query, hits, { minScore = 0.55 } = {}) {
  const ranked = (hits || [])
    .map((h) => ({
      ...h,
      match_score: scoreTitleMatch(query, h.title),
    }))
    .sort((a, b) => b.match_score - a.match_score);

  const best = ranked[0] || null;
  if (!best || best.match_score < minScore) {
    return { best: null, ranked: ranked.slice(0, 8), accepted: false };
  }
  return { best, ranked: ranked.slice(0, 8), accepted: true };
}

function slugId(prefix, brand, gpu, title) {
  const base = [brand, gpu, String(title || "").slice(0, 40)]
    .filter(Boolean)
    .join("_")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48);
  const hash = crypto
    .createHash("sha1")
    .update(String(title || "") + String(gpu || ""))
    .digest("hex")
    .slice(0, 6);
  return `${prefix}_${base}_${hash}`.replace(/_+/g, "_");
}

/** Heuristic scores / TGP defaults by GPU id — drafts only, human must refine */
const GPU_PROFILES = {
  rtx3050: {
    label: "NVIDIA GeForce RTX 3050 Laptop GPU",
    vram: 6,
    gen: "30-series",
    gaming: 6.2,
    gpu: 6.0,
    cpu: 6.5,
    tgp: "≈60–95 W",
    eur: 699,
    gbp: 599,
  },
  rtx4050: {
    label: "NVIDIA GeForce RTX 4050 Laptop GPU",
    vram: 6,
    gen: "40-series",
    gaming: 7.2,
    gpu: 7.0,
    cpu: 7.0,
    tgp: "≈45–115 W (chassis-dependent)",
    eur: 899,
    gbp: 799,
  },
  rtx4060: {
    label: "NVIDIA GeForce RTX 4060 Laptop GPU",
    vram: 8,
    gen: "40-series",
    gaming: 8.0,
    gpu: 7.8,
    cpu: 7.4,
    tgp: "≈75–140 W (chassis-dependent)",
    eur: 1099,
    gbp: 999,
  },
  rtx4070: {
    label: "NVIDIA GeForce RTX 4070 Laptop GPU",
    vram: 8,
    gen: "40-series",
    gaming: 8.6,
    gpu: 8.5,
    cpu: 7.8,
    tgp: "≈80–140 W",
    eur: 1499,
    gbp: 1349,
  },
  rtx5050: {
    label: "NVIDIA GeForce RTX 5050 Laptop GPU",
    vram: 8,
    gen: "50-series",
    gaming: 7.8,
    gpu: 7.6,
    cpu: 7.6,
    tgp: "≈75–115 W class",
    eur: 1199,
    gbp: 1099,
  },
  rtx5060: {
    label: "NVIDIA GeForce RTX 5060 Laptop GPU",
    vram: 8,
    gen: "50-series",
    gaming: 8.8,
    gpu: 8.6,
    cpu: 8.0,
    tgp: "≈95–140 W (gaming chassis)",
    eur: 1399,
    gbp: 1249,
  },
  rtx5070: {
    label: "NVIDIA GeForce RTX 5070 Laptop GPU",
    vram: 8,
    gen: "50-series",
    gaming: 9.2,
    gpu: 9.0,
    cpu: 8.2,
    tgp: "≈100–140 W",
    eur: 1799,
    gbp: 1649,
  },
  apple_m4: {
    label: "Apple M4 (integrated)",
    vram: 0,
    gen: "apple-silicon",
    gaming: 5.5,
    gpu: 6.5,
    cpu: 9.0,
    tgp: "SoC integrated",
    eur: 1699,
    gbp: 1599,
  },
};

function gpuProfile(gpuId) {
  return (
    GPU_PROFILES[gpuId] || {
      label: gpuId ? String(gpuId).toUpperCase() : "Unknown GPU",
      vram: 0,
      gen: "unknown",
      gaming: 6.5,
      gpu: 6.5,
      cpu: 6.5,
      tgp: "unknown — verify",
      eur: 999,
      gbp: 899,
    }
  );
}

/**
 * Build a draft catalog row from a discovered product hit.
 * Scores/TGP/battery are HEURISTIC — marked as auto-draft.
 */
function buildDraftRow(hit, { id, query } = {}) {
  const title = hit.title || "Unknown laptop";
  const brand = inferBrand(title);
  const gpuId = inferGpuId(title) || inferGpuId(query || "");
  const prof = gpuProfile(gpuId);
  const rowId =
    id ||
    slugId("lap_auto", brand === "unknown" ? "oem" : brand, gpuId || "gpu", title);

  const price = hit.price ? Math.round(Number(hit.price)) : null;
  const eur = price && hit.currency === "EUR" ? price : prof.eur;
  const gbp =
    price && (hit.currency === "GBP" || !hit.currency)
      ? price
      : Math.round(eur * 0.88);

  const shortModel = title
    .replace(/\s*[\|–—].*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 72);

  return {
    id: rowId,
    createdAt: Date.now(),
    cells: {
      col_model: shortModel,
      col_brand: brand === "unknown" ? "other" : brand,
      col_price: { EUR: eur, GBP: gbp, AUD: Math.round(eur * 1.65) },
      col_gpu: gpuId || "unknown",
      col_cpu: "SKU-dependent (auto-draft)",
      col_display: "SKU-dependent",
      col_ram: "16GB class (verify)",
      col_battery: 60,
      col_weight: 2.2,
      col_s_gaming: prof.gaming,
      col_s_gpu: prof.gpu,
      col_s_cpu: prof.cpu,
      col_s_battery: 5,
      col_s_thermals: 6,
      col_s_display: 6.5,
      col_s_ram: 7,
      col_s_io: 7,
      col_s_port: 6,
      col_s_build: 6.5,
      col_s_aesthetic: 6,
      col_status: "draft",
      col_notes:
        "AUTO-DRAFT from Price API search. Verify TGP, dual-channel RAM, battery Wh, display, and scores before treating as a recommendation.",
      col_url: hit.url || "",
      col_image: hit.image || "",
      col_config: `Auto · ${prof.label} · TGP ${prof.tgp} · verify RAM/SSD`,
      col_price_note: "Price from discovery search — re-sync with GTIN for street floor.",
      col_price_eur_min: Math.round(eur * 0.88),
      col_price_eur_max: Math.round(eur * 1.18),
      col_price_gbp_min: Math.round(gbp * 0.88),
      col_price_gbp_max: Math.round(gbp * 1.18),
      col_price_aud_min: Math.round(eur * 1.45),
      col_price_aud_max: Math.round(eur * 1.95),
      col_detail: {
        series: shortModel,
        model_name: shortModel,
        brand: brand === "unknown" ? "other" : brand,
        os: brand === "apple" ? "macOS" : "Windows 11 Home",
        price_eur: eur,
        price_gbp: gbp,
        price_aud: Math.round(eur * 1.65),
        price_note: "AUTO-DRAFT price",
        priced_config: `Auto · ${prof.label} · verify exact SKU`,
        auto_draft: true,
        auto_draft_source: hit.query || query || "",
        auto_draft_title: title,
        availability: {
          status: "retail",
          generation: prof.gen,
          model_year: new Date().getFullYear(),
          note: "Auto-discovered — confirm stock via buy links",
          checked: new Date().toISOString().slice(0, 10),
        },
        price_range: {
          EUR: { min: Math.round(eur * 0.88), max: Math.round(eur * 1.18) },
          GBP: { min: Math.round(gbp * 0.88), max: Math.round(gbp * 1.18) },
        },
        display: {
          size_in: 15.6,
          resolution: "FHD class (verify)",
          refresh_hz: 144,
          panel: "LCD (verify)",
          aspect: "16:9",
        },
        processor: {
          model: "SKU-dependent (auto-draft)",
          family: "verify",
        },
        graphics: {
          model: prof.label,
          vram_gb: prof.vram || undefined,
          tgp_this_chassis_w: prof.tgp,
        },
        memory: {
          installed: "16GB class (verify dual-channel)",
          type: "DDR5 typical",
          slots: 2,
        },
        storage: {
          primary: "512GB–1TB NVMe (verify)",
          expandable: "Often yes",
        },
        battery: {
          capacity_wh: 60,
          estimated_web_h: "verify",
        },
        chassis: {
          weight_kg: 2.2,
          material: "verify",
          grade: "hybrid",
          grade_label: "Unverified (auto-draft)",
        },
        performance: {
          note: "Scores are GPU-class heuristics only — not review-backed for this SKU.",
        },
        notes:
          "AUTO-DRAFT. Do not trust FPS bounds / TGP / battery until manually verified.",
        link: hit.url || "",
        images: hit.image ? [hit.image] : [],
        buy_links: [],
        buy_guide: "Use compare links after sync refresh_buy_links.",
        sku_map: {
          asin_uk: hit.asin || "",
          ean: hit.ean || hit.gtin || "",
          mpn: hit.mpn || "",
          search_query: query || hit.query || shortModel,
        },
      },
    },
  };
}

function existingSignatures(data, reg) {
  const sheet = laptopSheet(data);
  const eans = new Set();
  const asins = new Set();
  const titles = new Set();
  for (const row of sheet.rows || []) {
    titles.add(String(row.cells?.col_model || "").toLowerCase());
    const e = reg.entries?.[row.id];
    if (e?.ean) eans.add(String(e.ean).replace(/\D/g, ""));
    if (e?.asin?.uk) asins.add(e.asin.uk.toUpperCase());
    if (e?.asin?.de) asins.add(e.asin.de.toUpperCase());
    const sm = row.cells?.col_detail?.sku_map;
    if (sm?.ean) eans.add(String(sm.ean).replace(/\D/g, ""));
    if (sm?.asin_uk) asins.add(String(sm.asin_uk).toUpperCase());
  }
  for (const e of Object.values(reg.entries || {})) {
    if (e.ean) eans.add(String(e.ean).replace(/\D/g, ""));
    if (e.asin?.uk) asins.add(e.asin.uk.toUpperCase());
    if (e.asin?.de) asins.add(e.asin.de.toUpperCase());
  }
  return { eans, asins, titles };
}

function isDuplicateHit(hit, sigs) {
  if (hit.ean && sigs.eans.has(String(hit.ean).replace(/\D/g, ""))) return "ean";
  if (hit.gtin && sigs.eans.has(String(hit.gtin).replace(/\D/g, ""))) return "gtin";
  if (hit.asin && sigs.asins.has(String(hit.asin).toUpperCase())) return "asin";
  const t = String(hit.title || "").toLowerCase().slice(0, 40);
  for (const existing of sigs.titles) {
    if (t && existing.includes(t.slice(0, 24))) return "title";
    if (t && t.includes(existing.slice(0, 24)) && existing.length > 12) return "title";
  }
  return null;
}

module.exports = {
  root,
  loadDotEnv,
  loadJson,
  saveJson,
  laptopSheet,
  tokenize,
  inferGpuId,
  inferBrand,
  scoreTitleMatch,
  pickBestHit,
  slugId,
  gpuProfile,
  buildDraftRow,
  existingSignatures,
  isDuplicateHit,
  GPU_PROFILES,
};
