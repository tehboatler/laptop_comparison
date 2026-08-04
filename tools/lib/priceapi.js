/**
 * metoda Price API (priceapi.com) client
 * Docs: https://www.priceapi.com / https://support.metoda.com
 * Base: https://api.priceapi.com/v2  (also priceapi.metoda.com)
 *
 * Signup: https://www.priceapi.com/users/sign_up  (trial credits)
 * Env: PRICEAPI_TOKEN  (or PRICEAPI_KEY for compatibility)
 *
 * This is a commercial data API (they scrape Amazon, Idealo, Geizhals, Google Shopping…).
 * Easier onboarding than Amazon Associates PA-API for multi-shop EU/UK prices.
 */
const BASE = process.env.PRICEAPI_BASE || "https://api.priceapi.com/v2";

function token() {
  return (
    process.env.PRICEAPI_TOKEN ||
    process.env.PRICEAPI_KEY ||
    ""
  ).trim();
}

function hasPriceApiKey() {
  return !!token();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Create a job
 * @param {object} opts
 * @param {string} opts.source e.g. amazon, google_shopping, idealo, geizhals
 * @param {string} opts.country e.g. de, gb, uk (API may use gb)
 * @param {string} opts.topic e.g. product_and_offers, search_results
 * @param {string} opts.key gtin | term | asin | mpn | identifier
 * @param {string[]|string} opts.values
 * @param {number} [opts.max_pages] search pagination (search_results)
 * @param {number} [opts.max_age] cache freshness (API: minutes on most topics)
 */
async function createJob(opts) {
  const t = token();
  if (!t) throw new Error("PRICEAPI_TOKEN not set");

  const country = (opts.country || "de").toLowerCase();
  // PriceAPI often uses "gb" for UK
  const countryNorm = country === "uk" ? "gb" : country;

  const valuesArr = Array.isArray(opts.values)
    ? opts.values.map(String)
    : String(opts.values || "")
        .split(/\n/)
        .map((s) => s.trim())
        .filter(Boolean);

  const body = {
    source: opts.source,
    country: countryNorm,
    topic: opts.topic || "product_and_offers",
    key: opts.key,
    // JSON API accepts array; form samples use newline-joined strings
    values: valuesArr,
    max_age: opts.max_age != null ? opts.max_age : 1440,
  };
  if (opts.max_pages != null) body.max_pages = opts.max_pages;

  const url = `${BASE}/jobs?token=${encodeURIComponent(t)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `PriceAPI create job ${res.status}: ${JSON.stringify(json).slice(0, 400)}`
    );
  }
  // job id may be json.job_id, json.id, or nested
  const jobId = json.job_id || json.id || json.job?.id;
  if (!jobId) {
    throw new Error(
      `PriceAPI: no job id in response: ${JSON.stringify(json).slice(0, 400)}`
    );
  }
  return { jobId: String(jobId), raw: json };
}

async function getJob(jobId) {
  const t = token();
  const url = `${BASE}/jobs/${encodeURIComponent(jobId)}?token=${encodeURIComponent(t)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `PriceAPI get job ${res.status}: ${JSON.stringify(json).slice(0, 300)}`
    );
  }
  return json;
}

async function downloadJob(jobId, format = "json") {
  const t = token();
  // Docs: follow redirects (pre-rendered results may 302)
  // Prefer /download.json which some clients use
  const baseUrl = `${BASE}/jobs/${encodeURIComponent(jobId)}/download`;
  const urls = [
    `${baseUrl}.${format}?token=${encodeURIComponent(t)}`,
    `${baseUrl}?token=${encodeURIComponent(t)}&format=${encodeURIComponent(format)}`,
  ];
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        redirect: "follow",
      });
      const text = await res.text();
      if (!res.ok) {
        lastErr = new Error(`PriceAPI download ${res.status}: ${text.slice(0, 300)}`);
        continue;
      }
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("PriceAPI download failed");
}

/**
 * Poll until finished (or timeout)
 */
async function waitForJob(jobId, { timeoutMs = 180000, intervalMs = 2500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await getJob(jobId);
    const status = String(
      job.status || job.state || job.job?.status || ""
    ).toLowerCase();
    if (
      status === "finished" ||
      status === "done" ||
      status === "completed" ||
      status === "success" ||
      job.finished === true
    ) {
      return job;
    }
    if (
      status === "failed" ||
      status === "error" ||
      status === "cancelled" ||
      status === "canceled"
    ) {
      throw new Error(`PriceAPI job ${jobId} ${status}: ${JSON.stringify(job).slice(0, 300)}`);
    }
    // progress sometimes as percent
    const pct = job.progress ?? job.percent;
    if (pct != null) process.stdout.write(`\r  job ${jobId} … ${pct}%   `);
    await sleep(intervalMs);
  }
  throw new Error(`PriceAPI job ${jobId} timed out after ${timeoutMs}ms`);
}

/**
 * High-level: request product+offers and return downloaded results
 */
async function fetchProductAndOffers({ source, country, key, values, max_age }) {
  const { jobId } = await createJob({
    source,
    country,
    topic: "product_and_offers",
    key,
    values,
    max_age,
  });
  await waitForJob(jobId);
  process.stdout.write("\n");
  const results = await downloadJob(jobId, "json");
  return { jobId, results };
}

/**
 * Free-text product discovery (topic search_results, key term).
 * Works on amazon / google_shopping for many countries — use this to find ASINs/GTINs.
 */
async function fetchSearchResults({
  source = "amazon",
  country = "gb",
  values,
  max_age,
  max_pages = 1,
}) {
  const { jobId } = await createJob({
    source,
    country,
    topic: "search_results",
    key: "term",
    values,
    max_age: max_age != null ? max_age : 1440,
    max_pages,
  });
  await waitForJob(jobId);
  process.stdout.write("\n");
  const results = await downloadJob(jobId, "json");
  return { jobId, results };
}

/**
 * Official Price API v2 download shape:
 * {
 *   job_id, status, results: [{
 *     query: { value, key, topic, ... },
 *     success: true|false,
 *     reason?: string,
 *     content: {
 *       search_results: [{ id, name, url, ... }],
 *       // or product / offers / products depending on topic
 *     }
 *   }]
 * }
 */
function getResultBlocks(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

function attachOffersToProduct(p, offers) {
  if (!p || !Array.isArray(offers) || !offers.length) return p;
  p.offers = offers;
  const prices = offers
    .map((o) =>
      Number(
        typeof o.price === "string"
          ? o.price.replace(/[^0-9.]/g, "")
          : o.price ?? o.total_price ?? o.price_with_shipping
      )
    )
    .filter((n) => !isNaN(n) && n > 0);
  if (prices.length) p.price = Math.min(...prices);
  if (offers[0]?.currency) p.currency = offers[0].currency;
  // Backfill ASIN from offer product_id
  if (!p.asin && offers[0]?.product_id) p.asin = offers[0].product_id;
  return p;
}

function extractContentItems(content) {
  if (!content || typeof content !== "object") return [];
  // search_results topic
  if (Array.isArray(content.search_results)) return content.search_results;
  if (Array.isArray(content.products)) return content.products;
  if (Array.isArray(content.items)) return content.items;
  if (Array.isArray(content.results)) return content.results;

  // product_and_offers: content is often the product itself (name/id/eans/offers)
  if (content.name || content.title || content.asin || content.id || content.buybox) {
    const p = { ...content };
    // EANs / GTINs as arrays on Amazon
    if (!p.ean && Array.isArray(p.eans) && p.eans[0]) p.ean = p.eans[0];
    if (!p.gtin && Array.isArray(p.gtins) && p.gtins[0]) p.gtin = p.gtins[0];
    if (!p.mpn && Array.isArray(p.mpns) && p.mpns[0]) p.mpn = p.mpns[0];
    if (!p.asin && looksLikeAsin(p.id)) p.asin = p.id;
    // Buybox price when offers empty (Amazon uses min_price on buybox)
    if (p.price == null && p.buybox) {
      const bp =
        p.buybox.price ?? p.buybox.min_price ?? p.buybox.price_with_shipping;
      if (bp != null) p.price = bp;
      if (!p.currency && p.buybox.currency) p.currency = p.buybox.currency;
    }
    if (Array.isArray(content.offers)) attachOffersToProduct(p, content.offers);
    return [p];
  }

  // Nested product object
  if (content.product && typeof content.product === "object") {
    const p = { ...content.product };
    if (Array.isArray(content.offers)) attachOffersToProduct(p, content.offers);
    return [p];
  }

  // Offers-only (rare)
  if (Array.isArray(content.offers)) return content.offers;
  return [];
}

/** Flatten downloaded job payload into a list of product-like objects */
function flattenProducts(results) {
  if (!results) return [];
  // Prefer official blocks
  const blocks = getResultBlocks(results);
  if (blocks.length) {
    const out = [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      // Skip envelope-only rows (query wrappers without content)
      if (block.content) {
        const q =
          block.query?.value ||
          block.query?.term ||
          (typeof block.query === "string" ? block.query : "") ||
          "";
        for (const item of extractContentItems(block.content)) {
          out.push({ ...item, _query: q, _success: block.success });
        }
        continue;
      }
      // Legacy: block itself is a product
      if (block.name || block.title || block.asin) out.push(block);
    }
    if (out.length) return out;
  }

  if (Array.isArray(results)) return results;
  if (Array.isArray(results.products)) return results.products;
  if (Array.isArray(results.jobs)) {
    return results.jobs.flatMap((j) => flattenProducts(j));
  }
  return [];
}

function looksLikeAsin(s) {
  return typeof s === "string" && /^B0[A-Z0-9]{8}$/i.test(s.trim());
}

/**
 * Normalize search / product hits into a common shape for matching.
 */
function normalizeProductHit(p, { query } = {}) {
  if (!p || typeof p !== "object") return null;
  // Skip API envelope rows that aren't products
  if (p.query && p.content && !p.name && !p.title) return null;
  if (p.success === false && !p.name && !p.title) return null;

  const title =
    p.name ||
    p.title ||
    p.product_name ||
    p.product?.name ||
    p.product?.title ||
    "";
  let asin = String(
    p.asin || p.ASIN || p.product?.asin || p.product_id || ""
  ).trim();
  // Amazon search often puts ASIN in `id`
  if (!asin && looksLikeAsin(p.id)) asin = String(p.id).trim();
  if (!asin && looksLikeAsin(p.sku)) asin = String(p.sku).trim();
  // Extract ASIN from Amazon URL
  if (!asin && p.url) {
    const m = String(p.url).match(/\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})/i);
    if (m) asin = m[1];
  }

  const gtinRaw =
    p.gtin ||
    p.ean ||
    p.GTIN ||
    p.EAN ||
    (Array.isArray(p.gtins) ? p.gtins[0] : "") ||
    p.product?.gtin ||
    p.product?.ean ||
    "";
  const gtin = String(gtinRaw || "")
    .replace(/\D/g, "")
    .trim();
  const priceRaw =
    p.price ??
    p.min_price ??
    p.lowest_price ??
    p.price_value ??
    p.product?.price ??
    p.offers?.[0]?.price ??
    null;
  const price = Number(
    typeof priceRaw === "string" ? priceRaw.replace(/[^0-9.]/g, "") : priceRaw
  );
  const currency =
    p.currency ||
    p.Currency ||
    p.product?.currency ||
    p.offers?.[0]?.currency ||
    null;
  const url =
    p.url ||
    p.link ||
    p.product_url ||
    p.product?.url ||
    (asin ? `https://www.amazon.co.uk/dp/${asin}` : "") ||
    "";
  const image =
    p.image ||
    p.image_url ||
    p.image_urls?.[0] ||
    p.images?.[0] ||
    p.product?.image ||
    null;
  const id =
    p.id ||
    p.product_id ||
    p.sku ||
    p.identifier ||
    asin ||
    gtin ||
    null;

  if (!title && !asin && !gtin) return null;

  return {
    title: String(title),
    asin: asin || "",
    gtin: gtin.length >= 8 ? gtin : "",
    ean: gtin.length >= 8 ? gtin : "",
    price: !isNaN(price) && price > 0 ? price : null,
    currency: currency || null,
    url: String(url || ""),
    image: image || null,
    id: id != null ? String(id) : "",
    mpn: String(p.mpn || p.MPN || p.product?.mpn || "").trim(),
    query: query || p._query || p.query || p.term || "",
    raw_keys: Object.keys(p).slice(0, 24),
  };
}

/**
 * Parse search_results (or product) download into product hits.
 */
function parseSearchResults(results, { values = [] } = {}) {
  const hits = [];
  const blocks = getResultBlocks(results);

  if (blocks.length) {
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      const q =
        block.query?.value ||
        block.query?.term ||
        (typeof block.query === "string" ? block.query : "") ||
        values[0] ||
        "";
      if (block.success === false) {
        // Surface failures as zero hits for that query (caller can log)
        continue;
      }
      const items = block.content
        ? extractContentItems(block.content)
        : block.name || block.title
          ? [block]
          : [];
      for (const item of items) {
        const hit = normalizeProductHit(item, { query: q });
        if (hit) hits.push(hit);
      }
    }
  }

  // Fallback for unexpected shapes
  if (!hits.length) {
    for (const p of flattenProducts(results)) {
      const hit = normalizeProductHit(p, {
        query: p._query || values[0] || "",
      });
      if (hit) hits.push(hit);
    }
  }

  if (hits.length && values.length === 1) {
    for (const h of hits) {
      if (!h.query) h.query = values[0];
    }
  }

  return hits;
}

/** Collect per-query failures from a download payload */
function parseResultErrors(results) {
  const errors = [];
  for (const block of getResultBlocks(results)) {
    if (block && block.success === false) {
      const q = block.query?.value || block.query?.term || "?";
      errors.push(`${q}: ${block.reason || block.comment || "failed"}`);
    }
  }
  return errors;
}

/**
 * Summarize product_and_offers download using official content nesting.
 */
function summarizeDownload(results, { currencyHint } = {}) {
  const hits = parseSearchResults(results);
  if (!hits.length) {
    // Try offers nested in content blocks
    const blocks = getResultBlocks(results);
    let minPrice = null;
    let currency = currencyHint || null;
    let offerCount = 0;
    let shops = [];
    let sampleTitle = null;
    for (const block of blocks) {
      const content = block?.content;
      if (!content) continue;
      sampleTitle =
        sampleTitle ||
        content.product?.name ||
        content.product?.title ||
        content.name ||
        null;
      const offers = content.offers || content.product?.offers || [];
      if (Array.isArray(offers)) {
        for (const o of offers) {
          offerCount++;
          const price = Number(o.price ?? o.total_price ?? o.amount);
          if (!isNaN(price) && price > 0) {
            if (minPrice == null || price < minPrice) minPrice = price;
          }
          if (o.currency) currency = o.currency;
          const shop = o.shop_name || o.shop || o.merchant || o.seller;
          if (shop) shops.push(String(shop));
        }
      }
    }
    return {
      products: sampleTitle || offerCount ? 1 : 0,
      min_price: minPrice,
      currency,
      offer_count: offerCount,
      shops: [...new Set(shops)].slice(0, 8),
      sample_title: sampleTitle,
      errors: parseResultErrors(results),
    };
  }

  let minPrice = null;
  let currency = currencyHint || null;
  let offerCount = 0;
  const shops = [];
  for (const h of hits) {
    if (h.price != null) {
      if (minPrice == null || h.price < minPrice) minPrice = h.price;
    }
    if (h.currency) currency = h.currency;
  }
  // Count offers from blocks when available
  for (const block of getResultBlocks(results)) {
    const offers = block?.content?.offers;
    if (Array.isArray(offers)) {
      offerCount += offers.length;
      for (const o of offers) {
        const price = Number(o.price ?? o.total_price);
        if (!isNaN(price) && price > 0) {
          if (minPrice == null || price < minPrice) minPrice = price;
        }
        if (o.currency) currency = o.currency;
        const shop = o.shop_name || o.shop || o.merchant;
        if (shop) shops.push(String(shop));
      }
    }
  }
  if (!offerCount) offerCount = hits.filter((h) => h.price != null).length;

  return {
    products: hits.length,
    min_price: minPrice,
    currency,
    offer_count: offerCount,
    shops: [...new Set(shops)].slice(0, 8),
    sample_title: hits[0]?.title || null,
    errors: parseResultErrors(results),
  };
}

/**
 * Normalize various result shapes into a simple snapshot for our catalog
 */
function summarizeResults(results, { currencyHint } = {}) {
  // Prefer official v2 nesting; fall back to legacy flat list
  const modern = summarizeDownload(results, { currencyHint });
  if (modern.products || modern.offer_count || modern.min_price != null) {
    return modern;
  }

  const list = Array.isArray(results)
    ? results
    : results?.results || results?.data || results?.products || [];
  if (!Array.isArray(list) || !list.length) {
    return {
      products: 0,
      min_price: null,
      currency: currencyHint || null,
      sample: null,
      errors: parseResultErrors(results),
    };
  }

  let minPrice = null;
  let currency = currencyHint || null;
  let sampleTitle = null;
  let offerCount = 0;
  let shops = [];

  for (const p of list) {
    // Skip envelope rows
    if (p?.content && !p.name && !p.title) continue;
    sampleTitle =
      sampleTitle ||
      p.name ||
      p.title ||
      p.product_name ||
      p.product?.name ||
      p.content?.product?.name ||
      null;
    const offers =
      p.offers ||
      p.Offers ||
      p.shops ||
      p.product?.offers ||
      p.content?.offers ||
      (p.price != null ? [p] : []);
    if (Array.isArray(offers)) {
      for (const o of offers) {
        offerCount++;
        const price = Number(
          o.price ?? o.Price ?? o.total_price ?? o.amount ?? o.value
        );
        const cur =
          o.currency || o.Currency || p.currency || currencyHint || null;
        if (cur) currency = cur;
        if (!isNaN(price) && price > 0) {
          if (minPrice == null || price < minPrice) minPrice = price;
        }
        const shop = o.shop_name || o.shop || o.merchant || o.seller;
        if (shop) shops.push(String(shop));
      }
    } else if (p.price != null) {
      const price = Number(p.price);
      if (!isNaN(price) && price > 0) {
        if (minPrice == null || price < minPrice) minPrice = price;
      }
    }
  }

  return {
    products: list.length,
    min_price: minPrice,
    currency,
    offer_count: offerCount,
    shops: [...new Set(shops)].slice(0, 8),
    sample_title: sampleTitle,
    errors: parseResultErrors(results),
  };
}

module.exports = {
  hasPriceApiKey,
  createJob,
  getJob,
  downloadJob,
  waitForJob,
  fetchProductAndOffers,
  fetchSearchResults,
  flattenProducts,
  normalizeProductHit,
  parseSearchResults,
  parseResultErrors,
  summarizeDownload,
  summarizeResults,
  getResultBlocks,
  extractContentItems,
  token,
};
