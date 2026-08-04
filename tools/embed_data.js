const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "sheet.html"), "utf8");
const data = fs.readFileSync(path.join(root, "data.json"), "utf8");
const marker = 'id="embedded-workspace"';
const m = html.indexOf(marker);
if (m < 0) throw new Error("embedded-workspace not found");
const contentStart = html.indexOf(">", m) + 1;
const end = html.indexOf("</script>", contentStart);
const next =
  html.slice(0, contentStart) + "\n" + data.trim() + "\n" + html.slice(end);
fs.writeFileSync(path.join(root, "sheet.html"), next);
fs.writeFileSync(path.join(root, "index.html"), next);
const n = JSON.parse(data).sheets.find((s) =>
  String(s.name).includes("Laptop")
).rows.length;
console.log("Embedded", n, "laptops into sheet.html + index.html");
