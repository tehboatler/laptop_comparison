#!/usr/bin/env node
const g = require("./lib/recon_guard");
let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("ok:", msg);
  }
}

// Pin: 5060 must not become 5070 on refresh
const { product, warnings } = g.pinProductToExisting(
  {
    model: "Legion 5i",
    gpu: "RTX 5070",
    cpu: "Ultra 9 275HX",
    ram: "32GB",
    storage: "2TB",
    price_gbp: 1299,
  },
  {
    model: 'Lenovo Legion 5i Gen 10 (15" Intel)',
    gpu: "RTX 5060",
    cpu: "Intel Core i7-14700HX",
    ram: "32GB",
    storage: "1TB",
    price_gbp: 1279,
    price_eur: 1459,
  },
  "Lenovo Legion 5i Gen 10"
);
assert(/5060/.test(product.gpu), "pinned GPU stays 5060, got " + product.gpu);
assert(/14700/i.test(product.cpu), "pinned CPU stays 14700HX, got " + product.cpu);
assert(warnings.length >= 1, "emits pin warnings");

// Filter wrong GPU / series
const pin = {
  gpu: "RTX 5060",
  cpu: "Intel Core i7-14700HX",
  model: "Legion 5i Gen 10 15",
  price_gbp: 1279,
  price_eur: 1459,
};
const listings = [
  {
    url: "https://www.amazon.co.uk/dp/B0TESTTEST01",
    title: "Legion 5i RTX 5060 32GB",
    price: 1279,
    currency: "GBP",
  },
  {
    url: "https://www.houseofcomputers.co.uk/item",
    title: "WUXGA OLED i7-13650HX",
    price: 1299.98,
    currency: "GBP",
  },
  {
    url: "https://www.lenovo.com/gb/en/p/legion-pro-5i",
    title: "Legion Pro 5i Gen 10 16",
    price: 2000,
    currency: "GBP",
  },
];
const { kept, dropped } = g.filterListingsForConfig(listings, pin);
assert(
  kept.some((k) => /5060/.test(k.title)),
  "keeps matching 5060 listing"
);
assert(
  dropped.some((d) => d.reason && /(gpu|cpu)_mismatch/.test(d.reason)),
  "drops config-mismatched listing: " + JSON.stringify(dropped)
);
assert(
  dropped.some((d) => /pro|series|size/i.test(d.reason) || d.reason.includes("pro")),
  "drops Pro / wrong series when applicable: " + JSON.stringify(dropped)
);

// Mark hard retail flags for price resolve
const hardKept = kept.map((k) => ({
  ...k,
  hard_retail: g.isHardRetailUrl(k.url) || /houseofcomputers/i.test(k.url),
  soft_brand: g.isSoftBrandUrl(k.url),
}));
// Force amazon as hard for test (normalizeAsin may reject B0TEST)
hardKept.forEach((k) => {
  if (/amazon\.co\.uk\/dp/i.test(k.url)) k.hard_retail = true;
});

const pr = g.resolveStreetPrices(
  { price_gbp: 2920, price_eur: 1459, price_note: "Lenovo list" },
  pin,
  hardKept
);
assert(pr.price_gbp !== 2920, "rejects CTO list 2920 as street, got " + pr.price_gbp);
assert(
  pr.price_gbp === 1279 || pr.price_gbp === pin.price_gbp,
  "street near catalog/matching listing, got " + pr.price_gbp
);

const tgp = g.normalizeTgp("up to 140W; measured 115W", { gpu: "RTX 5070" });
assert(tgp.tgp_watts === 115, "TGP prefers 115 over up-to-140, got " + tgp.tgp_watts);

const relHighBlocked = g.reliabilityScore(
  {
    asin_uk: "",
    price_gbp: 1279,
    price_confidence: "low",
    confidence: "high",
    ids_confidence: "high",
    play: { games: [{}, {}, {}] },
    gpu_tgp_w: "115W",
  },
  {
    passes: 3,
    matchingListings: [],
    pinWarnings: warnings,
  }
);
assert(relHighBlocked.label !== "high", "no high without hard retail, got " + relHighBlocked.label);
assert(relHighBlocked.score <= 58, "score capped without hard evidence, got " + relHighBlocked.score);

const relWithAsin = g.reliabilityScore(
  {
    asin_uk: "B0ABCDEF12",
    price_gbp: 1279,
    price_confidence: "high",
    confidence: "medium",
    ids_confidence: "high",
    play: { games: [{}, {}, {}] },
    gpu_tgp_w: "115W",
    image_url: "https://example.com/a.jpg",
  },
  {
    passes: 3,
    matchingListings: [
      {
        url: "https://www.amazon.co.uk/dp/B0ABCDEF12",
        hard_retail: true,
        price: 1279,
      },
      {
        url: "https://www.scan.co.uk/products/x",
        hard_retail: true,
        price: 1299,
      },
    ],
    pinWarnings: [],
  }
);
assert(
  relWithAsin.label === "high" || relWithAsin.score >= 70,
  "strong evidence can score high: " + JSON.stringify(relWithAsin)
);

assert(
  g.stripBareFootnotes("About 5 hours of use.[13][18][11]") === "About 5 hours of use.",
  "strips bare footnotes"
);

// Multi-SKU family
const vague = g.queryConfigCompleteness("Legion 5i Gen 10 15 Intel");
assert(vague.block === true, "bare Legion family blocks without GPU");
const okQ = g.queryConfigCompleteness(
  "Legion 5i Gen 10 15 UK RTX 5060 16GB i7-13650HX"
);
assert(okQ.block === false && okQ.parsed.gpu_n === "5060", "full SKU query allowed");

const fpA = g.configFingerprint({
  gpu: "RTX 5060",
  cpu: "i7-13650HX",
  ram: "16GB",
  storage: "1TB",
});
const fpB = g.configFingerprint({
  gpu: "RTX 5070",
  cpu: "Ultra 9 275HX",
  ram: "32GB",
});
assert(fpA.gpu_n === "5060" && fpB.gpu_n === "5070", "fingerprints capture GPU");
assert(!g.configsCompatible(fpA, fpB), "5060 vs 5070 not compatible");
assert(
  g.configsCompatible(fpA, g.configFingerprint({ gpu: "RTX 5060", ram: "16GB", cpu: "i7-13650HX" })),
  "same config compatible"
);

const named = g.formatConfigModelName("Legion 5i Gen 10 (15\" Intel)", fpA);
assert(/5060/.test(named) && /16GB/i.test(named), "model name includes config: " + named);

const decide = g.decideReconRowAction({
  preferId: "",
  existingRow: {
    model: "Legion 5i Gen 10",
    gpu: "RTX 5060",
    cpu: "i7-13650HX",
    ram: "16GB",
  },
  researchProduct: {
    model: "Legion 5i Gen 10",
    gpu: "RTX 5070",
    cpu: "Ultra 9 275HX",
    ram: "32GB",
  },
});
assert(decide.action === "add", "different config → add new row, got " + decide.action);

const decideUp = g.decideReconRowAction({
  preferId: "row1",
  existingRow: {
    model: "Legion 5i",
    gpu: "RTX 5060",
    cpu: "i7-13650HX",
    ram: "16GB",
  },
  researchProduct: { gpu: "RTX 5070" },
});
assert(decideUp.action === "upgrade", "explicit preferId upgrades (pin path)");

if (failed) {
  console.error("\n" + failed + " failure(s)");
  process.exit(1);
}
console.log("\nall recon_guard tests passed");
