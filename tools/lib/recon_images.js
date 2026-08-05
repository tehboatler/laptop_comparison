/**
 * Product image resolution for deep recon.
 * Sonar rarely returns usable CDN URLs — we fill gaps via:
 *   1) Amazon ASIN widget images
 *   2) og:image / JSON-LD / twitter:image from listing pages
 *   3) Same-series images already in data.json
 *   4) Known manufacturer CDN host patterns from HTML
 */
const fs = require("fs");
const path = require("path");
const { normalizeAsin } = require("./sku_ids");

function isHttpUrl(u) {
  return /^https?:\/\//i.test(String(u || "").trim());
}

/** True for likely product photo URLs (not HTML product pages). */
function isProductImageUrl(u) {
  const s = String(u || "").trim();
  if (!isHttpUrl(s)) return false;
  if (/^https?:\/\/(www\.)?(amazon\.|lenovo\.com|scan\.co|currys\.|geizhals)/i.test(s) &&
      !/\.(jpe?g|png|webp|gif)(\?|$)/i.test(s) &&
      !/AsinImage|media-amazon|static\.pub|images-amazon/i.test(s)) {
    // bare product HTML page
    if (/\/dp\/|\/p\/|\/product/i.test(s) && !/images?\//i.test(s)) return false;
  }
  if (/\.(jpe?g|png|webp|gif|avif)(\?|#|$)/i.test(s)) return true;
  if (/media-amazon\.com|ssl-images-amazon|images-na\.ssl-images-amazon|m\.media-amazon/i.test(s))
    return true;
  if (/amazon-adsystem\.com|AsinImage/i.test(s)) return true;
  // Lenovo OFP / static.pub (catalog uses p4-ofp.static.pub)
  if (/static\.pub|p\d-ofp\.static\.pub|ofp\.static\.pub/i.test(s)) return true;
  if (/storage-asset\.msi\.com|dlcdnwebimgs\.asus\.com|images\.acer\.com|i\.dell\.com/i.test(s))
    return true;
  if (/assets2\.razerzone|storeimages\.cdn-apple|cdn\.shopify|cloudinary|imgix\.net/i.test(s))
    return true;
  if (/\/medias\/|\/images\/product|product[_-]?image|gallery/i.test(s) && !/\.html?/i.test(s))
    return true;
  if (/ws-eu\.amazon-adsystem|images-eu\.ssl-images-amazon/i.test(s)) return true;
  return false;
}

function amazonImageFromAsin(asin, market = "GB") {
  const a = normalizeAsin(asin);
  if (!a) return "";
  // Multiple formats — browser often loads at least one
  return [
    `https://ws-eu.amazon-adsystem.com/widgets/q?_encoding=UTF8&MarketPlace=${market}&ASIN=${a}&ServiceVersion=20070822&ID=AsinImage&WS=1&Format=_SL500_`,
    `https://images-eu.ssl-images-amazon.com/images/P/${a}.01.LZZZZZZZ.jpg`,
    `https://m.media-amazon.com/images/P/${a}.01._SCLZZZZZZZ_SX500_.jpg`,
  ];
}

function uniqueUrls(list) {
  const out = [];
  const seen = new Set();
  for (const u of list || []) {
    const s = String(u || "").trim();
    if (!s || !isHttpUrl(s)) continue;
    // normalize double slashes in path (lenovo static.pub often has //fes)
    let n = s;
    try {
      const url = new URL(s);
      url.pathname = url.pathname.replace(/\/{2,}/g, "/");
      n = url.toString();
    } catch {
      /* keep */
    }
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function extractImageUrlsFromText(text) {
  const s = String(text || "");
  const found = [];
  const re =
    /https?:\/\/[^\s"'<>\\]+?\.(?:jpe?g|png|webp|gif)(?:\?[^\s"'<>\\]*)?/gi;
  let m;
  while ((m = re.exec(s))) {
    found.push(m[0].replace(/[),.;]+$/, ""));
  }
  // Amazon / Lenovo CDN without extension
  const re2 =
    /https?:\/\/(?:m\.media-amazon\.com|images-eu\.ssl-images-amazon\.com|[^"'\\s]*static\.pub)\/[^\s"'<>\\]+/gi;
  while ((m = re2.exec(s))) {
    found.push(m[0].replace(/[),.;]+$/, ""));
  }
  return uniqueUrls(found.filter(isProductImageUrl));
}

function extractImagesFromHtml(html, baseUrl) {
  const out = [];
  const h = String(html || "");

  const meta = (prop) => {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`,
      "i"
    );
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`,
      "i"
    );
    const m = h.match(re) || h.match(re2);
    return m ? m[1] : null;
  };

  for (const prop of [
    "og:image",
    "og:image:secure_url",
    "twitter:image",
    "twitter:image:src",
  ]) {
    const v = meta(prop);
    if (v) out.push(v);
  }

  // JSON-LD image
  const ldBlocks = h.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  if (ldBlocks) {
    for (const block of ldBlocks) {
      const raw = block.replace(/^[\s\S]*?>/, "").replace(/<\/script>$/i, "");
      try {
        const data = JSON.parse(raw);
        const walk = (node) => {
          if (!node) return;
          if (typeof node === "string" && isHttpUrl(node)) {
            if (isProductImageUrl(node) || /\.(jpe?g|png|webp)/i.test(node))
              out.push(node);
            return;
          }
          if (Array.isArray(node)) {
            node.forEach(walk);
            return;
          }
          if (typeof node === "object") {
            if (node.image) walk(node.image);
            if (node.images) walk(node.images);
            if (node.thumbnailUrl) walk(node.thumbnailUrl);
            if (node.contentUrl) walk(node.contentUrl);
            if (node["@graph"]) walk(node["@graph"]);
          }
        };
        walk(data);
      } catch {
        /* ignore bad json-ld */
      }
    }
  }

  // link rel image_src
  const linkImg = h.match(
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i
  );
  if (linkImg) out.push(linkImg[1]);

  // Absolute-ize relative URLs
  const abs = out.map((u) => {
    try {
      return new URL(u, baseUrl || undefined).toString();
    } catch {
      return u;
    }
  });

  // Also pull any static.pub / media-amazon URLs embedded in page (limited)
  abs.push(...extractImageUrlsFromText(h.slice(0, 400000)));

  return uniqueUrls(abs.filter(isProductImageUrl));
}

async function fetchHtml(url, { timeoutMs = 8000 } = {}) {
  if (!isHttpUrl(url)) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        // Real browser UA — manufacturer sites often 403 bare bots
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "accept-language": "en-GB,en;q=0.9",
        "cache-control": "no-cache",
      },
    });
    if (!res.ok) return null;
    const ctype = res.headers.get("content-type") || "";
    if (!/html|xml|text/i.test(ctype) && ctype) {
      // Might be a direct image URL
      if (/image\//i.test(ctype)) return { directImage: url };
      return null;
    }
    const buf = await res.arrayBuffer();
    // Cap ~800KB parse
    const slice = buf.byteLength > 800000 ? buf.slice(0, 800000) : buf;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
    return { html: text, finalUrl: res.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function loadCatalogSeriesImages(rootDir) {
  try {
    const dataPath = path.join(rootDir, "data.json");
    if (!fs.existsSync(dataPath)) return [];
    const d = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    const sheet =
      d.sheets?.find((x) => x.id === "sheet_laptops") ||
      d.sheets?.find((x) => /laptop/i.test(x.name || ""));
    if (!sheet?.rows) return [];
    return sheet.rows
      .map((r) => ({
        model: String(r.cells?.col_model || ""),
        brand: String(r.cells?.col_brand || ""),
        image: String(r.cells?.col_image || ""),
        images: Array.isArray(r.cells?.col_detail?.images)
          ? r.cells.col_detail.images
          : [],
      }))
      .filter((x) => x.image || x.images.length);
  } catch {
    return [];
  }
}

function seriesTokens(model) {
  return String(model || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !/^(the|and|with|for|gen|inch)$/.test(t));
}

function catalogFallbackImages(product, catalogRows) {
  const model = product.model || "";
  const brand = String(product.brand || "").toLowerCase();
  const tokens = seriesTokens(model);
  if (!tokens.length || !catalogRows?.length) return [];

  const scored = [];
  for (const row of catalogRows) {
    const rm = seriesTokens(row.model);
    if (!rm.length) continue;
    if (brand && row.brand && !String(row.brand).toLowerCase().includes(brand.slice(0, 4))) {
      // soft brand filter
    }
    let hits = 0;
    for (const t of tokens) if (rm.includes(t) || row.model.toLowerCase().includes(t)) hits++;
    // Prefer shared series words: legion, 5i, loq, etc.
    const keyHits = ["legion", "loq", "tuf", "strix", "zephyrus", "nitro", "victus", "katana", "thin", "sword", "blade", "yoga", "ideapad"]
      .filter((k) => tokens.includes(k) && (rm.includes(k) || row.model.toLowerCase().includes(k)));
    if (keyHits.length === 0 && hits < 3) continue;
    const score = hits + keyHits.length * 3;
    if (score < 3) continue;
    const imgs = uniqueUrls([row.image, ...(row.images || [])]).filter(isProductImageUrl);
    if (imgs.length) scored.push({ score, imgs, model: row.model });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.imgs?.slice(0, 4) || [];
}

/**
 * Resolve best product images for a recon product.
 * @returns {{ images: string[], credit: string, via: string[] }}
 */
async function resolveProductImages(product, { rootDir, maxFetches = 5 } = {}) {
  const via = [];
  let images = [];

  // 1) Already on product
  images = uniqueUrls([
    product.image_url,
    ...(product.image_urls || []),
  ]).filter(isProductImageUrl);
  if (images.length) via.push("sonar");

  // 2) Amazon ASIN widgets
  for (const asin of [product.asin_uk, product.asin_de].filter(Boolean)) {
    const market = product.asin_de && asin === product.asin_de ? "DE" : "GB";
    const widgets = amazonImageFromAsin(asin, market);
    for (const w of widgets) {
      if (!images.includes(w)) images.push(w);
    }
    if (widgets.length) via.push("asin_widget");
  }

  // 3) Extract from any free text fields
  const textBlob = [
    product.sources_note,
    product.price_note,
    ...(product.sources || []).map((s) => `${s.url} ${s.title} ${s.snippet || ""}`),
  ].join("\n");
  const fromText = extractImageUrlsFromText(textBlob);
  for (const u of fromText) if (!images.includes(u)) images.push(u);
  if (fromText.length) via.push("text_extract");

  // 4) Fetch listing / source pages for og:image (even if Sonar returned nothing)
  if (images.length < 2) {
    const candidates = [];
    if (product.amazon_uk_url) candidates.push(product.amazon_uk_url);
    if (product.amazon_de_url) candidates.push(product.amazon_de_url);
    for (const L of product.listings || []) {
      if (L?.url) candidates.push(L.url);
    }
    for (const s of product.sources || []) {
      if (s?.url && !/youtube\.com|youtu\.be/i.test(s.url)) candidates.push(s.url);
    }
    // Prefer brand product pages + hard retail for og:image
    candidates.sort((a, b) => {
      const score = (u) => {
        let s = 0;
        if (/amazon\.(co\.uk|de)\/(?:dp|gp)/i.test(u)) s += 8;
        if (/lenovo\.com|asus\.com|msi\.com|acer\.com|hp\.com|dell\.com/i.test(u)) s += 6;
        if (/scan\.co|currys\.|notebookcheck/i.test(u)) s += 4;
        if (/presisearch|MainSearch|tbm=shop|\?fs=/i.test(u)) s -= 10;
        return s;
      };
      return score(b) - score(a);
    });

    const seen = new Set();
    let fetches = 0;
    for (const url of candidates) {
      if (fetches >= maxFetches) break;
      if (!url || seen.has(url)) continue;
      // Skip pure search aggregators
      if (/presisearch|MainSearch|tbm=shop|\?fs=|google\./i.test(url)) continue;
      seen.add(url);
      fetches++;
      const page = await fetchHtml(url, { timeoutMs: 12000 });
      if (!page) continue;
      if (page.directImage) {
        if (!images.includes(page.directImage)) images.push(page.directImage);
        via.push("direct");
        continue;
      }
      const extracted = extractImagesFromHtml(page.html, page.finalUrl || url);
      // Prefer larger-looking / product CDN
      extracted.sort((a, b) => {
        const score = (u) => {
          let s = 0;
          if (/static\.pub|media-amazon|storage-asset|dlcdnwebimgs/i.test(u)) s += 5;
          if (/icon|logo|sprite|pixel|1x1|favicon/i.test(u)) s -= 10;
          if (/_\d{2,3}x\d{2,3}/i.test(u)) s -= 2;
          if (/SL500|w800|wid=800|500x|1000x/i.test(u)) s += 3;
          return s;
        };
        return score(b) - score(a);
      });
      for (const u of extracted.slice(0, 4)) {
        if (!images.includes(u) && !/icon|logo|sprite|favicon|1x1/i.test(u)) {
          images.push(u);
        }
      }
      if (extracted.length) via.push("og:" + new URL(url).hostname.replace(/^www\./, ""));
      if (images.length >= 4) break;
    }
  }

  // 5) Catalog series fallback (e.g. other Legion 5 photos)
  if (images.length === 0 && rootDir) {
    const catalog = loadCatalogSeriesImages(rootDir);
    const fb = catalogFallbackImages(product, catalog);
    for (const u of fb) if (!images.includes(u)) images.push(u);
    if (fb.length) via.push("catalog_series");
  }

  images = uniqueUrls(images).filter(isProductImageUrl).slice(0, 8);

  let credit = "Product photography from manufacturer / retail listings (recon).";
  if (via.includes("catalog_series") && !via.includes("og:") && !via.includes("asin_widget")) {
    credit = "Series photo from catalog (same family) — exact SKU colour/config may differ.";
  } else if (via.includes("asin_widget")) {
    credit = "Amazon product image (ASIN widget) — confirm colourway on the listing.";
  }

  return { images, credit, via: [...new Set(via)] };
}

module.exports = {
  isProductImageUrl,
  isHttpUrl,
  amazonImageFromAsin,
  extractImageUrlsFromText,
  extractImagesFromHtml,
  resolveProductImages,
  catalogFallbackImages,
  loadCatalogSeriesImages,
};
