# Catalog ops — jobs to be done

Keep this **simple and free**. Paid price APIs are optional and off by default.

## The only workflow you need

### In-page deep recon (add / refresh one model)

1. Terminal: `npm run recon:server` (uses `PERPLEXITY_API_KEY` from `.env`)
2. Open the finder → **＋ Recon model** (or **↻ Refresh recon** on a detail page)
3. **Name the SKU, not just the family.** Multi-config lines (Legion 5i, LOQ, TUF, Victus, …) need at least **GPU** in the query:
   - Good: `Legion 5i Gen 10 15 UK RTX 5060 16GB i7-13650HX`
   - Bad: `Legion 5i Gen 10` (blocked — many different products share that title)
4. Leave **Deep research** checked (default) — 3 Sonar passes (~30–90s)
5. Matching is by **config fingerprint** (GPU + CPU + RAM), not marketing title:
   - Same config → **upgrade** that row  
   - Same family, different GPU/RAM → **add new row** (no silent merge)  
   - **Always add as new row** checkbox forces a split  
6. Rows are renamed to `Family · RTX 5060 · CPU · 16GB` so cards stay distinct  
7. Cards show **config chips** (GPU · CPU · RAM) + reliability  
8. Browser overlay auto-saves recon (no hard refresh); optional Save for git/`data.json`

Uncheck deep for a faster listings-only pass. Browser API key is optional fallback (quick only).

### A) Fully automated batch (Sonar CLI)

```
1. DISCOVER     Sonar finds sellable EU/UK configs
2. IDs + PRICE  ASIN/EAN format-checked + street price research-verified against listing
3. DRAFTS       written into catalog (col_status=draft)
4. PUBLISH      npm run catalog:sync
5. PROMOTE      change draft → consider/top when you trust the row
```

```bash
npm run catalog:sonar:discover          # whole seed list in tools/discover_queries.json
npm run catalog:sonar:discover:dry      # candidates only (no data.json writes)
npm run catalog:sync
```

Seeds: edit `tools/discover_queries.json`.  
Report: `tools/out/sonar_discover.json`.

**Price honesty:** Sonar “verify” step re-checks ASIN + price via web. That is **research verification**, not a paid live price API. UI may show listing-checked when verify confidence is medium/high. Always open the Amazon chip before buying.

### B) Manual listing (free, highest trust)

```
1. POPULATE     paste Amazon URL + price you saw
2. FLESH OUT    Sonar specs
3. PUBLISH      sync
```

```bash
npm run catalog:add -- --url "https://www.amazon.co.uk/dp/B0XXXXXXXX" --gbp 1259 --title "…"
npm run catalog:sonar -- --id lap_....
npm run catalog:sync
```

### C) Existing catalog maintenance

```bash
npm run catalog:sonar:ids           # fill missing ASIN/EAN on current rows
npm run catalog:sonar:unenriched    # specs for rows never Sonar'd
npm run catalog:sync                # always runs auto-hygiene
```

### Automatic quality (every sync / after discover)

`catalog_hygiene.js` runs automatically. **Default keeps discover work visible:**

1. Restores rows wrongly buried by older “no ASIN → pass” hygiene  
2. Scrubs fake/placeholder ASINs  
3. Dedupes only **true ASIN collisions** (same B0… → keep best row)  
4. Fills Amazon image from ASIN when missing  
5. Fills class FPS / thermal templates when empty  
6. **Auto-promotes priced discover drafts → `consider`** (ASIN optional; flags `needs_retail_id`)  

Soft title-dedupe and “hide if no ASIN” are **off** unless `HYGIENE_STRICT=1`.

Finder ranks **`top` | `consider` | `alt`** (not `draft` / `pass`).

**Retail IDs from Sonar:** filled into `sku_map` + `sku_registry` when confidence is medium/high and the ASIN looks like `B0…` / EAN has a valid length. They are **not** marked listing-checked (`price_verified`) until you open the Amazon page yourself.

### Sonar batch size (don’t spam the same command)

Bulk commands process **the whole queue in one run**:

```bash
npm run catalog:sonar:ids          # every row missing ASIN/EAN
npm run catalog:sonar:unenriched   # every row never Sonar-enriched
```

- Progress **saves after each row** — Ctrl+C and re-run continues with what’s left  
- Optional cap only if you want: `--max 5`  
- Unlimited: `--max all` or `SONAR_MAX=0` (default)

### Rate limits (429) — pacing, not caps

| Env | Default | Meaning |
|-----|---------|---------|
| `SONAR_DELAY_MS` | `4000` | Wait between calls |
| `SONAR_MAX` | `0` (all) | Cap per run; `0`/`all` = no cap |
| `SONAR_RETRY_MAX` | `5` | Retries on 429 / 5xx |
| `SONAR_RETRY_BASE_MS` | `20000` | First backoff; grows each retry |
| `SONAR_FAIL_STOP` | `5` | Stop after N consecutive failures |

```bash
# Whole ID queue, slower pacing
$env:SONAR_DELAY_MS=8000; npm run catalog:sonar:ids

# Only 10 this hour
node tools/sonar_enrich.js noids --max 10
```

On 429 the client waits and retries. If retries are exhausted, it **stops early with progress saved** — run the same command again later.


Or drop JSON files into `tools/inbox/` (see `tools/inbox/_template.json`) then:

```bash
npm run catalog:import
npm run catalog:sonar
npm run catalog:sync
```

### What “SKU-verified price” means

You open **one** Amazon (or Geizhals) page for the **exact** config → copy the URL and type the price shown.

- ASIN is parsed free from `/dp/B0…`
- That ID is stored on the row (`sku_registry` + `sku_map`)
- Buy links include Amazon for that ASIN when possible
- Sonar **will not overwrite** a verified price

There is no free multi-shop live floor. Buy links follow an **Ireland-first** path:

1. **Google Shopping Ireland** — filter price + in stock / delivery  
2. **Geizhals / Idealo** — cheapest EU for the exact model  
3. **Currys.ie · Expert.ie · DID · Amazon.ie / Amazon.co.uk** — local convenience  

Refresh all rows: `npm run catalog:buys`

---

## Env (minimal)

```bash
# .env  (gitignored)
PERPLEXITY_API_KEY=pplx-...     # for catalog:sonar only
SONAR_MODEL=sonar               # or sonar-pro

# Optional / legacy (off unless you opt in)
# CATALOG_PRICEAPI=1
# CATALOG_RESOLVE=1
# PRICEAPI_TOKEN=...
```

---

## Promote a draft

After Sonar looks good:

1. Open `data.json` (or sheet edit mode `?edit=1`)
2. Set `col_status` from `draft` → `consider` or `top`
3. Spot-check TGP / dual-channel / battery Wh
4. `npm run catalog:sync`

---

## What each command costs

| Command | Cost |
|---------|------|
| `catalog:add` / `import` | Free |
| `catalog:sync` (default) | Free |
| `catalog:sonar` | Perplexity API (you control volume) |
| `CATALOG_PRICEAPI=1` / `CATALOG_RESOLVE=1` | metoda credits — **avoid** for routine use |

---

## Optional legacy tools

Still in the repo if you ever want them:

- `catalog:resolve` / `catalog:discover` — metoda search (paid)
- Amazon PA-API — free only with Associates approval

Default recommendation: **ignore them**. URL + human price + Sonar is enough for a static EU/UK finder.

---

## Chassis grades

| Grade | Meaning |
|-------|---------|
| `plastic` | Typical gaming plastic shell |
| `hybrid` | Metal lid + plastic body |
| `metal` | Mostly metal |
| `premium` | CNC / unibody |

## Availability

`retail` | `limited` | `clearance` | `aftermarket`  
Finder “prefer retail” hides `aftermarket`.
