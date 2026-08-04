#!/usr/bin/env node
/**
 * Debug: dump raw Price API search_results payload shape.
 *   node tools/debug_priceapi_search.js
 *   node tools/debug_priceapi_search.js "MacBook Pro 14"
 *   node tools/debug_priceapi_search.js --job 6a71f2e1a898bb1243470a03
 */
const fs = require("fs");
const path = require("path");
const { loadDotEnv } = require("./lib/catalog_utils");
const {
  hasPriceApiKey,
  createJob,
  waitForJob,
  downloadJob,
  getJob,
  parseSearchResults,
  flattenProducts,
} = require("./lib/priceapi");

loadDotEnv();

async function main() {
  if (!hasPriceApiKey()) {
    console.error("PRICEAPI_TOKEN missing");
    process.exit(1);
  }
  const outDir = path.join(__dirname, "out");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const args = process.argv.slice(2);
  let jobId = null;
  const jobFlag = args.indexOf("--job");
  if (jobFlag >= 0) jobId = args[jobFlag + 1];
  const term =
    args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--job") ||
    "MacBook Pro 14";

  if (!jobId) {
    console.log("Creating search_results job…", { term, source: "amazon", country: "gb" });
    // Try JSON array values (current client)
    const created = await createJob({
      source: "amazon",
      country: "gb",
      topic: "search_results",
      key: "term",
      values: [term],
      max_pages: 1,
      max_age: 1440,
    });
    jobId = created.jobId;
    console.log("jobId", jobId);
    console.log("create raw keys", Object.keys(created.raw || {}));
    await waitForJob(jobId, { timeoutMs: 180000 });
  } else {
    console.log("Reusing job", jobId);
    const job = await getJob(jobId);
    console.log("job status snapshot:", JSON.stringify(job).slice(0, 800));
  }

  const results = await downloadJob(jobId, "json");
  const outPath = path.join(outDir, "debug_search_payload.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

  console.log("\n=== payload summary ===");
  console.log("typeof", typeof results);
  console.log("isArray", Array.isArray(results));
  if (results && typeof results === "object" && !Array.isArray(results)) {
    console.log("top keys", Object.keys(results));
  }
  const flat = flattenProducts(results);
  console.log("flattenProducts length", flat.length);
  if (flat[0]) {
    console.log("first flat keys", Object.keys(flat[0]));
    console.log("first flat sample", JSON.stringify(flat[0]).slice(0, 600));
  }
  const hits = parseSearchResults(results, { values: [term] });
  console.log("parseSearchResults hits", hits.length);
  if (hits[0]) console.log("first hit", hits[0]);

  // Also try form-urlencoded style if empty (some APIs want newline string)
  if (!flat.length && !jobFlag) {
    console.log("\n=== retry: values as newline string in body ===");
    const BASE = process.env.PRICEAPI_BASE || "https://api.priceapi.com/v2";
    const token = process.env.PRICEAPI_TOKEN || process.env.PRICEAPI_KEY;
    const body = {
      source: "amazon",
      country: "gb",
      topic: "search_results",
      key: "term",
      values: term,
      max_pages: 1,
      max_age: 1440,
    };
    const res = await fetch(`${BASE}/jobs?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    console.log("create status", res.status, JSON.stringify(json).slice(0, 400));
    const jid = json.job_id || json.id;
    if (jid) {
      await waitForJob(String(jid), { timeoutMs: 180000 });
      const r2 = await downloadJob(String(jid), "json");
      fs.writeFileSync(
        path.join(outDir, "debug_search_payload_string_values.json"),
        JSON.stringify(r2, null, 2)
      );
      console.log(
        "string-values flatten",
        flattenProducts(r2).length,
        "keys",
        r2 && typeof r2 === "object" ? Object.keys(r2) : typeof r2
      );
      console.log("preview", JSON.stringify(r2).slice(0, 1200));
    }
  }

  console.log("\nWrote", outPath);
  console.log("Preview:", JSON.stringify(results).slice(0, 1500));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
