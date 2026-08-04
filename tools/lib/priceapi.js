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
 * @param {string[]} opts.values
 */
async function createJob(opts) {
  const t = token();
  if (!t) throw new Error("PRICEAPI_TOKEN not set");

  const country = (opts.country || "de").toLowerCase();
  // PriceAPI often uses "gb" for UK
  const countryNorm = country === "uk" ? "gb" : country;

  const body = {
    source: opts.source,
    country: countryNorm,
    topic: opts.topic || "product_and_offers",
    key: opts.key,
    values: opts.values.map(String),
    max_age: opts.max_age != null ? opts.max_age : 3600, // seconds; 0 = realtime (costs more)
  };

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
  const url = `${BASE}/jobs/${encodeURIComponent(jobId)}/download?token=${encodeURIComponent(t)}&format=${encodeURIComponent(format)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`PriceAPI download ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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
 * Normalize various result shapes into a simple snapshot for our catalog
 */
function summarizeResults(results, { currencyHint } = {}) {
  // Results may be array of products, or { results: [...] }, or nested offers
  const list = Array.isArray(results)
    ? results
    : results?.results || results?.data || results?.products || [];
  if (!Array.isArray(list) || !list.length) {
    return { products: 0, min_price: null, currency: currencyHint || null, sample: null };
  }

  let minPrice = null;
  let currency = currencyHint || null;
  let sampleTitle = null;
  let offerCount = 0;
  let shops = [];

  for (const p of list) {
    sampleTitle =
      sampleTitle ||
      p.name ||
      p.title ||
      p.product_name ||
      p.product?.name ||
      null;
    const offers =
      p.offers ||
      p.Offers ||
      p.shops ||
      p.product?.offers ||
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
  };
}

module.exports = {
  hasPriceApiKey,
  createJob,
  getJob,
  downloadJob,
  waitForJob,
  fetchProductAndOffers,
  summarizeResults,
  token,
};
