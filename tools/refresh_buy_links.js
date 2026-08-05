/**
 * Rebuild buy links for every laptop using the Ireland-first shopping workflow.
 *
 *   npm run catalog:buys
 */
const fs = require("fs");
const path = require("path");
const { buildBuyLinks, BUY_GUIDE_IE } = require("./lib/buy_links");

const dataPath = path.join(__dirname, "..", "data.json");
const d = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const sheet = d.sheets.find((s) => String(s.name || "").toLowerCase().includes("laptop"));
if (!sheet) {
  console.error("No laptop sheet found");
  process.exit(1);
}

let n = 0;
for (const row of sheet.rows) {
  const c = row.cells;
  const det = c.col_detail || {};
  // Keep recon product-page links (kind recon / from_recon) at the front
  const prev = Array.isArray(det.buy_links) ? det.buy_links : [];
  const reconKeep = prev.filter(
    (l) =>
      l &&
      (l.kind === "recon" ||
        l.from_recon ||
        /recon/i.test(String(l.label || "")) ||
        /recon/i.test(String(l.note || "")))
  );
  const standard = buildBuyLinks(
    c.col_model,
    c.col_brand || det.brand,
    det.graphics?.model,
    c.col_gpu,
    det.sku_map || {}
  );
  // Dedupe by URL — recon first, then IE workflow
  const seen = new Set();
  const merged = [];
  for (const L of [...reconKeep, ...standard]) {
    if (!L?.url || seen.has(L.url)) continue;
    seen.add(L.url);
    merged.push(L);
  }
  det.buy_links = merged.slice(0, 18);
  det.buy_guide = BUY_GUIDE_IE;
  c.col_detail = det;
  n++;
}

fs.writeFileSync(dataPath, JSON.stringify(d, null, 2) + "\n");
console.log("Refreshed Ireland-first buy links for", n, "laptops");
console.log("Workflow: Google Shopping IE → Geizhals/Idealo → Currys.ie / Expert / DID / Amazon.ie / .co.uk");
