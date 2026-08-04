/**
 * Free listing helpers: extract ASIN/EAN from retailer URLs (no paid API).
 */
const { inferBrand, inferGpuId, slugId, buildDraftRow } = require("./catalog_utils");

/** Amazon ASIN from /dp/ or /gp/product/ */
function extractAsin(url) {
  const s = String(url || "");
  const m =
    s.match(/\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})(?:[/?]|$)/i) ||
    s.match(/[?&]asin=([A-Z0-9]{10})(?:&|$)/i);
  return m ? m[1].toUpperCase() : "";
}

/** Marketplace from hostname */
function marketplaceFromUrl(url) {
  const h = String(url || "").toLowerCase();
  if (h.includes("amazon.de")) return "de";
  if (h.includes("amazon.co.uk") || h.includes("amazon.uk")) return "uk";
  if (h.includes("amazon.com")) return "us";
  if (h.includes("amazon.fr")) return "fr";
  if (h.includes("amazon.it")) return "it";
  if (h.includes("amazon.es")) return "es";
  return "uk";
}

/** Geizhals product id from path …-a1234567.html */
function extractGeizhalsId(url) {
  const m = String(url || "").match(/-a(\d+)\.html/i);
  return m ? m[1] : "";
}

/** Loose EAN/GTIN from query string or path */
function extractEanFromText(s) {
  const m = String(s || "").match(/\b(\d{8}|\d{12,14})\b/);
  return m ? m[1] : "";
}

/**
 * Parse a retailer URL into identifiers.
 */
function parseListingUrl(url) {
  const u = String(url || "").trim();
  const asin = extractAsin(u);
  const market = marketplaceFromUrl(u);
  const geizhals_id = extractGeizhalsId(u);
  const ean = extractEanFromText(u);
  return {
    url: u,
    asin,
    market,
    geizhals_id,
    ean,
    kind: asin
      ? "amazon"
      : geizhals_id
        ? "geizhals"
        : ean
          ? "ean"
          : "unknown",
  };
}

/**
 * Build inbox candidate from free inputs (URL + optional prices + title).
 */
function buildInboxItem({
  url,
  title,
  price_gbp,
  price_eur,
  ean,
  notes,
  id,
} = {}) {
  const listing = parseListingUrl(url || "");
  const model = (title || "").trim() || "Untitled laptop";
  const brand = inferBrand(model);
  const gpu = inferGpuId(model);
  const rowId =
    id ||
    slugId(
      "lap",
      brand === "unknown" ? "oem" : brand,
      gpu || "gpu",
      model
    );

  const gbp =
    price_gbp != null && price_gbp !== ""
      ? Math.round(Number(price_gbp))
      : null;
  const eur =
    price_eur != null && price_eur !== ""
      ? Math.round(Number(price_eur))
      : gbp != null
        ? Math.round(gbp * 1.15)
        : null;

  return {
    id: rowId,
    model,
    listing_url: listing.url || "",
    asin: listing.asin || "",
    market: listing.market || "uk",
    ean: ean || listing.ean || "",
    geizhals_id: listing.geizhals_id || "",
    price_gbp: gbp,
    price_eur: eur,
    notes: notes || "",
    // Price is "SKU-verified" when we have ASIN/EAN and a price the human set while looking at that listing
    price_verified: !!(
      (listing.asin || ean || listing.ean) &&
      (gbp != null || eur != null)
    ),
    source: "inbox",
    created_at: new Date().toISOString(),
  };
}

/**
 * Turn inbox item into catalog row + registry entry.
 */
function inboxToCatalog(item) {
  const title = item.model;
  const hit = {
    title,
    asin: item.asin || "",
    ean: item.ean || "",
    gtin: item.ean || "",
    price: item.price_gbp || item.price_eur || null,
    currency: item.price_gbp != null ? "GBP" : item.price_eur != null ? "EUR" : null,
    url: item.listing_url || "",
    image: item.image || null,
    query: title,
  };
  const draft = buildDraftRow(hit, { id: item.id, query: title });

  // Override prices with human-verified values
  if (item.price_eur != null) {
    draft.cells.col_price.EUR = item.price_eur;
    draft.cells.col_detail.price_eur = item.price_eur;
  }
  if (item.price_gbp != null) {
    draft.cells.col_price.GBP = item.price_gbp;
    draft.cells.col_detail.price_gbp = item.price_gbp;
  }
  draft.cells.col_status = "draft";
  draft.cells.col_notes =
    item.notes ||
    "Added via inbox. Price tied to listing ID — run catalog:sonar to flesh out specs, then promote status.";
  draft.cells.col_detail.price_note = item.price_verified
    ? `SKU-verified street price (human) vs listing ${item.asin || item.ean || item.listing_url}`
    : "Price not SKU-verified yet — set price while viewing the exact listing URL";
  draft.cells.col_detail.sku_map = {
    asin_uk: item.market !== "de" ? item.asin || "" : "",
    asin_de: item.market === "de" ? item.asin || "" : "",
    ean: item.ean || "",
    geizhals_id: item.geizhals_id || "",
    official_url: item.listing_url || "",
    search_query: title,
    price_verified: !!item.price_verified,
    price_source: item.price_verified ? "human_listing" : "unverified",
  };
  if (item.listing_url) {
    draft.cells.col_url = item.listing_url;
    draft.cells.col_detail.link = item.listing_url;
  }

  const regEntry = {
    model: title,
    asin: {
      uk: item.market !== "de" ? item.asin || "" : "",
      de: item.market === "de" ? item.asin || "" : "",
    },
    ean: item.ean || "",
    mpn: "",
    geizhals_id: item.geizhals_id || "",
    official_url: item.listing_url || "",
    search_query: title,
    listing_url: item.listing_url || "",
    price_verified: !!item.price_verified,
    auto_draft: true,
    inbox: true,
  };

  return { row: draft, reg: regEntry };
}

module.exports = {
  extractAsin,
  extractGeizhalsId,
  marketplaceFromUrl,
  parseListingUrl,
  buildInboxItem,
  inboxToCatalog,
};
