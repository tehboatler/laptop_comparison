/**
 * Minimal Amazon Product Advertising API 5.0 client (GetItems).
 * Requires: AMAZON_ACCESS_KEY, AMAZON_SECRET_KEY, AMAZON_PARTNER_TAG
 * Optional: AMAZON_HOST (default webservices.amazon.co.uk), AMAZON_REGION (eu-west-1)
 *
 * Docs: https://webservices.amazon.com/paapi5/documentation/
 * Access: Amazon Associates account + PA-API approval (sales threshold may apply).
 */
const crypto = require("crypto");

function env(name, fallback) {
  const v = process.env[name];
  return v != null && String(v).trim() !== "" ? String(v).trim() : fallback;
}

function hasAmazonCreds() {
  return !!(
    env("AMAZON_ACCESS_KEY") &&
    env("AMAZON_SECRET_KEY") &&
    env("AMAZON_PARTNER_TAG")
  );
}

function hmac(key, data, enc) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest(enc);
}

function sha256(data) {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function amzDate() {
  const d = new Date();
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amz: iso, date: iso.slice(0, 8) };
}

/**
 * @param {string[]} asins max 10
 * @param {"uk"|"de"|"com"} marketplace
 */
async function getItems(asins, marketplace = "uk") {
  if (!hasAmazonCreds()) {
    throw new Error("Amazon PA-API credentials not set");
  }
  const hosts = {
    uk: { host: "webservices.amazon.co.uk", region: "eu-west-1", marketplace: "www.amazon.co.uk" },
    de: { host: "webservices.amazon.de", region: "eu-west-1", marketplace: "www.amazon.de" },
    com: { host: "webservices.amazon.com", region: "us-east-1", marketplace: "www.amazon.com" },
  };
  const cfg = hosts[marketplace] || hosts.uk;
  const host = env("AMAZON_HOST", cfg.host);
  const region = env("AMAZON_REGION", cfg.region);
  const accessKey = env("AMAZON_ACCESS_KEY");
  const secretKey = env("AMAZON_SECRET_KEY");
  const partnerTag = env("AMAZON_PARTNER_TAG");

  const pathName = "/paapi5/getitems";
  const service = "ProductAdvertisingAPI";
  const { amz, date } = amzDate();

  const payloadObj = {
    ItemIds: asins.filter(Boolean).slice(0, 10),
    PartnerTag: partnerTag,
    PartnerType: "Associates",
    Marketplace: cfg.marketplace,
    Resources: [
      "ItemInfo.Title",
      "ItemInfo.ByLineInfo",
      "ItemInfo.Classifications",
      "ItemInfo.ExternalIds",
      "ItemInfo.Features",
      "ItemInfo.ManufactureInfo",
      "ItemInfo.ProductInfo",
      "ItemInfo.TechnicalInfo",
      "Offers.Listings.Price",
      "Offers.Listings.Availability",
      "Offers.Listings.Condition",
      "Offers.Listings.MerchantInfo",
      "Images.Primary.Large",
    ],
  };
  const payload = JSON.stringify(payloadObj);

  const canonicalHeaders =
    `content-encoding:amz-1.0\n` +
    `content-type:application/json; charset=utf-8\n` +
    `host:${host}\n` +
    `x-amz-date:${amz}\n` +
    `x-amz-target:com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems\n`;
  const signedHeaders =
    "content-encoding;content-type;host;x-amz-date;x-amz-target";
  const canonicalRequest = [
    "POST",
    pathName,
    "",
    canonicalHeaders,
    signedHeaders,
    sha256(payload),
  ].join("\n");

  const credentialScope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amz,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");

  const kDate = hmac("AWS4" + secretKey, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign, "hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${host}${pathName}`, {
    method: "POST",
    headers: {
      "content-encoding": "amz-1.0",
      "content-type": "application/json; charset=utf-8",
      host,
      "x-amz-date": amz,
      "x-amz-target":
        "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems",
      authorization,
    },
    body: payload,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Amazon PA-API non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg =
      json?.Errors?.[0]?.Message ||
      json?.message ||
      JSON.stringify(json).slice(0, 300);
    throw new Error(`Amazon PA-API ${res.status}: ${msg}`);
  }
  return json;
}

/** Parse GetItems result into a simple map asin -> snapshot */
function parseGetItems(result) {
  const out = {};
  const items = result?.ItemsResult?.Items || [];
  for (const item of items) {
    const asin = item.ASIN;
    const listing = item.Offers?.Listings?.[0];
    const price = listing?.Price;
    const amount = price?.Amount;
    const currency = price?.Currency;
    const availability = listing?.Availability?.Message || "";
    const title = item.ItemInfo?.Title?.DisplayValue || "";
    const eans = item.ItemInfo?.ExternalIds?.EANs?.DisplayValues || [];
    const upcs = item.ItemInfo?.ExternalIds?.UPCs?.DisplayValues || [];
    const mpn =
      item.ItemInfo?.ManufactureInfo?.ItemPartNumber?.DisplayValue || "";
    const brand = item.ItemInfo?.ByLineInfo?.Brand?.DisplayValue || "";
    const image = item.Images?.Primary?.Large?.URL || "";
    out[asin] = {
      asin,
      title,
      brand,
      mpn,
      ean: eans[0] || "",
      upc: upcs[0] || "",
      price: amount != null ? Number(amount) : null,
      currency: currency || null,
      availability,
      inStock: /in stock|usually dispatched|available/i.test(availability),
      image,
      detailPageUrl: item.DetailPageURL || "",
      rawFeatures: item.ItemInfo?.Features?.DisplayValues || [],
    };
  }
  return out;
}

module.exports = {
  hasAmazonCreds,
  getItems,
  parseGetItems,
};
