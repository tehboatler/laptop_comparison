#!/usr/bin/env node
/**
 * Local deep-recon agent for the static finder page.
 *
 *   npm run recon:server
 *   → http://127.0.0.1:8787
 *
 * POST /recon { query, existing?, depth?: "deep"|"quick" }
 *
 * Hardening:
 *   - Pin GPU/CPU/RAM/storage to catalog row (no silent CTO upgrades)
 *   - Street prices only from config-matching hard retail listings
 *   - Reliability "high" requires ASIN/EAN or hard retail evidence
 *   - Single TGP class value (not marketing "up to 140W")
 *   - Harvest search_results for sources, ASINs, images
 */
const http = require("http");
const path = require("path");
const { loadDotEnv } = require("./lib/catalog_utils");
const { sonarChat, hasSonarKey } = require("./lib/sonar");
const {
  pickRetailIds,
  normalizeAsin,
  normalizeEan,
  asinFromUrl,
} = require("./lib/sku_ids");
const guard = require("./lib/recon_guard");
const {
  resolveProductImages,
  isProductImageUrl,
} = require("./lib/recon_images");

loadDotEnv(path.join(__dirname, "..", ".env"));
const ROOT = path.join(__dirname, "..");

const PORT = parseInt(process.env.RECON_PORT || "8787", 10);
const HOST = process.env.RECON_HOST || "127.0.0.1";

const {
  stripBareFootnotes,
  isHttpUrl,
  isGenericSearchUrl,
  isSoftBrandUrl,
  isHardRetailUrl,
  isUsefulShopUrl,
  filterListingsForConfig,
  resolveStreetPrices,
  pinProductToExisting,
  normalizeTgp,
  reliabilityScore,
  formatPinnedConfigBlock,
  buildPinnedConfig,
  textMatchesConfig,
  configFingerprint,
  formatConfigModelName,
  queryConfigCompleteness,
} = guard;

const SYS_LISTING = `You are an EU/UK laptop retail researcher. Return ONLY JSON (no markdown).
Never invent ASINs, EANs, prices, or product image URLs.
ASIN only if you found a real amazon.co.uk or amazon.de /dp/B0… product page.

CRITICAL CONFIG RULES:
- If a PINNED CATALOG CONFIG is provided, return that exact CPU · GPU · RAM · storage (do not "upgrade" to a higher CTO).
- Reject Legion Pro when the pin is Legion 5 non-Pro; reject 16" when pin is 15".
- Reject listings whose title shows a different RTX number than the pin.
- price_gbp / price_eur = street prices from matching retail product pages only.
- Never use Lenovo UK CTO/list price (~2× street) as street price; if only CTO exists, set price_confidence "low" and explain.
- image_url must be a direct https image URL when available.

{
  "model": string,
  "brand": string,
  "gpu": string,
  "cpu": string,
  "ram": string,
  "storage": string,
  "display": string,
  "weight_kg": number|null,
  "config_one_liner": string,
  "asin_uk": string|null,
  "asin_de": string|null,
  "ean": string|null,
  "mpn": string|null,
  "amazon_uk_url": string|null,
  "amazon_de_url": string|null,
  "geizhals_url": string|null,
  "idealo_url": string|null,
  "listings": [
    {
      "retailer": string,
      "region": "UK"|"DE"|"EU",
      "url": string,
      "price": number|null,
      "currency": "GBP"|"EUR"|null,
      "in_stock_hint": string|null,
      "title": string|null
    }
  ],
  "price_gbp": number|null,
  "price_eur": number|null,
  "price_note": string|null,
  "image_url": string|null,
  "image_urls": string[],
  "availability": "retail"|"limited"|"clearance"|"aftermarket",
  "confidence": "high"|"medium"|"low",
  "price_confidence": "high"|"medium"|"low",
  "ids_confidence": "high"|"medium"|"low",
  "sources_note": string
}`;

const SYS_REALWORLD = `You research real-world laptop behaviour from reviews (Notebookcheck, RTINGS, Laptop Mag, manufacturer PSREF).
Return ONLY JSON. Prefer numbers grounded in published reviews of the SAME chassis + GPU TGP class as the pinned config.
If unknown, null — do not invent lab numbers. No bare footnote markers like [13].

{
  "battery_wh": number|null,
  "estimated_web_h": string|null,
  "estimated_game_h": string|null,
  "battery_note": string|null,
  "gpu_tgp_w": string|null,
  "tgp_note": string|null,
  "dual_channel": boolean|null,
  "dual_channel_note": string|null,
  "chassis_grade": "plastic"|"hybrid"|"metal"|"premium"|null,
  "chassis_material": string|null,
  "chassis_confidence": "high"|"medium"|"low",
  "thermals": {
    "load_scenario": string|null,
    "gpu_temp_c": string|null,
    "cpu_temp_c": string|null,
    "keyboard_c": string|null,
    "bottom_c": string|null,
    "idle_dba": string|null,
    "load_dba": string|null,
    "fan_behavior": string|null,
    "throttle_risk": string|null,
    "tips": string|null,
    "source_hint": string|null
  },
  "confidence": "high"|"medium"|"low",
  "sources_note": string
}

gpu_tgp_w: single primary wattage for THIS chassis (e.g. "115W"), NOT "up to 140W".
If reviews disagree, pick the measured/typical class figure and explain in tgp_note.
chassis_grade must be plastic|hybrid|metal|premium or null.
chassis_material: short phrase only.`;

const SYS_PLAY = `You estimate 1080p gaming for a specific laptop GPU + TGP class from published reviews.
Return ONLY JSON. FPS must match the stated TGP (e.g. 115W class) — not desktop GPUs, not marketing max TGP.
Name the review source in each game note. Never use bare [3] footnotes.

{
  "preset": string,
  "bound": string,
  "assumes": string,
  "note": string,
  "games": [
    {
      "name": string,
      "settings": string,
      "fps": number|null,
      "note": string|null,
      "source_hint": string|null
    }
  ],
  "youtube_search_query": string,
  "youtube_reviews": [
    {
      "title": string,
      "channel": string|null,
      "watch_url": string|null,
      "id": string|null,
      "match": "exact"|"series"
    }
  ],
  "notes": string,
  "confidence": "high"|"medium"|"low",
  "sources_note": string
}

bound and assumes MUST mention the single TGP used (e.g. "115W class estimates").`;

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function send(res, code, obj) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function isProbablyImageUrl(u) {
  return isProductImageUrl(u);
}

function retailerFromUrl(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (h.includes("amazon.co.uk")) return "Amazon.co.uk";
    if (h.includes("amazon.de")) return "Amazon.de";
    if (h.includes("scan.co")) return "Scan";
    if (h.includes("currys")) return "Currys";
    if (h.includes("box.co")) return "Box";
    if (h.includes("very.co")) return "Very";
    if (h.includes("ao.com")) return "AO";
    if (h.includes("lenovo.com")) return "Lenovo";
    if (h.includes("geizhals")) return "Geizhals";
    if (h.includes("idealo")) return "Idealo";
    if (h.includes("notebookcheck")) return "Notebookcheck";
    if (h.includes("pricespy") || h.includes("prisjakt")) return "PriceSpy";
    if (h.includes("youtube")) return "YouTube";
    if (h.includes("houseofcomputers")) return "House of Computers";
    return h.split(".")[0] || "Source";
  } catch {
    return "Source";
  }
}

function regionFromUrl(url) {
  const s = String(url || "").toLowerCase();
  if (/\.de\/|amazon\.de|idealo\.de|geizhals|mediamarkt|alternate|notebooksbilliger/i.test(s))
    return "DE";
  if (/\.co\.uk|amazon\.co\.uk|currys|scan\.co|box\.co|very\.co|ao\.com|johnlewis/i.test(s))
    return "UK";
  return "EU";
}

function amazonImageFromAsin(asin, market = "GB") {
  const a = normalizeAsin(asin);
  if (!a) return "";
  return `https://ws-eu.amazon-adsystem.com/widgets/q?_encoding=UTF8&MarketPlace=${market}&ASIN=${a}&ServiceVersion=20070822&ID=AsinImage&WS=1&Format=_SL500_`;
}

function normalizeChassisGrade(g) {
  const s = String(g || "").toLowerCase().trim();
  if (!s || s === "null" || s === "unknown") return null;
  if (["plastic", "hybrid", "metal", "premium"].includes(s)) return s;
  if (/not\s+(explicitly\s+)?confirm|unconfirm|unknown|n\/a/.test(s)) return null;
  if (/premium|cnc|unibody/.test(s)) return "premium";
  if (/hybrid|metal\s*lid|plastic\s*base|aluminium\s*lid|aluminum\s*lid/.test(s))
    return "hybrid";
  if (/\bmetal\b|aluminium|aluminum|magnesium|alloy/.test(s) && !/plastic/.test(s))
    return "metal";
  if (/plastic|abs|polycarbonate|all-plastic/.test(s)) return "plastic";
  return null;
}

function normalizeChassisMaterial(m, grade) {
  let s = String(m || "").trim();
  if (!s) return grade ? null : null;
  if (s.length > 80 || /not explicitly confirmed|sources for this/i.test(s)) {
    if (grade === "plastic") return "Plastic chassis (class estimate)";
    if (grade === "hybrid") return "Metal lid / plastic base (class estimate)";
    if (grade === "metal") return "Metal chassis (class estimate)";
    if (grade === "premium") return "Premium metal chassis (class estimate)";
    return null;
  }
  return s;
}

function buildSources(searchResults, citationUrls) {
  const byUrl = new Map();
  const add = (entry) => {
    const url = String(entry.url || "").trim();
    if (!isHttpUrl(url)) return;
    const key = url.replace(/[?#].*$/, "");
    const prev = byUrl.get(key);
    if (prev) {
      if (!prev.title && entry.title) prev.title = entry.title;
      if (!prev.date && entry.date) prev.date = entry.date;
      if (!prev.last_updated && entry.last_updated)
        prev.last_updated = entry.last_updated;
      if (!prev.snippet && entry.snippet) prev.snippet = entry.snippet;
      return;
    }
    byUrl.set(key, {
      url,
      title: entry.title || retailerFromUrl(url),
      date: entry.date || null,
      last_updated: entry.last_updated || null,
      snippet: entry.snippet || null,
      kind: entry.kind || "web",
      soft_brand: isSoftBrandUrl(url),
      hard_retail: isHardRetailUrl(url),
    });
  };

  for (const r of searchResults || []) {
    if (!r) continue;
    add({
      url: r.url,
      title: r.title,
      date: r.date,
      last_updated: r.last_updated,
      snippet: r.snippet,
      kind: r.source || "web",
    });
  }
  for (const u of citationUrls || []) add({ url: u, title: retailerFromUrl(u) });

  const list = [...byUrl.values()];
  list.sort((a, b) => {
    const score = (x) => {
      let s = 0;
      if (x.hard_retail) s += 6;
      if (/notebookcheck|rtings|laptopmag|tomshardware|jarrod/i.test(x.url)) s += 5;
      if (/youtube\.com\/watch/i.test(x.url)) s += 2;
      if (x.date || x.last_updated) s += 1;
      if (x.soft_brand) s -= 1;
      if (isGenericSearchUrl(x.url)) s -= 4;
      return s;
    };
    return score(b) - score(a);
  });

  return list.slice(0, 24).map((s, i) => ({ ...s, n: i + 1 }));
}

function harvestFromSearch(searchResults, citationUrls, pin) {
  const listings = [];
  const images = [];
  let asin_uk = "";
  let asin_de = "";
  let amazon_uk_url = "";
  let amazon_de_url = "";
  const seenUrl = new Set();

  const consider = (url, title) => {
    if (!isHttpUrl(url)) return;
    const clean = url.trim();
    const blob = `${title || ""} ${clean}`;
    if (pin && !textMatchesConfig(blob, pin).ok) return;

    const asin = asinFromUrl(clean);
    if (asin) {
      if (/amazon\.co\.uk/i.test(clean) && !asin_uk) {
        asin_uk = asin;
        amazon_uk_url = `https://www.amazon.co.uk/dp/${asin}`;
      } else if (/amazon\.de/i.test(clean) && !asin_de) {
        asin_de = asin;
        amazon_de_url = `https://www.amazon.de/dp/${asin}`;
      } else if (!asin_uk && /amazon\./i.test(clean)) {
        asin_uk = asin;
        amazon_uk_url = `https://www.amazon.co.uk/dp/${asin}`;
      }
      const img = amazonImageFromAsin(asin, /amazon\.de/i.test(clean) ? "DE" : "GB");
      if (img && !images.includes(img)) images.push(img);
    }
    if (isProbablyImageUrl(clean) && !images.includes(clean)) images.push(clean);
    if (isUsefulShopUrl(clean) && !seenUrl.has(clean) && !isGenericSearchUrl(clean)) {
      seenUrl.add(clean);
      listings.push({
        retailer: retailerFromUrl(clean),
        region: regionFromUrl(clean),
        url: clean,
        price: null,
        currency: null,
        in_stock_hint: null,
        title: title || null,
        from_search: true,
      });
    }
  };

  for (const r of searchResults || []) {
    if (r?.url) consider(r.url, r.title);
  }
  for (const u of citationUrls || []) consider(u, null);

  return { listings, images, asin_uk, asin_de, amazon_uk_url, amazon_de_url };
}

async function passListings(query, pin) {
  const pinBlock = formatPinnedConfigBlock(pin);
  const prompt = `DEEP RECON PASS 1/3 — Listings, IDs, prices, product images (UK/EU).

User request: ${query}

${pinBlock}

Tasks:
1) Stay on the pinned CPU · GPU · RAM · storage (if pin present). Do not return a higher CTO.
2) Find real Amazon UK/DE /dp/ASIN pages and Scan/Currys/Box/Very/AO/Alternate product pages for THAT config.
3) listings[].title must include enough to verify GPU/CPU when possible.
4) price_gbp / price_eur from matching street listings only — not Lenovo CTO list.
5) image_url = direct product photo https when available.
6) price_confidence high only with live matching listing price; ids_confidence high only with real ASIN/EAN.

Return JSON. Never invent ASIN/EAN/image URLs.`;

  const { parsed, citations, search_results, model } = await sonarChat({
    prompt,
    system: SYS_LISTING,
    json: true,
  });
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Pass 1 (listings): no JSON");
  }
  return { parsed, citations, search_results, model };
}

async function passRealWorld(query, listing, pin) {
  const prompt = `DEEP RECON PASS 2/3 — Battery, thermals, TGP, dual-channel, chassis.

PINNED / target config:
Model: ${listing.model || pin.model || query}
GPU: ${listing.gpu || pin.gpu || "?"} · CPU: ${listing.cpu || pin.cpu || "?"}
RAM: ${listing.ram || pin.ram || "?"} · Storage: ${listing.storage || pin.storage || "?"}
Config: ${listing.config_one_liner || pin.config_one_liner || "?"}
ASIN UK: ${listing.asin_uk || pin.asin_uk || "unknown"}

From Notebookcheck / reviews for THIS chassis + GPU class:
- battery_wh, estimated_web_h, estimated_game_h (no [n] footnotes in notes)
- gpu_tgp_w = SINGLE primary wattage for this chassis (e.g. "115W"). Do NOT write "up to 140W" as the value.
- If reviews say 115W measured and chip max 140W, set gpu_tgp_w "115W" and explain in tgp_note.
- thermals: temps/dBA when published for same series/TGP; else nulls + tips
- chassis_grade plastic|hybrid|metal|premium or null; material short phrase

Return JSON.`;

  const { parsed, citations, search_results, model } = await sonarChat({
    prompt,
    system: SYS_REALWORLD,
    json: true,
  });
  return {
    parsed: parsed && typeof parsed === "object" ? parsed : {},
    citations,
    search_results,
    model,
  };
}

async function passPlay(query, listing, real, tgp) {
  const tgpLabel = tgp.gpu_tgp_w || real.gpu_tgp_w || listing.gpu_tgp_w || "unknown";
  const prompt = `DEEP RECON PASS 3/3 — Can it play? + review videos.

Model: ${listing.model || query}
GPU: ${listing.gpu || "?"} · TGP TO USE FOR ALL ESTIMATES: ${tgpLabel}
CPU: ${listing.cpu || "?"} · RAM: ${listing.ram || "?"}
Config: ${listing.config_one_liner || "?"}
${tgp.tgp_note ? `TGP note: ${tgp.tgp_note}` : ""}

Rules:
1) All FPS estimates must assume ${tgpLabel} — do not scale up to a higher marketing TGP.
2) bound/assumes must state ${tgpLabel} explicitly.
3) 4–7 games @ 1080p; name review source in each note (no bare [3] footnotes).
4) youtube_search_query + up to 3 real watch URLs if known.
5) honest shopper notes.

Return JSON.`;

  const { parsed, citations, search_results, model } = await sonarChat({
    prompt,
    system: SYS_PLAY,
    json: true,
  });
  return {
    parsed: parsed && typeof parsed === "object" ? parsed : {},
    citations,
    search_results,
    model,
  };
}

function mergeListings(...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const l of group || []) {
      if (!l?.url || !isHttpUrl(l.url)) continue;
      if (isGenericSearchUrl(l.url)) continue;
      const key = String(l.url).replace(/[?#].*$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        retailer: l.retailer || retailerFromUrl(l.url),
        region: l.region || regionFromUrl(l.url),
        url: l.url,
        price: l.price != null && !isNaN(Number(l.price)) ? Number(l.price) : null,
        currency: l.currency || null,
        in_stock_hint: l.in_stock_hint || null,
        title: l.title || null,
      });
    }
  }
  out.sort((a, b) => {
    const rank = (x) => {
      let s = 0;
      if (isHardRetailUrl(x.url)) s += 8;
      else if (isSoftBrandUrl(x.url)) s += 2;
      else if (isUsefulShopUrl(x.url)) s += 4;
      if (x.price != null) s += 2;
      return s;
    };
    return rank(b) - rank(a);
  });
  return out.slice(0, 12);
}

function mergeImages(...groups) {
  const out = [];
  for (const group of groups) {
    for (const u of group || []) {
      if (!u) continue;
      const s = String(u).trim();
      if (!isHttpUrl(s)) continue;
      if (!isProbablyImageUrl(s) && !/AsinImage|amazon-adsystem|media-amazon/i.test(s))
        continue;
      if (!out.includes(s)) out.push(s);
    }
  }
  return out.slice(0, 8);
}

function mergeDeep(listing, real, play, harvest, sources, pin, extraWarnings = []) {
  const warnings = [...extraWarnings];
  const ids = pickRetailIds({
    ...listing,
    asin_uk: listing.asin_uk || harvest.asin_uk || pin.asin_uk,
    asin_de: listing.asin_de || harvest.asin_de || pin.asin_de,
    amazon_uk_url: listing.amazon_uk_url || harvest.amazon_uk_url,
    amazon_de_url: listing.amazon_de_url || harvest.amazon_de_url,
    ean: listing.ean || pin.ean,
    mpn: listing.mpn || pin.mpn,
  });

  let listings = mergeListings(
    Array.isArray(listing.listings) ? listing.listings : [],
    harvest.listings
  );

  if (ids.amazon_uk_url) {
    listings.unshift({
      retailer: "Amazon.co.uk",
      region: "UK",
      url: ids.amazon_uk_url,
      price: null,
      currency: "GBP",
      title: listing.model || pin.model || null,
    });
  }
  if (ids.amazon_de_url) {
    listings.unshift({
      retailer: "Amazon.de",
      region: "DE",
      url: ids.amazon_de_url,
      price: null,
      currency: "EUR",
      title: listing.model || pin.model || null,
    });
  }
  listings = mergeListings(listings);

  // Config filter — drop Pro/wrong GPU/search noise
  const { kept: matchingListings, dropped } = filterListingsForConfig(listings, {
    ...pin,
    model: listing.model || pin.model,
    gpu: listing.gpu || pin.gpu,
    cpu: listing.cpu || pin.cpu,
  });
  if (dropped.length) {
    warnings.push(
      `Dropped ${dropped.length} non-matching listing(s) (wrong series/GPU/search)`
    );
  }

  const priceRes = resolveStreetPrices(
    {
      price_gbp: listing.price_gbp,
      price_eur: listing.price_eur,
      price_note: listing.price_note,
    },
    pin,
    matchingListings
  );
  warnings.push(...(priceRes.warnings || []));

  const image_urls = mergeImages(
    listing.image_url ? [listing.image_url] : [],
    listing.image_urls,
    harvest.images,
    ids.asin_uk ? [amazonImageFromAsin(ids.asin_uk, "GB")] : [],
    ids.asin_de ? [amazonImageFromAsin(ids.asin_de, "DE")] : []
  );

  const tgp = normalizeTgp(real.gpu_tgp_w || listing.gpu_tgp_w, {
    gpu: listing.gpu || pin.gpu,
    sourcesNote: real.tgp_note || real.sources_note,
  });

  const games = Array.isArray(play.games)
    ? play.games
        .filter((g) => g && g.name)
        .slice(0, 8)
        .map((g) => {
          let note = stripBareFootnotes(g.note || "");
          if (g.source_hint && note && !note.includes(g.source_hint)) {
            note = `${note} (${stripBareFootnotes(g.source_hint)})`;
          } else if (g.source_hint && !note) {
            note = stripBareFootnotes(g.source_hint);
          }
          let source_url = g.source_url || null;
          let source_title = g.source_title || null;
          if (!source_url) {
            const rev = (sources || []).find((s) =>
              /notebookcheck|rtings|laptopmag|tomshardware|youtube\.com\/watch/i.test(
                s.url
              )
            );
            if (rev) {
              source_url = rev.url;
              source_title = rev.title || null;
            }
          }
          return {
            name: g.name,
            settings: g.settings || "1080p class",
            fps: g.fps != null && !isNaN(Number(g.fps)) ? Number(g.fps) : null,
            note,
            source_url,
            source_title,
          };
        })
    : [];

  const yt = Array.isArray(play.youtube_reviews)
    ? play.youtube_reviews
        .filter((v) => v && (v.watch_url || v.id || v.title))
        .slice(0, 4)
        .map((v) => {
          let id = v.id || null;
          if (!id && v.watch_url) {
            const m = String(v.watch_url).match(
              /(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{6,})/
            );
            if (m) id = m[1];
          }
          return {
            title: v.title || "Review",
            channel: v.channel || null,
            watch_url:
              v.watch_url ||
              (id ? `https://www.youtube.com/watch?v=${id}` : null),
            id,
            match: v.match === "exact" ? "exact" : "series",
          };
        })
    : [];

  if (!yt.length) {
    for (const s of sources || []) {
      const m = String(s.url || "").match(
        /(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/
      );
      if (m) {
        yt.push({
          title: s.title || "Review video",
          channel: null,
          watch_url: s.url,
          id: m[1],
          match: "series",
        });
      }
      if (yt.length >= 3) break;
    }
  }

  const thermRaw = real.thermals || {};
  const thermals = {
    load_scenario: thermRaw.load_scenario || null,
    gpu_temp_c: thermRaw.gpu_temp_c || null,
    cpu_temp_c: thermRaw.cpu_temp_c || null,
    keyboard_c: thermRaw.keyboard_c || null,
    bottom_c: thermRaw.bottom_c || null,
    idle_dba: thermRaw.idle_dba || null,
    load_dba: thermRaw.load_dba || null,
    fan_behavior: stripBareFootnotes(thermRaw.fan_behavior || "") || null,
    throttle_risk: stripBareFootnotes(thermRaw.throttle_risk || "") || null,
    tips:
      stripBareFootnotes(thermRaw.tips || thermRaw.source_hint || "") || null,
  };
  const hasThermalData = [
    thermals.gpu_temp_c,
    thermals.cpu_temp_c,
    thermals.load_dba,
    thermals.idle_dba,
    thermals.keyboard_c,
  ].some((v) => v != null && String(v).trim() !== "");

  const chassis_grade = normalizeChassisGrade(
    real.chassis_grade || listing.chassis_grade
  );
  const chassis_material = normalizeChassisMaterial(
    real.chassis_material || listing.chassis_material,
    chassis_grade
  );

  const tgpLabel = tgp.gpu_tgp_w || "class TGP";
  let bound = stripBareFootnotes(play.bound || "");
  let assumes = stripBareFootnotes(play.assumes || listing.config_one_liner || "");
  // Force single TGP into bound/assumes — kill "up to 140W" drift
  if (tgp.gpu_tgp_w) {
    if (!bound || /up to\s*\d{2,3}\s*w/i.test(bound) || !/\d{2,3}\s*w/i.test(bound)) {
      bound = `${tgpLabel} class estimates for this chassis (not marketing max TGP)`;
    }
    if (!assumes || /up to\s*\d{2,3}\s*w/i.test(assumes)) {
      assumes = [
        listing.config_one_liner || pin.config_one_liner || listing.model,
        `GPU power: ${tgpLabel}${tgp.tgp_confidence === "class_estimate" ? " (class estimate)" : ""}`,
      ]
        .filter(Boolean)
        .join(" · ");
    }
  }
  if (tgp.tgp_note) {
    warnings.push(tgp.tgp_note);
  }

  // Prefer hard retail listings in output; keep a few soft brand pages after
  const hardFirst = [
    ...matchingListings.filter((l) => l.hard_retail),
    ...matchingListings.filter((l) => !l.hard_retail),
  ].slice(0, 10);

  const rawModel = listing.model || pin.model || "";
  const preFp = configFingerprint({
    model: rawModel,
    gpu: listing.gpu || pin.gpu || "",
    cpu: listing.cpu || pin.cpu || "",
    ram: listing.ram || pin.ram || "",
    storage: listing.storage || pin.storage || "",
    config_one_liner: listing.config_one_liner || pin.config_one_liner || "",
  });
  const namedModel = formatConfigModelName(rawModel, preFp);

  const product = {
    model: namedModel,
    brand: listing.brand || pin.brand || "",
    gpu: listing.gpu || pin.gpu || "",
    cpu: listing.cpu || pin.cpu || "",
    ram: listing.ram || pin.ram || "",
    storage: listing.storage || pin.storage || "",
    display: listing.display || pin.display || "",
    weight_kg: listing.weight_kg ?? null,
    battery_wh: real.battery_wh ?? listing.battery_wh ?? null,
    estimated_web_h: real.estimated_web_h || null,
    estimated_game_h: real.estimated_game_h || null,
    battery_note: stripBareFootnotes(real.battery_note || "") || null,
    chassis_grade,
    chassis_material,
    chassis_confidence:
      real.chassis_confidence || (chassis_grade ? "medium" : "low"),
    gpu_tgp_w: tgp.gpu_tgp_w,
    tgp_watts: tgp.tgp_watts,
    tgp_confidence: tgp.tgp_confidence,
    tgp_note: tgp.tgp_note,
    dual_channel: real.dual_channel ?? null,
    dual_channel_note: stripBareFootnotes(real.dual_channel_note || "") || null,
    config_one_liner:
      listing.config_one_liner ||
      [namedModel, listing.cpu || pin.cpu, listing.gpu || pin.gpu, listing.ram || pin.ram, listing.storage || pin.storage]
        .filter(Boolean)
        .join(", "),
    config_fingerprint: preFp.key,
    sku_label: preFp.shortLabel,
    family_model: familyModelBaseSafe(rawModel),
    notes: stripBareFootnotes(
      [play.notes, priceRes.price_note, real.battery_note].filter(Boolean).join(" ")
    ),
    price_gbp: priceRes.price_gbp,
    price_eur: priceRes.price_eur,
    price_note: priceRes.price_note,
    price_source: priceRes.price_source,
    asin_uk: ids.asin_uk || "",
    asin_de: ids.asin_de || "",
    ean: ids.ean || normalizeEan(listing.ean || pin.ean) || "",
    mpn: listing.mpn || pin.mpn || "",
    amazon_uk_url: ids.amazon_uk_url || "",
    amazon_de_url: ids.amazon_de_url || "",
    geizhals_url: listing.geizhals_url || null,
    idealo_url: listing.idealo_url || null,
    listings: hardFirst,
    image_url: image_urls[0] || null,
    image_urls,
    availability: listing.availability || "retail",
    confidence:
      listing.confidence || real.confidence || play.confidence || "medium",
    price_confidence: priceRes.price_confidence,
    ids_confidence:
      ids.asin_uk || ids.asin_de || ids.ean
        ? "high"
        : listing.ids_confidence === "high"
          ? "medium" // demote self-reported high without IDs
          : listing.ids_confidence || "low",
    sources_note: stripBareFootnotes(
      [listing.sources_note, real.sources_note, play.sources_note]
        .filter(Boolean)
        .join(" · ")
    ),
    thermals: hasThermalData
      ? thermals
      : {
          load_scenario: null,
          gpu_temp_c: null,
          cpu_temp_c: null,
          keyboard_c: null,
          bottom_c: null,
          idle_dba: null,
          load_dba: null,
          fan_behavior: null,
          throttle_risk: null,
          tips:
            thermals.tips ||
            "No published load temps/dBA for this exact SKU — check Notebookcheck for the closest same-series same-TGP review.",
        },
    play: {
      preset: stripBareFootnotes(play.preset || "1080p class"),
      bound,
      assumes,
      note: stripBareFootnotes(play.note || ""),
      games,
    },
    youtube_search_query:
      play.youtube_search_query ||
      `${listing.model || pin.model || ""} ${listing.gpu || pin.gpu || ""} review`.trim(),
    youtube_reviews: yt,
    sources,
    warnings,
    matching_listings: hardFirst.length,
    hard_retail_count: hardFirst.filter((l) => l.hard_retail).length,
    dropped_listings: dropped.length,
    pinned_from_existing: !!listing.pinned_from_existing,
    pinned_fields: listing.pinned_fields || [],
  };

  // Recompute fingerprint after all pins
  const finalFp = configFingerprint(product);
  product.config_fingerprint = finalFp.key;
  product.sku_label = finalFp.shortLabel;
  product.model = formatConfigModelName(product.family_model || product.model, finalFp);
  product.config_one_liner =
    [product.model, product.cpu, product.gpu, product.ram, product.storage]
      .filter(Boolean)
      .join(", ");

  return { product, matchingListings: hardFirst, warnings, tgp, fingerprint: finalFp };
}

function familyModelBaseSafe(model) {
  try {
    return guard.familyModelBase(model);
  } catch {
    return String(model || "").trim();
  }
}

async function handleRecon(body) {
  if (!hasSonarKey()) {
    const err = new Error("PERPLEXITY_API_KEY not set in .env");
    err.code = "NO_KEY";
    throw err;
  }
  const query = String(body.query || body.model || "").trim();
  if (!query) throw new Error("query required");

  // Multi-SKU families need at least a GPU in the query (unless refreshing a pinned row)
  const existing = body.existing && typeof body.existing === "object" ? body.existing : {};
  const hasPinConfig = !!(existing.gpu || existing.cpu || existing.ram);
  const completeness = queryConfigCompleteness(query);
  if (completeness.block && !hasPinConfig && !body.allow_ambiguous) {
    const err = new Error(completeness.hint || "Query too vague for multi-SKU family — add GPU.");
    err.code = "AMBIGUOUS_SKU";
    err.completeness = completeness;
    throw err;
  }
  if (completeness.multi_sku_family && completeness.hint) {
    // soft warning only when not blocking
  }

  const depth = String(body.depth || "deep").toLowerCase();
  const deep = depth !== "quick";
  const passes = [];
  const allCitations = [];
  const allSearchResults = [];
  const allWarnings = [];
  if (completeness.multi_sku_family && completeness.missing?.length) {
    allWarnings.push(completeness.hint || "Multi-SKU family — prefer CPU+GPU+RAM in query");
  }

  const pin = buildPinnedConfig(existing, query);

  // Pass 1
  const p1 = await passListings(query, pin);
  passes.push({ name: "listings", model: p1.model });
  allCitations.push(...(p1.citations || []));
  allSearchResults.push(...(p1.search_results || []));

  let listing = p1.parsed;
  // Pin config immediately so later passes research the right SKU
  const pinned = pinProductToExisting(listing, existing, query);
  listing = pinned.product;
  allWarnings.push(...pinned.warnings);

  const ids = pickRetailIds({
    ...listing,
    asin_uk: listing.asin_uk || pin.asin_uk,
    asin_de: listing.asin_de || pin.asin_de,
    ean: listing.ean || pin.ean,
    mpn: listing.mpn || pin.mpn,
  });
  listing = {
    ...listing,
    asin_uk: ids.asin_uk || listing.asin_uk,
    asin_de: ids.asin_de || listing.asin_de,
    amazon_uk_url: ids.amazon_uk_url || listing.amazon_uk_url,
    amazon_de_url: ids.amazon_de_url || listing.amazon_de_url,
    ean: ids.ean || listing.ean,
    mpn: listing.mpn || pin.mpn,
  };

  let real = {};
  let play = {};
  let tgpEarly = normalizeTgp(listing.gpu_tgp_w, { gpu: listing.gpu });

  if (deep) {
    const p2 = await passRealWorld(query, listing, pin);
    passes.push({ name: "battery_thermals", model: p2.model });
    allCitations.push(...(p2.citations || []));
    allSearchResults.push(...(p2.search_results || []));
    real = p2.parsed || {};
    tgpEarly = normalizeTgp(real.gpu_tgp_w || listing.gpu_tgp_w, {
      gpu: listing.gpu,
      sourcesNote: real.tgp_note || real.sources_note,
    });

    const p3 = await passPlay(query, listing, real, tgpEarly);
    passes.push({ name: "can_it_play", model: p3.model });
    allCitations.push(...(p3.citations || []));
    allSearchResults.push(...(p3.search_results || []));
    play = p3.parsed || {};
  }

  const harvest = harvestFromSearch(allSearchResults, allCitations, {
    ...pin,
    model: listing.model,
    gpu: listing.gpu,
    cpu: listing.cpu,
  });
  if (!listing.asin_uk && harvest.asin_uk) {
    listing.asin_uk = harvest.asin_uk;
    listing.amazon_uk_url = harvest.amazon_uk_url;
  }
  if (!listing.asin_de && harvest.asin_de) {
    listing.asin_de = harvest.asin_de;
    listing.amazon_de_url = harvest.amazon_de_url;
  }

  const sources = buildSources(allSearchResults, allCitations);
  const { product, matchingListings, warnings, tgp, fingerprint } = mergeDeep(
    listing,
    real,
    play,
    harvest,
    sources,
    pin,
    allWarnings
  );

  // Images: Sonar often returns none — resolve og:image / ASIN / catalog series
  product.sources = sources;
  try {
    const imgRes = await resolveProductImages(product, {
      rootDir: ROOT,
      maxFetches: 6,
    });
    if (imgRes.images.length) {
      product.image_url = imgRes.images[0];
      product.image_urls = imgRes.images;
      product.image_credit = imgRes.credit;
      product.image_via = imgRes.via;
      if (!imgRes.via.includes("sonar")) {
        warnings.push(
          `Images via ${imgRes.via.join("+")} (${imgRes.images.length} url(s))`
        );
      }
    } else {
      warnings.push(
        "No product image found (no ASIN widget, og:image, or series fallback)"
      );
    }
  } catch (e) {
    warnings.push("Image resolve failed: " + (e.message || e));
  }

  const rel = reliabilityScore(product, {
    passes: passes.length,
    sources,
    matchingListings,
    pinWarnings: warnings,
  });

  const now = new Date().toISOString();
  const citations = sources.map((s) => s.url).slice(0, 24);

  return {
    ok: true,
    deep,
    passes: passes.map((p) => p.name),
    fetched_at: now,
    model_used: passes.map((p) => p.model).filter(Boolean).join("+") || "sonar",
    reliability: rel,
    product,
    citations,
    sources,
    warnings: [...new Set(warnings.filter(Boolean))].slice(0, 12),
    guards: {
      pinned_fields: product.pinned_fields || [],
      hard_retail_count: product.hard_retail_count || 0,
      matching_listings: product.matching_listings || 0,
      dropped_listings: product.dropped_listings || 0,
      image_count: (product.image_urls || []).length,
      image_via: product.image_via || [],
      sku_label: product.sku_label || fingerprint?.shortLabel,
      config_fingerprint: product.config_fingerprint || fingerprint?.key,
      tgp: {
        watts: tgp.tgp_watts,
        label: tgp.tgp_label || tgp.gpu_tgp_w,
        confidence: tgp.tgp_confidence,
      },
      price_confidence: product.price_confidence,
      query_completeness: completeness,
    },
  };
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    send(res, 200, {
      ok: true,
      service: "laptop-recon-agent",
      mode: "deep-multi-pass+guards",
      has_key: hasSonarKey(),
      port: PORT,
      version: 2,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/recon") {
    try {
      const body = await readBody(req);
      console.log(
        `recon: “${String(body.query || "").slice(0, 60)}” depth=${body.depth || "deep"} pin_gpu=${body.existing?.gpu || "—"}`
      );
      const out = await handleRecon(body);
      console.log(
        `  → ${out.product.model} · ${out.product.gpu || "?"} · £${out.product.price_gbp ?? "?"} · asin=${out.product.asin_uk || "—"} · imgs=${out.guards.image_count || 0} (${(out.guards.image_via || []).join("+") || "none"}) · hard=${out.guards.hard_retail_count} · rel=${out.reliability.label} (${out.reliability.score}) · warn=${(out.warnings || []).length}`
      );
      if (out.warnings?.length) {
        for (const w of out.warnings.slice(0, 5)) console.log(`    ! ${w}`);
      }
      send(res, 200, out);
    } catch (e) {
      console.warn("  ✗", e.message);
      send(res, e.code === "NO_KEY" ? 503 : e.code === "AMBIGUOUS_SKU" ? 400 : 500, {
        ok: false,
        error: e.message || String(e),
        code: e.code || null,
        completeness: e.completeness || null,
      });
    }
    return;
  }

  send(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`Deep recon agent http://${HOST}:${PORT} (guards v2)`);
  console.log(`  health: GET  /health`);
  console.log(
    `  recon:  POST /recon  { "query": "…", "existing": { gpu, cpu, ram, … }, "depth": "deep"|"quick" }`
  );
  console.log(
    hasSonarKey()
      ? "  PERPLEXITY_API_KEY: ok"
      : "  WARNING: PERPLEXITY_API_KEY missing in .env"
  );
});
