/** Schema / sanity checks for data.json laptop catalog */
const fs = require("fs");
const path = require("path");
const d = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data.json"), "utf8"));
const sheet = d.sheets.find((s) => String(s.name || "").toLowerCase().includes("laptop"));
const rows = sheet.rows || [];
const issues = [];
const grades = new Set(["plastic", "hybrid", "metal", "premium"]);
const avails = new Set(["retail", "limited", "clearance", "aftermarket"]);

for (const r of rows) {
  const c = r.cells || {};
  const det = c.col_detail || {};
  const id = r.id;
  if (!c.col_model) issues.push(`${id}: missing model`);
  if (!c.col_price || c.col_price.EUR == null) issues.push(`${id}: missing EUR price`);
  if (!c.col_price?.GBP) issues.push(`${id}: missing GBP`);
  if (!det.availability?.status || !avails.has(det.availability.status)) {
    issues.push(`${id}: bad availability.status`);
  }
  if (!det.chassis?.grade || !grades.has(det.chassis.grade)) {
    issues.push(`${id}: bad chassis.grade`);
  }
  const links = det.buy_links || [];
  if (links.length < 4) issues.push(`${id}: few buy_links (${links.length})`);
  if (!links.some((l) => l.kind === "compare")) issues.push(`${id}: no compare buy link`);
  if (!det.priced_config && !c.col_config) issues.push(`${id}: no priced config`);
}

console.log("laptops", rows.length);
console.log("issues", issues.length);
if (issues.length) {
  issues.slice(0, 40).forEach((i) => console.log(" -", i));
  process.exitCode = 1;
} else {
  console.log("OK");
}
