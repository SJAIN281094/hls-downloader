#!/usr/bin/env node
/**
 * Capture signed HLS segment URLs from master.dev via Playwright.
 * Usage: node scripts/browser-capture.js <course-page-url>
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const courseUrl =
  process.argv[2] ||
  "https://master.dev/courses/ai-engineering/add-tools-for-agent/";

const COOKIES = [
  { name: "CloudFront-Policy", value: "eyJTdGF0ZW1lbnQiOlt7IlJlc291cmNlIjoiaHR0cHM6Ly9zdHJlYW0ubWFzdGVyLmRldi9tYXN0ZXJkZXYvMjAyNi8wNC8yOC9DU0taWFp6aXR1LyoiLCJDb25kaXRpb24iOnsiRGF0ZUxlc3NUaGFuIjp7IkFXUzpFcG9jaFRpbWUiOjE3ODU1NDIzOTl9fX1dfQ__", domain: ".master.dev", path: "/" },
  { name: "CloudFront-Signature", value: "bWyhcIdZKh0eGtR2NeYDIGs8ykQBmKuRdEfMf2XH1favTFW0EeaseK73tqoANqz~KRzg1xRZ1Lt6R0BrAzbBz3OaqdtR1PcXtkfRlxW~uuo4Ol72odxU0Ty3ECsl7RvdX8AmwpnD-oomnqmZuPxt35ppqQYB1t2~bUWCRCWC6k5hml8w4FLA7160MeGAjV9uzGuhbsD~GGXJ1pgIntERSiCg3mEg4x~lhBpq3xFkIR5nKKaC5xyxjL1IsvSJpekUcwEfSLB8OY~ohEZTIXTS8TIP8i6dav3OyJMntK97BH6UL5oG4IxrKiBNd1EIOy5M0K19E-cSmNPg5bGSjlLr~A__", domain: ".stream.master.dev", path: "/" },
  { name: "CloudFront-Key-Pair-Id", value: "K16DQGA4FC1OUM", domain: ".stream.master.dev", path: "/" },
  { name: "fem_auth_mod", value: "d279733f-1a74-427e-ae1e-5d407b18cb84", domain: ".master.dev", path: "/" },
  { name: "FM_EMCS", value: "\x60\xbe\xe6\x1c\xfc\x25\xbdQ\xc4\x5b\x81+\xf4\x85\xda\x3bhK\x89\xa2\x98d\x00\xe0\xda\xeb\x0b\xf8", domain: ".master.dev", path: "/" },
];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  });

  await context.addCookies(
    COOKIES.map((c) => ({ ...c, secure: true, sameSite: "None" }))
  );

  const captured = { m3u8: null, segments: [], variant: null };

  const page = await context.newPage();
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes(".m3u8")) {
      if (url.includes("index_")) captured.variant = url;
      else captured.m3u8 = url;
    }
    if (/\.ts(\?|$)/.test(url) && captured.segments.length < 3) {
      captured.segments.push(url);
    }
  });

  console.log("Loading course page...");
  await page.goto(courseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Try to start playback
  await page.waitForTimeout(3000);
  const playBtn = page.locator(".vjs-big-play-button, button[aria-label*='Play'], .play-button").first();
  if (await playBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await playBtn.click();
    console.log("Clicked play");
  }

  // Wait for segment requests
  for (let i = 0; i < 20 && captured.segments.length === 0; i++) {
    await page.waitForTimeout(1000);
  }

  await browser.close();

  const out = path.join(__dirname, "..", "downloads", "captured-urls.json");
  fs.writeFileSync(out, JSON.stringify(captured, null, 2));
  console.log(JSON.stringify(captured, null, 2));
  console.log("Saved to", out);

  if (captured.segments.length) {
    const seg = captured.segments[0];
    const https = require("https");
    const status = await new Promise((resolve) => {
      https
        .get(seg, { headers: { referer: "https://master.dev/" } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        })
        .on("error", () => resolve(0));
    });
    console.log("Segment probe from Node:", status);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
