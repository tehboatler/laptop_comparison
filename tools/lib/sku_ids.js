/**
 * Retail listing ID validation (ASIN / EAN / MPN).
 * Shared by Sonar enrich + discover + hygiene.
 */

function normalizeAsin(s) {
  const v = String(s || "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(v)) return "";
  // Modern Amazon laptop ASINs are almost always B0…
  if (!/^B0[A-Z0-9]{8}$/.test(v)) return "";
  // Reject obvious placeholders / hallucinations
  if (/X{2,}|F{4,}|0{5,}|TEST|FAKE|XXXX|YYYY|ZZZZ|12345|ABCDE/i.test(v)) {
    return "";
  }
  // Too many repeated chars
  if (/(.)\1{4,}/.test(v)) return "";
  return v;
}

function asinFromUrl(url) {
  const m = String(url || "").match(
    /\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})(?:[/?]|$)/i
  );
  return m ? normalizeAsin(m[1]) : "";
}

function normalizeEan(s) {
  const digits = String(s || "").replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(digits.length)) return "";
  if (/^(\d)\1+$/.test(digits)) return "";
  if (/^0+$/.test(digits)) return "";
  return digits;
}

function normalizeMpn(s) {
  const v = String(s || "").trim();
  if (v.length < 4 || v.length > 48) return "";
  if (/^lap_/i.test(v)) return "";
  return v;
}

function hasRetailIds(obj = {}) {
  return !!(
    normalizeAsin(obj.asin_uk || obj.asin) ||
    normalizeAsin(obj.asin_de) ||
    normalizeEan(obj.ean || obj.gtin) ||
    normalizeMpn(obj.mpn) ||
    obj.geizhals_id
  );
}

/**
 * Pull the best ASIN/EAN/URLs out of a Sonar product object.
 */
function pickRetailIds(p = {}) {
  const urlUk = String(p.amazon_uk_url || p.amazon_url || p.url || "").trim();
  const urlDe = String(p.amazon_de_url || "").trim();
  const asinUk =
    normalizeAsin(p.asin_uk) ||
    normalizeAsin(p.asin) ||
    asinFromUrl(urlUk);
  const asinDe = normalizeAsin(p.asin_de) || asinFromUrl(urlDe);
  const ean = normalizeEan(p.ean || p.gtin);
  const mpn = normalizeMpn(p.mpn);
  return {
    asin_uk: asinUk,
    asin_de: asinDe,
    ean,
    mpn,
    amazon_uk_url:
      urlUk ||
      (asinUk ? `https://www.amazon.co.uk/dp/${asinUk}` : ""),
    amazon_de_url:
      urlDe ||
      (asinDe ? `https://www.amazon.de/dp/${asinDe}` : ""),
  };
}

/** Prefer curated (non lap_auto) over auto drafts when deduping */
function rowPriority(row) {
  const id = row.id || "";
  const st = row.cells?.col_status || "";
  let p = 0;
  if (!/^lap_auto_/.test(id)) p += 100;
  if (st === "top") p += 50;
  if (st === "consider") p += 40;
  if (st === "alt") p += 30;
  if (st === "pass") p += 5;
  if (st === "draft") p += 1;
  const sm = row.cells?.col_detail?.sku_map || {};
  if (sm.price_verified || sm.price_source === "human_listing") p += 20;
  if (sm.price_source === "sonar_verified") p += 10;
  if (row.cells?.col_image) p += 5;
  if (row.cells?.col_detail?.performance?.gaming?.games?.length) p += 8;
  if (row.cells?.col_detail?.sonar) p += 3;
  return p;
}

module.exports = {
  normalizeAsin,
  normalizeEan,
  normalizeMpn,
  asinFromUrl,
  hasRetailIds,
  pickRetailIds,
  rowPriority,
};
