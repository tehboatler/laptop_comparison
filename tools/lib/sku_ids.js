/**
 * Retail listing ID validation (ASIN / EAN / MPN).
 * Shared by Sonar enrich + discover.
 */

function normalizeAsin(s) {
  const v = String(s || "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(v)) return "";
  // Modern Amazon laptop ASINs are almost always B0…
  if (!/^B0[A-Z0-9]{8}$/.test(v)) return "";
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

module.exports = {
  normalizeAsin,
  normalizeEan,
  normalizeMpn,
  asinFromUrl,
  hasRetailIds,
  pickRetailIds,
};
