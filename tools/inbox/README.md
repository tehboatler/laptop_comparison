# Inbox — add laptops (free)

Drop one JSON file per laptop here, then:

```bash
npm run catalog:import
npm run catalog:sonar          # optional: flesh out specs
npm run catalog:sync           # free: buy links + validate + embed
```

Or skip files and paste a URL:

```bash
npm run catalog:add -- --url "https://www.amazon.co.uk/dp/B0XXXXXXXX" --gbp 1259 --title "Lenovo LOQ 15 RTX 5060 16GB"
```

## Template

See `_template.json`. Minimum useful fields:

| Field | Why |
|-------|-----|
| `listing_url` | Amazon/Geizhals page you actually looked at |
| `model` | Short display name |
| `price_gbp` / `price_eur` | Street price **you saw on that page** |
| `asin` | Auto-filled from Amazon URL if omitted |
| `ean` | Optional but great |

**Price is “SKU-verified”** when you set a price while looking at a listing that has ASIN or EAN. The app stores that ID on the row and links buy-through to it.

No paid price API required.
