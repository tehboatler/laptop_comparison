/**
 * Rebuild live stock-check buy links for every laptop (no site scraping).
 * Safe, ToS-friendly: generates search/compare URLs only.
 */
const fs = require("fs");
const path = require("path");
const dataPath = path.join(__dirname, "..", "data.json");
const d = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const sheet = d.sheets.find((s) => String(s.name || "").toLowerCase().includes("laptop"));

function cleanQuery(model, gpuShort) {
  let m = String(model || "")
    .replace(/\([^)]*\)/g, " ")
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

function buildBuyLinks(model, brand, gpuModel, gpuId) {
  const gpuShort =
    gpuModel ||
    (gpuId ? String(gpuId).replace(/^rtx/i, "RTX ").replace(/^rx/i, "RX ") : "");
  const { modelQ, fullQ, gpu } = cleanQuery(model, gpuShort);
  const enc = (s) => encodeURIComponent(s);
  const brandKey = String(brand || "").toLowerCase();

  const official = {
    asus: `https://www.asus.com/uk/searchresult?searchType=products&searchKey=${enc(modelQ)}`,
    msi: `https://www.msi.com/search/?q=${enc(modelQ)}`,
    lenovo: `https://www.lenovo.com/gb/en/search?text=${enc(modelQ + " " + gpu)}`,
    acer: `https://www.acer.com/gb-en/search?q=${enc(modelQ)}`,
    hp: `https://www.hp.com/gb-en/search.html?q=${enc(modelQ + " " + gpu)}`,
    dell: `https://www.dell.com/en-uk/search/${enc(modelQ)}`,
    razer: `https://www.razer.com/search/${enc(modelQ)}`,
    apple: "https://www.apple.com/uk/shop/buy-mac/macbook-pro",
    gigabyte: `https://www.gigabyte.com/Search?Keyword=${enc(modelQ)}`,
    framework: "https://frame.work/gb/en/laptop16",
  };

  const links = [
    {
      region: "EU",
      retailer: "Geizhals",
      kind: "compare",
      label: "Geizhals · live EU stock",
      url: `https://geizhals.eu/?fs=${enc(fullQ)}&hloc=at&hloc=de&hloc=eu`,
      note: "Best live price + stock map for DE/AT/EU",
    },
    {
      region: "EU",
      retailer: "Idealo DE",
      kind: "compare",
      label: "Idealo.de · compare",
      url: `https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q=${enc(fullQ)}`,
      note: "DE comparison — MediaMarkt/Saturn often appear",
    },
    {
      region: "UK",
      retailer: "Idealo UK",
      kind: "compare",
      label: "Idealo.co.uk · live UK",
      url: `https://www.idealo.co.uk/presisearch?q=${enc(fullQ)}`,
      note: "UK price comparison across shops",
    },
    {
      region: "UK",
      retailer: "Google Shopping UK",
      kind: "compare",
      label: "Google Shopping UK",
      url: `https://www.google.co.uk/search?tbm=shop&q=${enc(fullQ)}`,
      note: "Fast scan of UK listings + stock",
    },
    {
      region: "EU",
      retailer: "Amazon.de",
      kind: "shop",
      label: "Amazon.de",
      url: `https://www.amazon.de/s?k=${enc(fullQ)}`,
      note: "Check seller is Amazon or high-rated",
    },
    {
      region: "UK",
      retailer: "Amazon.co.uk",
      kind: "shop",
      label: "Amazon.co.uk",
      url: `https://www.amazon.co.uk/s?k=${enc(fullQ)}`,
      note: "Prime returns; avoid random marketplace 3P",
    },
    {
      region: "UK",
      retailer: "Scan",
      kind: "shop",
      label: "Scan Computers",
      url: `https://www.scan.co.uk/search?q=${enc(modelQ + " " + gpu)}`,
      note: "UK specialist gaming stock",
    },
    {
      region: "UK",
      retailer: "Currys",
      kind: "shop",
      label: "Currys",
      url: `https://www.currys.co.uk/search?q=${enc(modelQ)}`,
      note: "High-street + price match",
    },
    {
      region: "EU",
      retailer: "Alternate",
      kind: "shop",
      label: "Alternate",
      url: `https://www.alternate.de/listing.xhtml?q=${enc(fullQ)}`,
      note: "DE/NL warranty path",
    },
    {
      region: "EU",
      retailer: "Mindfactory",
      kind: "shop",
      label: "Mindfactory",
      url: `https://www.mindfactory.de/search_result.php?search_query=${enc(fullQ)}`,
      note: "DE deals — watch stock counters",
    },
    {
      region: "EU",
      retailer: "Coolblue",
      kind: "shop",
      label: "Coolblue",
      url: `https://www.coolblue.nl/en/search?query=${enc(modelQ)}`,
      note: "NL/BE/DE service-focused",
    },
    {
      region: "EU",
      retailer: "LDLC",
      kind: "shop",
      label: "LDLC",
      url: `https://www.ldlc.com/recherche/${enc(modelQ)}/`,
      note: "FR + nearby EU",
    },
    {
      region: "EU",
      retailer: "PCComponentes",
      kind: "shop",
      label: "PCComponentes",
      url: `https://www.pccomponentes.com/buscar/?query=${enc(modelQ)}`,
      note: "ES competitive pricing",
    },
  ];

  if (official[brandKey]) {
    links.unshift({
      region: "Official",
      retailer: brandKey,
      kind: "official",
      label: "Brand store search",
      url: official[brandKey],
      note: "Configurators · student codes · BTO stock",
    });
  }
  return links;
}

let n = 0;
for (const row of sheet.rows) {
  const c = row.cells;
  const det = c.col_detail || {};
  det.buy_links = buildBuyLinks(
    c.col_model,
    c.col_brand || det.brand,
    det.graphics?.model,
    c.col_gpu
  );
  det.buy_guide =
    "Live stock: Geizhals (EU) or Idealo/Google Shopping (UK) first, then a VAT-local shop. Avoid grey import if you need easy warranty.";
  c.col_detail = det;
  n++;
}

fs.writeFileSync(dataPath, JSON.stringify(d, null, 2) + "\n");
console.log("Refreshed buy links for", n, "laptops");
