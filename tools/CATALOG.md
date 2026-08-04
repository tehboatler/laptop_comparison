# Catalog operations (best judgement)

## Goals
1. Keep **prices / availability / chassis** honest for EU–UK shoppers  
2. Expand with **currently sellable** value SKUs (prefer 50-series retail)  
3. Use **buy links as live stock checks** (Geizhals / Idealo / Google Shopping)  
4. Avoid brittle, ToS-hostile full-site scraping as the main path  

## What works well (recommended routine)

### Weekly (15–30 min, human + scripts)
```bash
node tools/normalize_chassis.js
node tools/refresh_buy_links.js
node tools/validate_catalog.js
# then re-embed into sheet.html for GitHub Pages (see tools/embed_data.js when present)
```

1. Open **Geizhals** / **Idealo UK** for your top 10 value models (LOQ 5060, TUF A16, Nitro V, etc.)  
2. If a model is **gone from retail**, set  
   `col_detail.availability.status = "aftermarket"` (or `clearance`) and a short `note`  
3. If a **new value config** is everywhere, clone a similar row in `data.json` and fill:  
   priced config, TGP, battery Wh, chassis grade, prices EUR/GBP/AUD, availability  

### Monthly
- Add 3–8 new **in-stock** SKUs; retire 40-series premium that only exists used  
- Spot-check battery/TGP claims against one recent review each  

## Scraping: feasibility (honest)

| Approach | Feasible? | Notes |
|----------|-----------|--------|
| **Search URL generators** (what we do) | ✅ Yes | Stable, legal, always “live” when user clicks |
| **Official product feeds / partner APIs** | ✅ Best long-term | Amazon PA-API, affiliate feeds, brand partner CSVs — needs keys & compliance |
| **Semi-auto browser research** | ⚠️ Possible | You run a checklist; script only updates fields you paste |
| **Full scrape Geizhals/Amazon/Scan** | ❌ Poor main strategy | ToS, captchas, HTML churn, IP bans, legal grey area, high maintenance |
| **Headless “price bot” on a schedule** | ⚠️ Only with permission | Fine for **your own** pages or APIs you control; not for silent third-party scraping |

**Judgement:** treat scraping as optional **enrichment with explicit permission**, not the backbone. The backbone should be:
- structured `data.json` you own  
- comparison **search links** for live stock  
- availability tags that demote unbuyable models  
- small scripts that normalize + validate  

If you later want automation: start with **Amazon Product Advertising API** (or a price API you’re licensed for) + a nightly job that only updates `price_*` and `availability` for SKUs you map by ASIN/EAN — not free-form HTML scrape.

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
