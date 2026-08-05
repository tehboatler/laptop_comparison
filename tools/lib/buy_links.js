/**
 * Ireland / EU shopping workflow for buy links.
 *
 * Recommended path for this finder:
 *   1) Google Shopping Ireland — price band + in-stock / delivery filters
 *   2) Geizhals / Idealo — cheapest EU sellers for the exact model
 *   3) Irish / UK shops for convenience & warranty:
 *      Currys.ie · Expert.ie · DID Electrical · Amazon.ie · Amazon.co.uk
 *
 * Links are search/compare URLs only (no scraping).
 */

function cleanQuery(model, gpuShort) {
  let m = String(model || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s*[·|]\s*RTX\s*\d{4}.*$/i, " ") // strip config tails we add in recon
    .replace(/\s+/g, " ")
    .trim();
  const gpu = String(gpuShort || "")
    .replace(/NVIDIA GeForce /i, "")
    .replace(/Laptop GPU/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const base = m
    .replace(/,?\s*2025–26/i, "")
    .replace(/,?\s*2025/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return { modelQ: base, fullQ: `${base} ${gpu}`.trim(), gpu };
}

const BUY_GUIDE_IE =
  "Ireland workflow: (1) Google Shopping IE — filter price + in stock / delivery. " +
  "(2) Paste the exact model into Geizhals or Idealo for cheapest EU sellers. " +
  "(3) Cross-check Currys.ie, Expert.ie, DID Electrical, Amazon.ie / Amazon.co.uk for local stock & easier returns. " +
  "Confirm VAT, warranty country, and that the listing matches CPU · GPU · RAM · SSD.";

/**
 * @param {string} model
 * @param {string} brand
 * @param {string} gpuModel
 * @param {string} gpuId
 * @param {object} skuMap
 */
function buildBuyLinks(model, brand, gpuModel, gpuId, skuMap = {}) {
  const gpuShort =
    gpuModel ||
    (gpuId ? String(gpuId).replace(/^rtx/i, "RTX ").replace(/^rx/i, "RX ") : "");
  const { modelQ, fullQ, gpu } = cleanQuery(model, gpuShort);
  const enc = (s) => encodeURIComponent(s);
  const brandKey = String(brand || "").toLowerCase();
  const asinUk = (skuMap.asin_uk || "").trim();
  const asinDe = (skuMap.asin_de || "").trim();

  const official = {
    asus: `https://www.asus.com/ie/searchresult?searchType=products&searchKey=${enc(modelQ)}`,
    msi: `https://www.msi.com/search/?q=${enc(modelQ)}`,
    lenovo: `https://www.lenovo.com/ie/en/search?text=${enc(modelQ + " " + gpu)}`,
    acer: `https://www.acer.com/ie-en/search?q=${enc(modelQ)}`,
    hp: `https://www.hp.com/ie-en/search.html?q=${enc(modelQ + " " + gpu)}`,
    dell: `https://www.dell.com/en-ie/search/${enc(modelQ)}`,
    razer: `https://www.razer.com/search/${enc(modelQ)}`,
    apple: "https://www.apple.com/ie/shop/buy-mac/macbook-pro",
    gigabyte: `https://www.gigabyte.com/Search?Keyword=${enc(modelQ)}`,
    framework: "https://frame.work/ie/en/laptop16",
  };

  /** @type {Array<object>} */
  const links = [
    // ── 1) Live price maps ─────────────────────────────────────
    {
      region: "IE",
      retailer: "Google Shopping IE",
      kind: "compare",
      step: 1,
      label: "Google Shopping Ireland",
      url: `https://www.google.ie/search?tbm=shop&hl=en&gl=ie&q=${enc(fullQ)}`,
      note: "Start here — filter by price, in stock, and delivery to Ireland",
    },
    {
      region: "EU",
      retailer: "Geizhals",
      kind: "compare",
      step: 2,
      label: "Geizhals · cheapest EU",
      url: `https://geizhals.eu/?fs=${enc(fullQ)}&hloc=at&hloc=de&hloc=eu&hloc=pl`,
      note: "Exact model → usually surfaces the lowest EU street prices",
    },
    {
      region: "EU",
      retailer: "Idealo",
      kind: "compare",
      step: 2,
      label: "Idealo · EU / DE compare",
      url: `https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=${enc(fullQ)}`,
      note: "Backup EU compare if Geizhals is thin on this SKU",
    },
    {
      region: "UK",
      retailer: "Idealo UK",
      kind: "compare",
      step: 2,
      label: "Idealo.co.uk",
      url: `https://www.idealo.co.uk/presisearch?q=${enc(fullQ)}`,
      note: "UK floor — useful vs Amazon.co.uk / Scan",
    },

    // ── 2) Ireland / UK convenience ────────────────────────────
    {
      region: "IE",
      retailer: "Currys IE",
      kind: "shop",
      step: 3,
      label: "Currys.ie",
      url: `https://www.currys.ie/search?q=${enc(modelQ + (gpu ? " " + gpu : ""))}`,
      note: "Irish high-street · local returns",
    },
    {
      region: "IE",
      retailer: "Expert IE",
      kind: "shop",
      step: 3,
      label: "Expert.ie",
      url: `https://www.expert.ie/search?q=${enc(modelQ)}`,
      note: "Irish independent / Expert network",
    },
    {
      region: "IE",
      retailer: "DID Electrical",
      kind: "shop",
      step: 3,
      label: "DID Electrical",
      url: `https://www.did.ie/search?q=${enc(modelQ + (gpu ? " " + gpu : ""))}`,
      note: "Irish retailer · check stock for collection",
    },
    {
      region: "IE",
      retailer: "Amazon.ie",
      kind: "shop",
      step: 3,
      label: "Amazon.ie",
      url: asinUk
        ? `https://www.amazon.ie/dp/${asinUk}`
        : `https://www.amazon.ie/s?k=${enc(fullQ)}`,
      note: asinUk
        ? "Same ASIN when listed on .ie — confirm seller & delivery"
        : "Search Amazon.ie — prefer Amazon EU / high-rated sellers",
    },
    {
      region: "UK",
      retailer: "Amazon.co.uk",
      kind: "shop",
      step: 3,
      label: asinUk ? "Amazon.co.uk · ASIN" : "Amazon.co.uk",
      url: asinUk
        ? `https://www.amazon.co.uk/dp/${asinUk}`
        : `https://www.amazon.co.uk/s?k=${enc(fullQ)}`,
      note: asinUk
        ? "SKU-linked UK listing — check import/delivery to IE"
        : "Often stronger stock than .ie — watch delivery & VAT",
    },
    {
      region: "UK",
      retailer: "Scan",
      kind: "shop",
      step: 3,
      label: "Scan Computers",
      url: `https://www.scan.co.uk/search?q=${enc(modelQ + " " + gpu)}`,
      note: "UK specialist — ships to IE sometimes; check delivery",
    },
    {
      region: "UK",
      retailer: "Currys UK",
      kind: "shop",
      step: 3,
      label: "Currys.co.uk",
      url: `https://www.currys.co.uk/search?q=${enc(modelQ)}`,
      note: "UK Currys — compare with Currys.ie stock",
    },

    // ── 3) Extra EU (optional depth) ───────────────────────────
    {
      region: "EU",
      retailer: "Amazon.de",
      kind: "shop",
      step: 4,
      label: asinDe ? "Amazon.de · ASIN" : "Amazon.de",
      url: asinDe
        ? `https://www.amazon.de/dp/${asinDe}`
        : `https://www.amazon.de/s?k=${enc(fullQ)}`,
      note: "DE stock — warranty/returns more awkward for IE use",
    },
    {
      region: "EU",
      retailer: "Alternate",
      kind: "shop",
      step: 4,
      label: "Alternate",
      url: `https://www.alternate.de/listing.xhtml?q=${enc(fullQ)}`,
      note: "DE/NL — often on Geizhals already",
    },
  ];

  if (official[brandKey]) {
    links.push({
      region: "Official",
      retailer: brandKey,
      kind: "official",
      step: 4,
      label: "Brand store",
      url: official[brandKey],
      note: "CTO / list prices — often above street; use for configs & student codes",
    });
  }

  return links;
}

module.exports = {
  cleanQuery,
  buildBuyLinks,
  BUY_GUIDE_IE,
};
