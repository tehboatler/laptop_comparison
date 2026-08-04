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
| **Amazon Product Advertising API 5.0** | Official Amazon | Price, title, EAN, availability text, image for **ASINs you map** | Associates account + PA-API approval |
| **Idealo Partner API** | Official Idealo | For **merchants pushing their own offers** — not reading the market | Merchant contract |
| **Geizhals** | No free public read API | Commercial partners / PriceAPI-style products | Paid |
| **Brand sites** | No unified API | Manual / search links | — |
| **Buy-link compare URLs** | Always on | Live stock when the user clicks | Free (what shoppers need) |

**Practical perfect mapping path:**
1. Map each catalog id → **ASIN (UK/DE)** and/or **EAN** + **MPN** in `sku_registry.json`
2. Run `npm run catalog:sync` with Amazon keys → prices + EAN backfill
3. Specs (TGP, dual-channel, battery Wh) still come from **reviews / product pages you verify once** — APIs rarely expose laptop TGP cleanly

Copy `.env.example` → `.env` and fill Amazon keys when ready.

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
