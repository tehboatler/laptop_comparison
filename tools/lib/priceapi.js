/**
 * Optional PriceAPI.com client for Geizhals product matching by GTIN/EAN.
 * https://priceapi.com — commercial, not free.
 * Env: PRICEAPI_KEY, PRICEAPI_SOURCE (default geizhals)
 */
function env(name, fallback) {
  const v = process.env[name];
  return v != null && String(v).trim() !== "" ? String(v).trim() : fallback;
}

function hasPriceApiKey() {
  return !!env("PRICEAPI_KEY");
}

async function matchByGtin(gtin) {
  if (!hasPriceApiKey()) throw new Error("PRICEAPI_KEY not set");
  const key = env("PRICEAPI_KEY");
  const source = env("PRICEAPI_SOURCE", "geizhals");
  // PriceAPI job-based API patterns vary by plan; this uses their common REST shape.
  // If your plan differs, adjust the URL per https://priceapi.com docs.
  const url = `https://api.priceapi.com/v2/jobs?token=${encodeURIComponent(key)}`;
  const body = {
    source,
    country: env("PRICEAPI_COUNTRY", "de"),
    topic: "product_and_offers",
    key: "gtin",
    values: [String(gtin)],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `PriceAPI ${res.status}: ${JSON.stringify(json).slice(0, 240)}`
    );
  }
  return json;
}

module.exports = { hasPriceApiKey, matchByGtin };
