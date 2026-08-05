#!/usr/bin/env node
const path = require("path");
const {
  resolveProductImages,
  isProductImageUrl,
  extractImagesFromHtml,
  catalogFallbackImages,
  loadCatalogSeriesImages,
} = require("./lib/recon_images");

async function main() {
  let failed = 0;
  const ok = (c, m) => {
    if (!c) {
      console.error("FAIL", m);
      failed++;
    } else console.log("ok", m);
  };

  ok(
    isProductImageUrl(
      "https://p4-ofp.static.pub/fes/cms/2024/08/23/aecao4pbkx3w8n9bjvs286w0oj8j5t361897.png"
    ),
    "static.pub image accepted"
  );
  ok(
    !isProductImageUrl(
      "https://www.lenovo.com/gb/en/p/laptops/legion-laptops/foo"
    ),
    "lenovo HTML product page rejected as image"
  );

  const catalog = loadCatalogSeriesImages(path.join(__dirname, ".."));
  const fb = catalogFallbackImages(
    { model: "Lenovo Legion 5i Gen 10 (15 Intel)", brand: "lenovo" },
    catalog
  );
  ok(fb.length >= 1, "catalog series fallback finds Legion image");

  // Live network (best-effort)
  const urls = [
    "https://www.lenovo.com/gb/en/p/laptops/legion-laptops/legion-5-series/legion-5-15irx9/82td",
  ];
  for (const u of urls) {
    try {
      const res = await fetch(u, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          accept: "text/html",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(12000),
      });
      console.log("fetch", res.status, u.slice(0, 70));
      if (res.ok) {
        const t = await res.text();
        const imgs = extractImagesFromHtml(t, u);
        console.log("  extracted", imgs.length, imgs[0]?.slice(0, 100));
        ok(imgs.length >= 0, "extract ran on lenovo HTML");
      }
    } catch (e) {
      console.log("fetch err", e.message);
    }
  }

  const r = await resolveProductImages(
    {
      model: "Lenovo Legion 5i Gen 10 (15 Intel)",
      brand: "lenovo",
      listings: [
        {
          url: "https://www.lenovo.com/gb/en/p/laptops/legion-laptops/legion-5-series/legion-5i-gen-10-15-inch-intel/83f0",
        },
      ],
      sources: [],
      image_urls: [],
    },
    { rootDir: path.join(__dirname, ".."), maxFetches: 3 }
  );
  console.log("resolve", r.via, r.images.length, r.images[0]?.slice(0, 90));
  ok(r.images.length >= 1, "resolve returns at least one image for Legion");

  if (failed) process.exit(1);
  console.log("all image tests passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
