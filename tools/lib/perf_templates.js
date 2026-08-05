/**
 * GPU-class performance templates for auto-drafts.
 * Honest: class estimates, not unit lab tests.
 */
const { inferGpuId, gpuProfile } = require("./catalog_utils");

const FPS_BY_GPU = {
  rtx3050: [
    { name: "Fortnite", settings: "1080p Competitive / Performance", fps: 100, note: "class est." },
    { name: "Valorant", settings: "1080p high", fps: 160, note: "class est." },
    { name: "Cyberpunk 2077", settings: "1080p Low–Med, DLSS", fps: 40, note: "thin/low-TGP varies" },
    { name: "Elden Ring", settings: "1080p Medium", fps: 45, note: "class est." },
  ],
  rtx4050: [
    { name: "Fortnite", settings: "1080p Epic / Performance", fps: 140, note: "class est." },
    { name: "Valorant", settings: "1080p high", fps: 200, note: "class est." },
    { name: "Cyberpunk 2077", settings: "1080p Med, DLSS Quality", fps: 55, note: "TGP-dependent" },
    { name: "Alan Wake 2", settings: "1080p Low, DLSS", fps: 40, note: "demanding; TGP matters" },
    { name: "Elden Ring", settings: "1080p High", fps: 55, note: "class est." },
  ],
  rtx4060: [
    { name: "Fortnite", settings: "1080p Epic / Perf", fps: 160, note: "class est." },
    { name: "Valorant", settings: "1080p high", fps: 240, note: "class est." },
    { name: "Cyberpunk 2077", settings: "1080p High, DLSS", fps: 70, note: "TGP-dependent" },
    { name: "Alan Wake 2", settings: "1080p Med, DLSS", fps: 50, note: "class est." },
    { name: "Black Myth: Wukong", settings: "1080p Med, DLSS", fps: 55, note: "class est." },
  ],
  rtx4070: [
    { name: "Fortnite", settings: "1440p high", fps: 140, note: "class est." },
    { name: "Cyberpunk 2077", settings: "1440p High, DLSS", fps: 75, note: "class est." },
    { name: "Alan Wake 2", settings: "1440p Med–High, DLSS", fps: 55, note: "class est." },
  ],
  rtx5050: [
    { name: "Fortnite", settings: "1080p high", fps: 150, note: "early class est." },
    { name: "Valorant", settings: "1080p high", fps: 220, note: "early class est." },
    { name: "Cyberpunk 2077", settings: "1080p Med–High, DLSS", fps: 60, note: "chassis TGP varies" },
    { name: "Elden Ring", settings: "1080p High", fps: 60, note: "early class est." },
  ],
  rtx5060: [
    { name: "Fortnite", settings: "1080p / 1440p high", fps: 160, note: "early class est." },
    { name: "Valorant", settings: "1080p high", fps: 240, note: "early class est." },
    { name: "Cyberpunk 2077", settings: "1080p High, DLSS", fps: 75, note: "TGP-dependent" },
    { name: "Alan Wake 2", settings: "1080p Med–High, DLSS", fps: 55, note: "early class est." },
    { name: "Black Myth: Wukong", settings: "1080p High, DLSS", fps: 60, note: "early class est." },
  ],
  rtx5070: [
    { name: "Cyberpunk 2077", settings: "1440p High, DLSS", fps: 85, note: "early class est." },
    { name: "Alan Wake 2", settings: "1440p High, DLSS", fps: 60, note: "early class est." },
  ],
  apple_m4: [
    { name: "Resident Evil Village", settings: "native / medium", fps: 50, note: "macOS class est." },
    { name: "Death Stranding", settings: "native", fps: 45, note: "macOS class est." },
  ],
};

function resolveGpuId(row) {
  const c = row.cells || {};
  return (
    inferGpuId(c.col_gpu) ||
    inferGpuId(c.col_model) ||
    inferGpuId(c.col_detail?.graphics?.model) ||
    inferGpuId(c.col_config) ||
    ""
  );
}

/**
 * Ensure performance.gaming + TGP notes exist (heuristic class data).
 * Does not overwrite existing non-empty game lists.
 */
function ensurePerfTemplate(row) {
  const c = row.cells || {};
  const det = c.col_detail || {};
  const gpuId = resolveGpuId(row);
  const prof = gpuProfile(gpuId);
  let changed = false;

  det.graphics = det.graphics || {};
  if (!det.graphics.model || /unknown|sku-dependent/i.test(det.graphics.model)) {
    det.graphics.model = prof.label;
    changed = true;
  }
  if (!det.graphics.tgp_this_chassis_w || /unknown|verify/i.test(det.graphics.tgp_this_chassis_w)) {
    det.graphics.tgp_this_chassis_w = prof.tgp;
    changed = true;
  }
  if (prof.vram && !det.graphics.vram_gb) {
    det.graphics.vram_gb = prof.vram;
    changed = true;
  }

  det.performance = det.performance || {};
  det.performance.gaming = det.performance.gaming || {};
  const g = det.performance.gaming;
  if (!Array.isArray(g.games) || !g.games.length) {
    const games = FPS_BY_GPU[gpuId] || FPS_BY_GPU.rtx4050;
    g.games = games.map((x) => ({ ...x }));
    g.preset = g.preset || "1080p class (GPU-family estimate)";
    g.bound = g.bound || `Typical ${prof.label} laptop TGP band — not a lab test of this unit`;
    g.assumes =
      g.assumes ||
      c.col_config ||
      det.priced_config ||
      `${c.col_cpu || "CPU"} · ${prof.label} · dual-channel assumed unless noted`;
    g.note =
      g.note ||
      "AUTO class FPS from GPU family. Chassis TGP and dual-channel RAM can move numbers ±20–40%. Prefer review videos for this exact SKU.";
    det.performance.auto_fps_template = true;
    det.performance.gpu_class = gpuId || "unknown";
    changed = true;
  }

  // Thermal stubs if empty
  det.performance.thermals = det.performance.thermals || {};
  const th = det.performance.thermals;
  if (!th.load_scenario) {
    th.load_scenario = "30–60 min modern AAA, performance mode, ~25°C room (class)";
    th.gpu_temp_c = th.gpu_temp_c || "75–87";
    th.cpu_temp_c = th.cpu_temp_c || "80–95";
    th.load_dba = th.load_dba || "45–52";
    th.fan_behavior = th.fan_behavior || "Ramps under load; chassis-dependent";
    th.throttle_risk = th.throttle_risk || "Moderate on thin chassis; lower on LOQ/TUF/Legion class";
    changed = true;
  }

  if (changed) {
    c.col_detail = det;
    row.cells = c;
  }
  return changed;
}

/** Amazon image URL candidates (no API). First often works as hotlink. */
function amazonImageUrls(asin) {
  const a = String(asin || "").toUpperCase();
  if (!a) return [];
  return [
    // Associates-style image endpoint (often works without auth for display)
    `https://ws-eu.amazon-adsystem.com/widgets/q?_encoding=UTF8&MarketPlace=GB&ASIN=${a}&ServiceVersion=20070822&ID=AsinImage&WS=1&Format=_SL500_`,
    `https://images-eu.ssl-images-amazon.com/images/P/${a}.01.LZZZZZZZ.jpg`,
  ];
}

function ensureImageFromAsin(row) {
  const c = row.cells || {};
  if (c.col_image) return false;
  const sm = c.col_detail?.sku_map || {};
  const asin = sm.asin_uk || sm.asin_de || "";
  if (!asin) return false;
  const urls = amazonImageUrls(asin);
  if (!urls.length) return false;
  c.col_image = urls[0];
  const det = c.col_detail || {};
  det.images = det.images?.length ? det.images : [urls[0]];
  det.image_credit =
    det.image_credit ||
    "Amazon product image (ASIN widget). Confirm against live listing.";
  det.auto_image_from_asin = asin;
  c.col_detail = det;
  row.cells = c;
  return true;
}

module.exports = {
  FPS_BY_GPU,
  ensurePerfTemplate,
  ensureImageFromAsin,
  amazonImageUrls,
  resolveGpuId,
};
