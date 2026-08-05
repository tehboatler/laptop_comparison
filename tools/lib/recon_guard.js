/**
 * Recon hardening: config pin, listing/price match, reliability, TGP, footnotes.
 * Used by recon_server.js (and mirrored lightly in the page apply path).
 */

function stripBareFootnotes(text) {
  return String(text || "")
    .replace(/\s*\[\d{1,2}\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function blob(obj) {
  if (obj == null) return "";
  if (typeof obj === "string") return obj;
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

/** RTX/RX 4-digit id, e.g. 5060 */
function gpuNumber(s) {
  const t = String(s || "").toLowerCase().replace(/,/g, "");
  const m =
    t.match(/\brtx\s*(\d{4})\b/) ||
    t.match(/\brx\s*(\d{4})\b/) ||
    t.match(/\b(30[5-9]0|40[5-9]0|50[5-9]0|4060|4070|4080|4090|5060|5070|5080|5090)\b/);
  return m ? String(m[1] || m[0]).replace(/\D/g, "").slice(0, 4) : "";
}

/** Rough GPU tier for upgrade detection (higher = stronger) */
function gpuTier(s) {
  const n = parseInt(gpuNumber(s), 10);
  if (!n) return 0;
  // map common laptop SKUs
  const map = {
    3050: 10,
    4050: 20,
    4060: 30,
    4070: 40,
    4080: 50,
    4090: 60,
    5050: 25,
    5060: 35,
    5070: 45,
    5080: 55,
    5090: 65,
  };
  return map[n] || Math.floor(n / 10);
}

function ramGb(s) {
  const t = String(s || "").toLowerCase();
  const m = t.match(/\b(\d{1,3})\s*gb\b/);
  if (m) return parseInt(m[1], 10);
  const bare = t.match(/^(\d{1,3})$/);
  return bare ? parseInt(bare[1], 10) : 0;
}

function storageGb(s) {
  const t = String(s || "").toLowerCase();
  const tb = t.match(/\b(\d+(?:\.\d+)?)\s*tb\b/);
  if (tb) return Math.round(parseFloat(tb[1]) * 1024);
  const gb = t.match(/\b(\d{3,4})\s*gb\b/);
  if (gb) return parseInt(gb[1], 10);
  return 0;
}

/** Normalize CPU for compare: ultra9-275hx, i7-14700hx, … */
function cpuKey(s) {
  const t = String(s || "")
    .toLowerCase()
    .replace(/intel\s*/g, "")
    .replace(/core\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  const ultra = t.match(/ultra\s*(\d)\s*(\d{3})\s*hx?/);
  if (ultra) return `ultra${ultra[1]}-${ultra[2]}hx`;
  const i = t.match(/i([579])-?(\d{4,5})\s*hx?/);
  if (i) return `i${i[1]}-${i[2]}hx`;
  const r = t.match(/r[y]?zen\s*([579])\s*(\d{4})/);
  if (r) return `r${r[1]}-${r[2]}`;
  return t.slice(0, 40);
}

function queryMentionsGpu(query, gpu) {
  const n = gpuNumber(gpu);
  if (!n) return false;
  const q = String(query || "").toLowerCase();
  return new RegExp(`\\brtx\\s*${n}\\b|\\b${n}\\b`).test(q);
}

function queryMentionsCpu(query, cpu) {
  const k = cpuKey(cpu);
  if (!k) return false;
  const q = String(query || "").toLowerCase();
  const digits = k.replace(/\D/g, "");
  if (digits.length >= 4 && q.includes(digits)) return true;
  if (/ultra\s*9|275hx|14700|14650|13650|240h|253h/i.test(q) && /ultra9|275|14700|14650|13650|240|253/.test(k))
    return true;
  return false;
}

/**
 * Build pinned config from catalog existing + optional user query.
 * When upgrading a row, research must not silently jump GPU/CPU class.
 */
function buildPinnedConfig(existing = {}, query = "") {
  const pin = {
    model: existing.model || "",
    brand: existing.brand || "",
    gpu: existing.gpu || existing.gpu_id || "",
    cpu: existing.cpu || "",
    ram: existing.ram || "",
    storage: existing.storage || "",
    display: existing.display || "",
    config_one_liner: existing.config_one_liner || existing.priced_config || "",
    price_gbp: existing.price_gbp != null ? Number(existing.price_gbp) : null,
    price_eur: existing.price_eur != null ? Number(existing.price_eur) : null,
    asin_uk: existing.asin_uk || "",
    asin_de: existing.asin_de || "",
    ean: existing.ean || "",
    mpn: existing.mpn || "",
  };
  // Query can override pin only when it names a different GPU explicitly
  const qGpu = gpuNumber(query);
  if (qGpu && pin.gpu && qGpu !== gpuNumber(pin.gpu) && queryMentionsGpu(query, qGpu)) {
    pin.gpu = /rtx/i.test(query) ? `RTX ${qGpu}` : pin.gpu;
    pin._query_overrides_gpu = true;
  }
  return pin;
}

function isHttpUrl(u) {
  return /^https?:\/\//i.test(String(u || "").trim());
}

function isGenericSearchUrl(u) {
  const s = String(u || "").toLowerCase();
  if (!s) return true;
  if (/\/s\?k=|search\?|presisearch|mainsearch|tbm=shop|\/search\/|\?fs=|&hloc=/i.test(s))
    return true;
  if (/google\.[^/]+\/search/i.test(s)) return true;
  return false;
}

/** Soft brand/series pages — useful for reading, not for price/ID reliability */
function isSoftBrandUrl(u) {
  const s = String(u || "").toLowerCase();
  if (!s) return false;
  if (/lenovo\.com/i.test(s)) {
    // outlet product with path can still be soft unless clearly a buyable SKU
    if (/\/outlet\/|\/search|cto|configurator|series|gen-?\d/i.test(s)) return true;
    if (/\/p\/|\/product/i.test(s)) return true; // treat Lenovo store as soft unless price verified
    return true;
  }
  if (/asus\.com|msi\.com|acer\.com|hp\.com|dell\.com|razer\.com/i.test(s) && !/\/dp\//i.test(s))
    return true;
  if (/stockinthechannel|e-catalog|viking-direct/i.test(s)) return true;
  return false;
}

/** Hard retail: openable shop product page (Amazon ASIN, Scan, Currys, …) */
function isHardRetailUrl(u) {
  if (!isHttpUrl(u) || isGenericSearchUrl(u) || isSoftBrandUrl(u)) return false;
  const s = String(u);
  if (/amazon\.(co\.uk|de|com)\/(?:dp|gp\/product)\//i.test(s)) return true;
  if (/scan\.co\.uk\/products/i.test(s)) return true;
  if (/currys\.co\.uk\/products/i.test(s)) return true;
  if (/box\.co\.uk/i.test(s) && /product/i.test(s)) return true;
  if (/very\.co\.uk/i.test(s)) return true;
  if (/ao\.com/i.test(s)) return true;
  if (/johnlewis\.com/i.test(s)) return true;
  if (/alternate\.(de|at|nl)/i.test(s)) return true;
  if (/mediamarkt\.|saturn\.|notebooksbilliger|cyberport\.|ldlc\./i.test(s)) return true;
  if (/houseofcomputers|overclockers|cclonline|ebuyer|laptopsdirect/i.test(s)) return true;
  // Geizhals product (a123456) not bare search
  if (/geizhals\.(eu|at|de)\/[^?]+\.html/i.test(s) || /geizhals\..*\/a\d+/i.test(s)) return true;
  return false;
}

function isUsefulShopUrl(u) {
  if (!isHttpUrl(u) || isGenericSearchUrl(u)) return false;
  if (isHardRetailUrl(u)) return true;
  if (isSoftBrandUrl(u)) return true;
  return /\/dp\/|\/gp\/product|\/product\/|currys\.|scan\.co|box\.co|very\.co|ao\.com|johnlewis|lenovo\.com|alternate\.|mediamarkt|amazon\./i.test(
    String(u)
  );
}

/**
 * Does free text (title/url/snippet) agree with pinned config?
 * Returns { ok, reason, score }
 */
function textMatchesConfig(text, pin = {}) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return { ok: true, reason: "empty", score: 0 };

  // Wrong series: Pro vs non-Pro, 16" when pin is 15"
  const model = String(pin.model || "").toLowerCase();
  if (model && /legion\s*5/i.test(model) && !/\bpro\b/i.test(model)) {
    if (/legion\s*pro\s*5/i.test(t)) {
      return { ok: false, reason: "wrong_series_pro", score: -5 };
    }
  }
  if (/\b15\b|15["”]|15\.1|15-inch|15 inch/i.test(model) && /legion\s*pro\s*5i?\s*gen\s*10\s*\(?\s*16/i.test(t)) {
    return { ok: false, reason: "wrong_size_16", score: -5 };
  }

  const pinGpu = gpuNumber(pin.gpu);
  if (pinGpu) {
    const found = [...t.matchAll(/\brtx\s*(\d{4})\b/gi)].map((m) => m[1]);
    const foundRx = [...t.matchAll(/\brx\s*(\d{4})\b/gi)].map((m) => m[1]);
    const all = [...found, ...foundRx];
    if (all.length) {
      if (!all.includes(pinGpu)) {
        return { ok: false, reason: `gpu_mismatch_want_${pinGpu}_got_${all.join("/")}`, score: -5 };
      }
      return { ok: true, reason: "gpu_match", score: 3 };
    }
  }

  // CPU conflict when title names a concrete chip that differs from pin
  const pinCpu = cpuKey(pin.cpu);
  const pinCpuBlob = `${pinCpu} ${pin.cpu || ""}`.toLowerCase();
  const titleCpu = (() => {
    const ultra = t.match(/ultra\s*(\d)\s*(\d{3})\s*hx?/);
    if (ultra) return `ultra${ultra[1]}-${ultra[2]}hx`;
    const i = t.match(/i([579])\s*[- ]?(\d{4,5})\s*hx?/);
    if (i) return `i${i[1]}-${i[2]}hx`;
    const bare = t.match(/\b(13[4-6]\d{2}|14[6-7]\d{2}|275)\s*hx?\b/);
    if (bare) return bare[1];
    return "";
  })();
  if (pinCpu && titleCpu) {
    const pinDigits = pinCpu.replace(/\D/g, "");
    const titleDigits = titleCpu.replace(/\D/g, "");
    // Same family if digit cores overlap meaningfully (e.g. 14700)
    if (
      pinDigits &&
      titleDigits &&
      pinDigits !== titleDigits &&
      !pinDigits.includes(titleDigits) &&
      !titleDigits.includes(pinDigits.slice(0, 4))
    ) {
      return {
        ok: false,
        reason: `cpu_mismatch_want_${pinDigits}_got_${titleDigits}`,
        score: -5,
      };
    }
  }
  // Title clearly last-gen HX while pin is 14th-gen / Ultra
  if (
    /13650|13500|13420|13450|12450|12500|12650/i.test(t) &&
    /14700|14650|275hx|ultra9|ultra\s*7|ultra\s*9|i7-14|i9-14/i.test(pinCpuBlob)
  ) {
    if (!/14700|14650|275|ultra\s*[79]/i.test(t)) {
      return { ok: false, reason: "cpu_mismatch_old_gen", score: -4 };
    }
  }

  return { ok: true, reason: "no_conflict", score: 1 };
}

/**
 * Filter listings to those compatible with pin; drop Pro/wrong GPU/search junk.
 */
function filterListingsForConfig(listings, pin) {
  const kept = [];
  const dropped = [];
  for (const L of listings || []) {
    if (!L?.url) continue;
    const text = [L.title, L.retailer, L.url, L.note].filter(Boolean).join(" ");
    if (isGenericSearchUrl(L.url)) {
      dropped.push({ url: L.url, reason: "search_page" });
      continue;
    }
    const m = textMatchesConfig(text, pin);
    if (!m.ok) {
      dropped.push({ url: L.url, reason: m.reason });
      continue;
    }
    kept.push({
      ...L,
      match_reason: m.reason,
      hard_retail: isHardRetailUrl(L.url),
      soft_brand: isSoftBrandUrl(L.url),
    });
  }
  return { kept, dropped };
}

/**
 * Only accept prices that come from config-matching listings (or safe catalog pin).
 */
function resolveStreetPrices(product, pin, matchingListings) {
  const warnings = [];
  const gbpFromList = [];
  const eurFromList = [];

  for (const L of matchingListings || []) {
    if (L.price == null || isNaN(Number(L.price))) continue;
    // Soft brand pages often show CTO list prices — ignore for street unless hard retail
    if (L.soft_brand && !L.hard_retail) continue;
    if (!L.hard_retail && isSoftBrandUrl(L.url)) continue;
    const price = Math.round(Number(L.price));
    if (price < 200 || price > 6000) continue;
    const cur = String(L.currency || "").toUpperCase();
    const region = String(L.region || "").toUpperCase();
    if (cur === "GBP" || (!cur && region === "UK")) gbpFromList.push({ price, url: L.url, retailer: L.retailer });
    else if (cur === "EUR" || (!cur && (region === "DE" || region === "EU")))
      eurFromList.push({ price, url: L.url, retailer: L.retailer });
    else if (cur === "GBP") gbpFromList.push({ price, url: L.url, retailer: L.retailer });
  }

  const pickMedian = (arr) => {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a.price - b.price);
    return sorted[Math.floor(sorted.length / 2)];
  };

  let price_gbp = null;
  let price_eur = null;
  let price_confidence = "low";
  let price_note = stripBareFootnotes(product.price_note || "");
  let price_source = null;

  const medG = pickMedian(gbpFromList);
  const medE = pickMedian(eurFromList);

  if (medG) {
    price_gbp = medG.price;
    price_source = medG.retailer || medG.url;
    price_confidence = gbpFromList.length >= 2 ? "high" : "medium";
  }
  if (medE) {
    price_eur = medE.price;
    if (!price_source) price_source = medE.retailer || medE.url;
    if (price_confidence === "low")
      price_confidence = eurFromList.length >= 2 ? "high" : "medium";
  }

  // Model-offered prices only if they don't conflict with pin / matching listings
  const offeredGbp =
    product.price_gbp != null ? Math.round(Number(product.price_gbp)) : null;
  const offeredEur =
    product.price_eur != null ? Math.round(Number(product.price_eur)) : null;

  // Reject CTO-ish outliers: > 1.7× median of matching hard listings
  const rejectOutlier = (offered, median) => {
    if (offered == null || median == null) return false;
    return offered > median * 1.7 || offered < median * 0.55;
  };

  if (price_gbp == null && offeredGbp != null) {
    // Only keep if not a ridiculous CTO vs pin catalog
    const pinG = pin.price_gbp != null ? Number(pin.price_gbp) : null;
    if (pinG && rejectOutlier(offeredGbp, pinG)) {
      warnings.push(
        `Rejected research GBP £${offeredGbp} (far from catalog £${pinG}) — likely CTO/list or wrong SKU`
      );
    } else if (!matchingListings?.some((l) => l.hard_retail)) {
      // No hard listing: keep offered but low confidence, prefer catalog pin if closer class
      if (pinG && Math.abs(offeredGbp - pinG) / pinG > 0.35) {
        price_gbp = pinG;
        price_confidence = "low";
        warnings.push(
          `Kept catalog GBP £${pinG} over research £${offeredGbp} (no matching hard retail price)`
        );
        price_note = [
          price_note,
          `Street price uncertain — research £${offeredGbp} did not match a verified same-config shop listing.`,
        ]
          .filter(Boolean)
          .join(" ");
      } else {
        price_gbp = offeredGbp;
        price_confidence = "low";
        warnings.push("GBP price is research estimate without hard retail confirmation");
      }
    } else {
      price_gbp = offeredGbp;
      price_confidence = "medium";
    }
  }

  if (price_eur == null && offeredEur != null) {
    const pinE = pin.price_eur != null ? Number(pin.price_eur) : null;
    if (pinE && rejectOutlier(offeredEur, pinE)) {
      warnings.push(
        `Rejected research EUR €${offeredEur} (far from catalog €${pinE})`
      );
    } else if (pinE && !matchingListings?.some((l) => l.hard_retail) && Math.abs(offeredEur - pinE) / pinE > 0.35) {
      price_eur = pinE;
      warnings.push(`Kept catalog EUR €${pinE} over research €${offeredEur}`);
    } else {
      price_eur = offeredEur;
      if (price_confidence === "high") {
        /* keep */
      } else if (price_confidence === "medium") {
        /* keep */
      } else price_confidence = "low";
    }
  }

  // FX fill only as last resort
  if (price_eur == null && price_gbp != null) {
    price_eur = Math.round(price_gbp * 1.17);
  }
  if (price_gbp == null && price_eur != null) {
    price_gbp = Math.round(price_eur / 1.17);
  }

  // Final sanity vs pin: if research still 2× catalog with soft evidence only, revert pin
  if (
    pin.price_gbp &&
    price_gbp &&
    price_gbp > pin.price_gbp * 1.85 &&
    price_confidence !== "high"
  ) {
    warnings.push(
      `Reverted GBP to catalog £${pin.price_gbp} (research £${price_gbp} looked like wrong/CTO config)`
    );
    price_gbp = Math.round(Number(pin.price_gbp));
    if (pin.price_eur) price_eur = Math.round(Number(pin.price_eur));
    price_confidence = "low";
  }

  if (medG || medE) {
    price_note = [
      price_note,
      `Street estimate from ${[medG && `£${medG.price}`, medE && `€${medE.price}`]
        .filter(Boolean)
        .join(" / ")} on config-matching retail page(s).`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  return {
    price_gbp,
    price_eur,
    price_confidence,
    price_note: stripBareFootnotes(price_note),
    price_source,
    warnings,
    matching_price_count: gbpFromList.length + eurFromList.length,
  };
}

/**
 * Pin GPU/CPU/RAM/storage/model when upgrading an existing catalog row.
 */
function pinProductToExisting(product, existing, query) {
  const warnings = [];
  const pinned_fields = [];
  if (!existing || typeof existing !== "object") {
    return { product, warnings, pinned_fields, pin: buildPinnedConfig({}, query) };
  }

  const pin = buildPinnedConfig(existing, query);
  const q = String(query || "");
  const out = { ...product };

  const pinGpu = () => {
    if (!pin.gpu) return;
    const eg = gpuNumber(pin.gpu);
    const pg = gpuNumber(out.gpu);
    if (!eg) return;
    if (!pg) {
      out.gpu = pin.gpu;
      pinned_fields.push("gpu");
      return;
    }
    if (pg === eg) return;
    // Allow only if user query explicitly asks for the new GPU and not the old
    const wantsNew = queryMentionsGpu(q, out.gpu) && !queryMentionsGpu(q, pin.gpu);
    if (wantsNew) {
      warnings.push(`GPU changed by query request: ${pin.gpu} → ${out.gpu}`);
      return;
    }
    warnings.push(
      `Pinned GPU to catalog ${pin.gpu} (research offered ${out.gpu} — likely wrong SKU/CTO)`
    );
    out.gpu = /rtx/i.test(String(pin.gpu)) ? pin.gpu : `RTX ${eg}`;
    pinned_fields.push("gpu");
  };

  const pinCpu = () => {
    if (!pin.cpu) return;
    const ec = cpuKey(pin.cpu);
    const pc = cpuKey(out.cpu);
    if (!ec) return;
    if (!pc) {
      out.cpu = pin.cpu;
      pinned_fields.push("cpu");
      return;
    }
    if (ec === pc) return;
    const wantsNew = queryMentionsCpu(q, out.cpu) && !queryMentionsCpu(q, pin.cpu);
    if (wantsNew) {
      warnings.push(`CPU changed by query request: ${pin.cpu} → ${out.cpu}`);
      return;
    }
    // Treat tier jumps (i7-14 → Ultra 9) as pin
    warnings.push(
      `Pinned CPU to catalog ${pin.cpu} (research offered ${out.cpu})`
    );
    out.cpu = pin.cpu;
    pinned_fields.push("cpu");
  };

  const pinRam = () => {
    if (!pin.ram) return;
    const er = ramGb(pin.ram);
    const pr = ramGb(out.ram);
    if (er && pr && er !== pr) {
      // don't upgrade 16→32 or 32→64 silently
      if (!/\b(16|24|32|48|64)\s*gb\b/i.test(q) || ramGb(q) === er) {
        warnings.push(`Pinned RAM to catalog ${pin.ram} (research offered ${out.ram})`);
        out.ram = pin.ram;
        pinned_fields.push("ram");
      }
    } else if (!out.ram) {
      out.ram = pin.ram;
      pinned_fields.push("ram");
    }
  };

  const pinStorage = () => {
    if (!pin.storage) return;
    const es = storageGb(pin.storage);
    const ps = storageGb(out.storage);
    if (es && ps && Math.abs(es - ps) >= 256) {
      if (!/\b(512|1\s*tb|2\s*tb|1024)\b/i.test(q)) {
        warnings.push(
          `Pinned storage to catalog ${pin.storage} (research offered ${out.storage})`
        );
        out.storage = pin.storage;
        pinned_fields.push("storage");
      }
    } else if (!out.storage) {
      out.storage = pin.storage;
      pinned_fields.push("storage");
    }
  };

  pinGpu();
  pinCpu();
  pinRam();
  pinStorage();

  if (pin.model && out.model) {
    // Keep catalog model name stable on upgrade
    const a = pin.model.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const b = String(out.model).toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (a.length > 8 && b.length > 8 && !b.includes(a.slice(0, 12)) && !a.includes(b.slice(0, 12))) {
      // different product family — keep research model only if query matches research
      if (!q.toLowerCase().includes(String(out.model).toLowerCase().slice(0, 12))) {
        out.model = pin.model;
        pinned_fields.push("model");
        warnings.push(`Pinned model name to catalog “${pin.model}”`);
      }
    } else {
      out.model = pin.model; // prefer stable catalog label
      pinned_fields.push("model");
    }
  } else if (pin.model && !out.model) {
    out.model = pin.model;
  }

  if (pin.display && !out.display) out.display = pin.display;
  if (pin.brand && !out.brand) out.brand = pin.brand;

  // Rebuild one-liner from pinned facts
  const bits = [
    out.model,
    out.cpu,
    out.gpu,
    out.ram,
    out.storage,
    out.display,
  ].filter(Boolean);
  out.config_one_liner = bits.join(", ");
  out.pinned_from_existing = pinned_fields.length > 0;
  out.pinned_fields = pinned_fields;

  return { product: out, warnings, pinned_fields, pin };
}

/**
 * Normalize TGP to a single primary wattage + confidence.
 * Prefers lower/typical chassis figure over marketing "up to 140".
 */
function normalizeTgp(raw, { gpu, sourcesNote } = {}) {
  const text = [raw, sourcesNote].filter(Boolean).join(" ");
  const s = String(text || "");
  const nums = [...s.matchAll(/\b(\d{2,3})\s*w\b/gi)].map((m) => parseInt(m[1], 10));
  const unique = [...new Set(nums.filter((n) => n >= 35 && n <= 175))];
  let primary = null;
  let confidence = "unknown";
  let note = "";

  if (!unique.length) {
    // bare number?
    const bare = String(raw || "").match(/\b(\d{2,3})\b/);
    if (bare) {
      primary = parseInt(bare[1], 10);
      confidence = "class_estimate";
    }
  } else if (unique.length === 1) {
    primary = unique[0];
    confidence = /up to|upto|max/i.test(s) ? "class_estimate" : "class_estimate";
  } else {
    // Multiple: prefer mid/low class for Legion 5-ish (115 over 140)
    unique.sort((a, b) => a - b);
    // Prefer 100-120 band for 5060/5070 slim gaming if present
    const band = unique.find((n) => n >= 100 && n <= 120);
    primary = band != null ? band : unique[0];
    confidence = "class_estimate";
    note = `Sources mention ${unique.join("/")}W; using ${primary}W as primary class (not marketing max).`;
  }

  // GPU-class defaults when completely missing
  if (primary == null) {
    const g = gpuNumber(gpu);
    if (g === "5060") {
      primary = 115;
      confidence = "class_estimate";
      note = "No chassis TGP found — 115W class estimate for many Legion 5 / slim 5060 designs.";
    } else if (g === "5070") {
      primary = 115;
      confidence = "class_estimate";
      note = "No chassis TGP found — 115W class estimate for Legion 5i 5070 reviews (not 140W max).";
    }
  }

  const label =
    primary != null
      ? `${primary}W${confidence === "confirmed" ? "" : " class"}`
      : null;

  return {
    gpu_tgp_w: primary != null ? `${primary}W` : null,
    tgp_watts: primary,
    tgp_confidence: confidence,
    tgp_note: note || null,
    tgp_label: label,
  };
}

function confScore(c) {
  const x = String(c || "low").toLowerCase();
  if (x === "high") return 3;
  if (x === "medium") return 2;
  return 1;
}

/**
 * Bulletproof reliability: high requires hard retail evidence.
 */
function reliabilityScore(product, { passes = 0, sources = [], matchingListings = [], pinWarnings = [] } = {}) {
  let score = 0;
  const ids = product.asin_uk || product.asin_de;
  const ean = product.ean;
  const hard = (matchingListings || []).filter((l) => l.hard_retail);
  const soft = (matchingListings || []).filter((l) => l.soft_brand && !l.hard_retail);
  const matchPrices = (matchingListings || []).filter(
    (l) => l.hard_retail && l.price != null
  );

  // Soft self-report — heavily capped
  score += Math.min(confScore(product.confidence), 2) * 5;
  score += Math.min(confScore(product.price_confidence), 2) * 6;
  score += Math.min(confScore(product.ids_confidence), 2) * 5;

  if (ids) score += 24;
  if (ean) score += 8;
  if (product.mpn) score += 3;

  score += Math.min(18, hard.length * 6);
  score += Math.min(4, soft.length); // brand pages almost don't count
  score += Math.min(12, matchPrices.length * 5);

  if (product.price_gbp != null || product.price_eur != null) {
    if (product.price_confidence === "high") score += 10;
    else if (product.price_confidence === "medium") score += 6;
    else score += 2;
  }

  if (product.gpu_tgp_w) score += 5;
  if (product.estimated_web_h) score += 4;
  const th = product.thermals || {};
  if (th.load_dba || th.gpu_temp_c || th.cpu_temp_c) score += 7;
  if (Array.isArray(product.play?.games) && product.play.games.length >= 3) score += 7;
  if (product.image_url || (product.image_urls && product.image_urls.length)) score += 4;
  if (passes >= 3) score += 3;
  if ((sources || []).length >= 4) score += 3;

  // Penalties
  if (pinWarnings && pinWarnings.length) score -= Math.min(15, pinWarnings.length * 4);
  if (product.pinned_from_existing) score -= 2; // research tried to drift
  if (!ids && hard.length === 0) score = Math.min(score, 52);
  if (!ids && hard.length < 2 && matchPrices.length === 0) score = Math.min(score, 58);

  score = Math.max(0, Math.min(100, Math.round(score)));

  let label = "low";
  const hardOk = !!(ids || ean || hard.length >= 2 || (hard.length >= 1 && matchPrices.length >= 1));
  if (score >= 72 && hardOk && product.price_confidence !== "low") label = "high";
  else if (score >= 72 && hardOk) label = "medium"; // hard ids but shaky price
  else if (score >= 40) label = "medium";
  else label = "low";

  // Never "high" without hard retail or ASIN/EAN
  if (label === "high" && !ids && !ean && hard.length === 0) label = "medium";

  return {
    score,
    label,
    hard_listing_count: hard.length,
    soft_listing_count: soft.length,
    match_price_count: matchPrices.length,
    has_retail_id: !!(ids || ean),
  };
}

function formatPinnedConfigBlock(pin) {
  if (!pin || (!pin.model && !pin.gpu)) return "";
  return [
    "PINNED CATALOG CONFIG (do not upgrade GPU/CPU/RAM/storage to a different SKU unless the user query explicitly names that different config):",
    pin.model ? `Model: ${pin.model}` : "",
    pin.cpu ? `CPU: ${pin.cpu}` : "",
    pin.gpu ? `GPU: ${pin.gpu}` : "",
    pin.ram ? `RAM: ${pin.ram}` : "",
    pin.storage ? `Storage: ${pin.storage}` : "",
    pin.display ? `Display: ${pin.display}` : "",
    pin.config_one_liner ? `Priced config: ${pin.config_one_liner}` : "",
    pin.asin_uk ? `ASIN UK: ${pin.asin_uk}` : "",
    pin.mpn ? `MPN: ${pin.mpn}` : "",
    pin.price_gbp != null ? `Catalog GBP: ${pin.price_gbp}` : "",
    pin.price_eur != null ? `Catalog EUR: ${pin.price_eur}` : "",
    "Reject listings for Legion Pro / different screen size / different RTX number.",
    "Reject Lenovo CTO list prices as street price unless no other price exists (then mark price_confidence low).",
    "Always identify the exact SKU (CPU + GPU + RAM + storage). Same marketing title can be many different products.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Multi-SKU family handling ─────────────────────────────────

/** Family titles that hide many retail configs under one name */
const MULTI_SKU_FAMILY_RE =
  /\b(legion\s*5i?|legion\s*pro\s*5|loq\s*1[56]|tuf\s*(gaming\s*)?(a|f)?1[456]|victus\s*1[56]|nitro\s*v?\s*1[56]|katana\s*1[56]|thin\s*1[56]|cyborg\s*1[56]|omen\s*1[56]|blade\s*1[46]|zephyrus|strix|ideapad\s*gaming)\b/i;

/**
 * Parse hardware facts from free text (query, model, config line).
 */
function parseConfigFromText(text) {
  const t = String(text || "");
  const gpu = gpuNumber(t);
  const cpu = cpuKey(t);
  let ram = ramGb(t);
  // "32 GB" / "16GB RAM" already handled; also "2 x 16"
  if (!ram) {
    const dual = t.match(/\b2\s*[x×]\s*(\d{1,2})\s*gb\b/i);
    if (dual) ram = parseInt(dual[1], 10) * 2;
  }
  const storage = storageGb(t);
  return {
    gpu: gpu ? `RTX ${gpu}` : "",
    gpu_n: gpu,
    cpu,
    ram_gb: ram || 0,
    storage_gb: storage || 0,
  };
}

/**
 * Stable fingerprint for one buyable config (not marketing title).
 * key example: "gpu:5060|cpu:i7-13650hx|ram:16|ssd:1024"
 */
function configFingerprint(obj = {}) {
  const fromFields = {
    gpu: obj.gpu || obj.gpu_id || "",
    cpu: obj.cpu || "",
    ram: obj.ram || obj.memory || "",
    storage: obj.storage || "",
  };
  const fromText = parseConfigFromText(
    [obj.model, obj.config_one_liner, obj.priced_config, obj.query, fromFields.gpu, fromFields.cpu, fromFields.ram, fromFields.storage]
      .filter(Boolean)
      .join(" ")
  );
  const gpu_n = gpuNumber(fromFields.gpu) || fromText.gpu_n || "";
  const cpu = cpuKey(fromFields.cpu) || fromText.cpu || "";
  const ram_gb = ramGb(fromFields.ram) || fromText.ram_gb || 0;
  const storage_gb = storageGb(fromFields.storage) || fromText.storage_gb || 0;

  const parts = [];
  if (gpu_n) parts.push(`gpu:${gpu_n}`);
  if (cpu) parts.push(`cpu:${cpu}`);
  if (ram_gb) parts.push(`ram:${ram_gb}`);
  if (storage_gb) parts.push(`ssd:${storage_gb}`);

  const shortBits = [];
  if (gpu_n) shortBits.push(`RTX ${gpu_n}`);
  if (cpu) {
    // compact cpu label
    const nice = String(obj.cpu || cpu)
      .replace(/intel\s*core\s*/i, "")
      .replace(/processor/i, "")
      .trim();
    shortBits.push(nice.length > 22 ? cpu : nice);
  }
  if (ram_gb) shortBits.push(`${ram_gb}GB`);
  if (storage_gb) {
    shortBits.push(
      storage_gb >= 1024
        ? `${(storage_gb / 1024).toFixed(storage_gb % 1024 === 0 ? 0 : 1)}TB`
        : `${storage_gb}GB SSD`
    );
  }

  return {
    gpu_n,
    cpu,
    ram_gb,
    storage_gb,
    key: parts.join("|") || "unknown",
    shortLabel: shortBits.join(" · ") || "config unknown",
    chipParts: shortBits,
    complete: !!(gpu_n && (cpu || ram_gb)),
  };
}

/** True if two fingerprints describe the same buyable config (GPU required match when both set). */
function configsCompatible(a, b, { strict = false } = {}) {
  if (!a || !b) return false;
  if (a.key === "unknown" || b.key === "unknown") return !strict;
  if (a.gpu_n && b.gpu_n && a.gpu_n !== b.gpu_n) return false;
  if (a.cpu && b.cpu && a.cpu !== b.cpu) {
    // allow soft cpu if only one side has full key and GPUs match
    if (strict) return false;
    const ad = a.cpu.replace(/\D/g, "");
    const bd = b.cpu.replace(/\D/g, "");
    if (ad && bd && ad !== bd && !ad.includes(bd) && !bd.includes(ad)) return false;
  }
  if (a.ram_gb && b.ram_gb && a.ram_gb !== b.ram_gb) return false;
  if (strict && a.storage_gb && b.storage_gb && Math.abs(a.storage_gb - b.storage_gb) >= 256)
    return false;
  // Need at least GPU agreement when both have GPU
  if (a.gpu_n && b.gpu_n) return true;
  if (a.key === b.key) return true;
  return false;
}

/**
 * Strip existing "· RTX …" config tails so we can re-apply cleanly.
 */
function familyModelBase(model) {
  let m = String(model || "").trim();
  // Remove trailing config parentheticals we may have added
  m = m.replace(
    /\s*[·|]\s*RTX\s*\d{4}.*$/i,
    ""
  );
  m = m.replace(
    /\s*\((?:RTX|i[3579]|Ultra|Ryzen)[^)]*\)\s*$/i,
    ""
  );
  return m.trim() || String(model || "").trim();
}

/**
 * Display name: family + config so same-title SKUs stay distinct.
 * e.g. Legion 5i Gen 10 (15" Intel) · RTX 5060 · i7-13650HX · 16GB
 */
function formatConfigModelName(model, fpOrObj) {
  const base = familyModelBase(model);
  const fp =
    fpOrObj && fpOrObj.key
      ? fpOrObj
      : configFingerprint(fpOrObj || { model });
  if (!fp.gpu_n && !fp.ram_gb) return base;
  // Already contains this GPU in the base name
  if (fp.gpu_n && new RegExp(`rtx\\s*${fp.gpu_n}`, "i").test(base)) {
    // still append CPU/RAM if missing
    const need = [];
    if (fp.cpu && !new RegExp(fp.cpu.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(base)) {
      const shortCpu = fp.chipParts.find((p) => !/^RTX/i.test(p) && !/GB/i.test(p));
      if (shortCpu) need.push(shortCpu);
    }
    if (fp.ram_gb && !new RegExp(`${fp.ram_gb}\\s*gb`, "i").test(base)) {
      need.push(`${fp.ram_gb}GB`);
    }
    return need.length ? `${base} · ${need.join(" · ")}` : base;
  }
  const bits = fp.chipParts.slice(0, 4);
  return bits.length ? `${base} · ${bits.join(" · ")}` : base;
}

/**
 * Is this query too vague for a multi-config family (e.g. bare "Legion 5i Gen 10")?
 */
function queryConfigCompleteness(query) {
  const q = String(query || "").trim();
  const parsed = parseConfigFromText(q);
  const multi = MULTI_SKU_FAMILY_RE.test(q);
  const missing = [];
  if (!parsed.gpu_n) missing.push("GPU (e.g. RTX 5060)");
  if (!parsed.ram_gb) missing.push("RAM (e.g. 16GB or 32GB)");
  // CPU optional but recommended for Legion-class
  if (multi && !parsed.cpu) missing.push("CPU (e.g. i7-13650HX or Ultra 7 255HX)");

  const ok = !multi || !!parsed.gpu_n;
  // Strict block only when multi-family and no GPU at all
  const block = multi && !parsed.gpu_n;
  let hint = "";
  if (block) {
    hint =
      "This family has many different configs under the same title. Add at least the GPU — e.g. “Legion 5i Gen 10 15 RTX 5060 16GB i7-13650HX UK”.";
  } else if (multi && missing.length) {
    hint =
      "Tip: include CPU + RAM so we pin the right SKU (same title ≠ same laptop). Missing: " +
      missing.join(", ") +
      ".";
  }
  return {
    ok,
    block,
    multi_sku_family: multi,
    missing,
    parsed,
    hint,
    example:
      "Legion 5i Gen 10 15\" UK RTX 5060 16GB i7-13650HX",
  };
}

/**
 * Decide upgrade vs add-new given preferred row + research product.
 * Returns { action: 'upgrade'|'add', reason }
 */
function decideReconRowAction({ preferId, existingRow, researchProduct, forceNew }) {
  if (forceNew) return { action: "add", reason: "force_new" };
  if (!existingRow) return { action: "add", reason: "no_match" };

  const rowFp = configFingerprint({
    model: existingRow.model || existingRow.cells?.col_model,
    gpu: existingRow.gpu || existingRow.cells?.col_gpu || existingRow.cells?.col_detail?.graphics?.model,
    cpu: existingRow.cpu || existingRow.cells?.col_cpu,
    ram: existingRow.ram || existingRow.cells?.col_ram || existingRow.cells?.col_detail?.memory?.installed,
    storage:
      existingRow.storage ||
      existingRow.cells?.col_detail?.storage?.primary,
    config_one_liner:
      existingRow.config_one_liner ||
      existingRow.cells?.col_config ||
      existingRow.cells?.col_detail?.priced_config,
  });
  const resFp = configFingerprint(researchProduct || {});

  if (preferId) {
    // User clicked refresh on a specific row — upgrade (pin will hold config)
    return { action: "upgrade", reason: "explicit_row", rowFp, resFp };
  }

  // ASIN match handled by caller as upgrade
  if (configsCompatible(rowFp, resFp, { strict: false })) {
    return { action: "upgrade", reason: "config_match", rowFp, resFp };
  }

  // Same family title but different GPU/RAM → new row
  return {
    action: "add",
    reason: "config_mismatch_split",
    rowFp,
    resFp,
    message: `Same family as “${rowFp.shortLabel || "existing"}” but research is ${resFp.shortLabel} — adding a separate catalog row.`,
  };
}

module.exports = {
  stripBareFootnotes,
  gpuNumber,
  gpuTier,
  ramGb,
  storageGb,
  cpuKey,
  queryMentionsGpu,
  queryMentionsCpu,
  buildPinnedConfig,
  isHttpUrl,
  isGenericSearchUrl,
  isSoftBrandUrl,
  isHardRetailUrl,
  isUsefulShopUrl,
  textMatchesConfig,
  filterListingsForConfig,
  resolveStreetPrices,
  pinProductToExisting,
  normalizeTgp,
  reliabilityScore,
  formatPinnedConfigBlock,
  confScore,
  // multi-SKU
  MULTI_SKU_FAMILY_RE,
  parseConfigFromText,
  configFingerprint,
  configsCompatible,
  familyModelBase,
  formatConfigModelName,
  queryConfigCompleteness,
  decideReconRowAction,
};
