# Catalog operations (best judgement)

## One-click sync

```bash
npm run catalog:sync
```

This always:
1. Ensures every laptop has a row in `tools/sku_registry.json`
2. Normalizes chassis grades
3. Rebuilds live stock-check buy links
4. Applies SKU map (ASIN/EAN/MPN/official URL) into `data.json`
5. **If Amazon PA-API keys are set** — pulls title, price, EAN, stock message for mapped ASINs
6. Validates catalog
7. Embeds into `sheet.html` + `index.html`
8. Writes `tools/out/research_queue.csv` + `sync_report.json`

### What “official API” means (important)

There is **no free universal API** for “every EU laptop, perfect specs, live price”.

| Source | Type | What you get | Access |
|--------|------|--------------|--------|
| **metoda Price API** (priceapi.com) | **Recommended** commercial data API | Multi-shop prices from Amazon, Google Shopping, Idealo, Geizhals, etc. by **GTIN/EAN, ASIN, or search term** | Free trial credits, then paid plans |
| **Amazon PA-API 5.0** | Official Amazon only | Perfect for mapped **ASINs** | Associates + approval (harder) |
| **Idealo Partner API** | Merchant push API | Not for reading competitor markets | Merchant contract |
| **Buy-link compare URLs** | Always free | Live stock when user clicks | Built into the app |

### metoda Price API (best fit for this project)
Same product as **priceapi.com** — branded **metoda Price API**:
https://www.metoda.com/en/services/priceapi · https://www.priceapi.com/

**Why prefer it over Amazon Associates:**
- Signup is a normal SaaS trial (token in minutes), not affiliate approval hell  
- One API covers **UK + DE** shops and comparison sites  
- Query by **GTIN/EAN** (best), ASIN, or free-text term  
- Returns multi-offer street prices → great for “is this buyable / what’s the floor?”

**Setup:**
```bash
copy .env.example .env
# PRICEAPI_TOKEN=your_token_here
# PRICEAPI_COUNTRY=gb
# PRICEAPI_SOURCE=google_shopping   # or amazon | idealo | geizhals
# PRICEAPI_MAX=15                   # credits per sync
npm run catalog:sync
```

**Practical perfect mapping path:**
1. Fill **EAN/GTIN** (best) or ASIN in `tools/sku_registry.json`
2. `npm run catalog:sync` with `PRICEAPI_TOKEN` → min price + offer count  
3. Specs (TGP, dual-channel, chassis) still verified once from reviews/product pages — price APIs don’t replace that

### Perfect SKU mapping workflow
1. `npm run catalog:sync` (generates research queue)
2. Open `tools/out/research_queue.csv`
3. For each incomplete row, open Geizhals/Amazon links, copy ASIN from `/dp/B0…`
4. Paste into `tools/sku_registry.json` under `entries.<id>.asin.uk` (or `.de`)
5. Optionally paste EAN + manufacturer part number
6. `npm run catalog:sync` again → Amazon enriches price/stock if keys present

## Goals
1. Keep **prices / availability / chassis** honest for EU–UK shoppers  
2. Expand with **currently sellable** value SKUs (prefer 50-series retail)  
3. Use **buy links as live stock checks** (Geizhals / Idealo / Google Shopping)  
4. Avoid brittle, ToS-hostile full-site scraping as the main path  

## Weekly routine
```bash
npm run catalog:sync
git add -A && git commit -m "catalog sync" && git push
```

Plus 15 min human: mark vanished models `aftermarket`, add 2–3 new in-stock SKUs.

## Scraping: feasibility (honest)

| Approach | Feasible? | Notes |
|----------|-----------|--------|
| **Search URL generators** (what we do) | ✅ Yes | Stable, legal, always “live” when user clicks |
| **Amazon PA-API** | ✅ Official | Best automated price path once ASINs mapped |
| **Full scrape Geizhals/Amazon/Scan** | ❌ Poor main strategy | ToS, captchas, HTML churn, bans |
| **Paid price APIs** | ⚠️ Optional | e.g. PriceAPI for GTIN→Geizhals if you pay |

## Chassis grade model
| Grade | Meaning | UI |
|-------|---------|-----|
| `plastic` | Typical gaming plastic shell | “Plastic chassis” |
| `hybrid` | Metal lid + plastic body (TUF/Legion class) | “Metal lid · plastic body” |
| `metal` | Mostly metal, not ultra-premium thin | “Metal chassis” |
| `premium` | CNC / unibody / creator thin | “CNC aluminum” etc. |

Fields: `col_detail.chassis.grade`, `grade_label`, `material`.

## Availability model
`retail` | `limited` | `clearance` | `aftermarket`  
Finder default: **Prefer easy-to-buy new stock** hides `aftermarket`.

## Expanding catalogue (playbook)
1. Prefer **new stock** over legendary last-gen deals  
2. One row = **one priced config** (CPU · GPU · TGP · RAM · SSD)  
3. Always set: buy links, availability, chassis grade, battery Wh, TGP this chassis  
4. Run `validate_catalog.js` before publish  
