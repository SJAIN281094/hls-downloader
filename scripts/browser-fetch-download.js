#!/usr/bin/env node
/**
 * Download master.dev video by fetching segments inside a real browser context.
 */
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const DOWNLOADS = path.join(__dirname, "..", "downloads");
const COURSE_URL =
  "https://master.dev/courses/ai-engineering/add-tools-for-agent/";
const VIDEO_HASH = "cSgMnUPrvd";

function parseCookiesFromCurl(raw) {
  const flat = raw.replace(/\\\s*\n/g, " ");
  const m =
    flat.match(/(?:-b|--cookie)\s+'([^']+)'/) ||
    flat.match(/(?:-b|--cookie)\s+"([^"]+)"/);
  if (!m) return [];
  return m[1]
    .split(";")
    .map((part) => {
      const idx = part.indexOf("=");
      if (idx <= 0) return null;
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (!name) return null;
      return {
        name,
        value,
        domain: name.startsWith("CloudFront") ? ".stream.master.dev" : ".master.dev",
        path: "/",
        secure: true,
        sameSite: "Lax",
      };
    })
    .filter(Boolean);
}

async function main() {
  const curl = process.argv[2];
  const outName = (process.argv[3] || "add-tools-for-agent") + ".mp4";
  if (!curl) {
    console.error("Usage: node scripts/browser-fetch-download.js '<curl>' [filename]");
    process.exit(1);
  }

  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const cookies = parseCookiesFromCurl(curl);
  const segDir = path.join(DOWNLOADS, `segments-${Date.now()}`);
  fs.mkdirSync(segDir, { recursive: true });

  console.log("Launching headless browser...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  });
  if (cookies.length) await context.addCookies(cookies);

  const page = await context.newPage();
  let signedSample = null;
  page.on("request", (req) => {
    const url = req.url();
    if (/\.ts\?/.test(url) && url.includes("Signature=") && !signedSample) {
      signedSample = url;
    }
  });

  console.log("Loading course page...");
  await page.goto(COURSE_URL, { waitUntil: "networkidle", timeout: 120000 });

  const play = page.locator(".vjs-big-play-button").first();
  if (await play.isVisible({ timeout: 10000 }).catch(() => false)) {
    await play.click();
  }

  for (let i = 0; i < 25 && !signedSample; i++) {
    await page.waitForTimeout(1000);
  }

  console.log("Signed sample:", signedSample ? signedSample.slice(0, 120) + "..." : "none");

  // Fetch fresh m3u8 via kabuki API in browser
  const playlistInfo = await page.evaluate(async (hash) => {
    const res = await fetch(`https://api.master.dev/v2/kabuki/video/${hash}/source?f=m3u8`, {
      credentials: "include",
    });
    if (!res.ok) return { error: `API ${res.status}` };
    const { url } = await res.json();
    const pl = await fetch(url, { credentials: "include" });
    if (!pl.ok) return { error: `master ${pl.status}` };
    const master = await pl.text();
    const lines = master.split("\n");
    let variant = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("#EXT-X-STREAM-INF") && /720|1080/.test(lines[i])) {
        variant = lines[i + 1]?.trim();
        break;
      }
    }
    if (!variant) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("#EXT-X-STREAM-INF")) {
          variant = lines[i + 1]?.trim();
          break;
        }
      }
    }
    const variantUrl = new URL(variant, url).toString();
    const vr = await fetch(variantUrl, { credentials: "include" });
    if (!vr.ok) return { error: `variant ${vr.status}` };
    const body = await vr.text();
    const segs = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    return { variantUrl, body, segCount: segs.length, segs: segs.slice(0, 5) };
  }, VIDEO_HASH);

  if (playlistInfo.error) {
    console.error("Playlist error:", playlistInfo.error);
    await browser.close();
    process.exit(1);
  }

  console.log(`Variant: ${playlistInfo.variantUrl}`);
  console.log(`Segments: ${playlistInfo.segCount}`);

  // Try downloading first 3 segments in browser context
  const test = await page.evaluate(async ({ variantUrl, body }) => {
    const base = new URL(variantUrl);
    const lines = body.split("\n");
    const results = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const u = new URL(t, base).toString();
      const res = await fetch(u, { credentials: "include" });
      results.push({ url: u.split("?")[0], status: res.status, size: res.headers.get("content-length") });
      if (results.length >= 3) break;
    }
    return results;
  }, { variantUrl: playlistInfo.variantUrl, body: playlistInfo.body });

  console.log("Browser segment test:", test);

  const ok = test.some((t) => t.status === 200);
  if (!ok) {
    console.error("Browser fetch also blocked. Segments need signed URLs from player.");
    await browser.close();
    process.exit(1);
  }

  console.log("Downloading all segments via browser...");
  const downloaded = await page.evaluate(async ({ variantUrl, body }) => {
    const base = new URL(variantUrl);
    const lines = body.split("\n");
    const segments = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const u = new URL(t, base).toString();
      const res = await fetch(u, { credentials: "include" });
      if (!res.ok) return { error: `HTTP ${res.status} for ${u}`, done: segments.length };
      const buf = await res.arrayBuffer();
      segments.push({ name: t.split("/").pop().split("?")[0], data: Array.from(new Uint8Array(buf)) });
    }
    return { segments };
  }, { variantUrl: playlistInfo.variantUrl, body: playlistInfo.body });

  await browser.close();

  if (downloaded.error) {
    console.error("Download failed:", downloaded.error);
    process.exit(1);
  }

  console.log(`Writing ${downloaded.segments.length} segments...`);
  const concatList = path.join(segDir, "list.txt");
  const lines = [];
  for (const seg of downloaded.segments) {
    const fp = path.join(segDir, seg.name);
    fs.writeFileSync(fp, Buffer.from(seg.data));
    lines.push(`file '${fp}'`);
  }
  fs.writeFileSync(concatList, lines.join("\n"));

  const outPath = path.join(DOWNLOADS, outName);
  await new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      ["-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", "-y", outPath],
      { stdio: "inherit" }
    );
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
  });

  fs.rmSync(segDir, { recursive: true, force: true });
  console.log(`Done: ${outPath} (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
