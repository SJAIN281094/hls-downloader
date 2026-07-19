const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const COURSE_URL =
  "https://master.dev/courses/ai-engineering/add-tools-for-agent/";

function parseCookiesFromParsed(parsed) {
  if (!parsed.cookies) return [];
  return parsed.cookies
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

function extractVideoHash(url) {
  const m = String(url).match(/\/([A-Za-z0-9]{8,})\/index(?:_|\.)/);
  return m ? m[1] : null;
}

async function getPlaylist(page, videoHash) {
  return page.evaluate(async (hash) => {
    const res = await fetch(`https://api.master.dev/v2/kabuki/video/${hash}/source?f=m3u8`, {
      credentials: "include",
    });
    if (!res.ok) throw new Error(`kabuki API ${res.status}`);
    const { url: masterUrl } = await res.json();
    const masterRes = await fetch(masterUrl, { credentials: "include" });
    if (!masterRes.ok) throw new Error(`master m3u8 ${masterRes.status}`);
    const master = await masterRes.text();
    const lines = master.split("\n");
    let variantLine = null;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes("#EXT-X-STREAM-INF")) continue;
      if (/720/.test(lines[i])) {
        variantLine = lines[i + 1]?.trim();
        break;
      }
      if (!variantLine) variantLine = lines[i + 1]?.trim();
    }
    const variantUrl = new URL(variantLine, masterUrl).toString();
    const vr = await fetch(variantUrl, { credentials: "include" });
    if (!vr.ok) throw new Error(`variant m3u8 ${vr.status}`);
    return { variantUrl, body: await vr.text() };
  }, videoHash);
}

async function downloadSegment(page, variantUrl, segmentPath) {
  const b64 = await page.evaluate(
    async ({ variantUrl, segmentPath }) => {
      const url = new URL(segmentPath, variantUrl).toString();
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buf);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    },
    { variantUrl, segmentPath }
  );
  return Buffer.from(b64, "base64");
}

async function downloadMasterDevVideo(parsed, outPath, onProgress) {
  const videoHash = extractVideoHash(parsed.url);
  if (!videoHash) throw new Error("Could not extract video hash from URL");

  const cookies = parseCookiesFromParsed(parsed);
  const workDir = path.join(path.dirname(outPath), `work-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  const userAgent =
    parsed.headers["User-Agent"] ||
    parsed.headers["user-agent"] ||
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent });
  if (cookies.length) await context.addCookies(cookies);

  const page = await context.newPage();
  onProgress?.("Opening course page in browser...");
  await page.goto(COURSE_URL, { waitUntil: "networkidle", timeout: 120000 });

  onProgress?.("Fetching playlist...");
  const { variantUrl, body } = await getPlaylist(page, videoHash);
  const segmentPaths = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  const localPlaylist = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t) {
      localPlaylist.push("");
      continue;
    }
    if (t.startsWith("#") || !/\.ts/i.test(t)) {
      localPlaylist.push(line);
      continue;
    }
    const name = t.split("/").pop().split("?")[0];
    const idx = segmentPaths.indexOf(t);
    onProgress?.(`Downloading segment ${idx + 1}/${segmentPaths.length}`);
    const data = await downloadSegment(page, variantUrl, t);
    fs.writeFileSync(path.join(workDir, name), data);
    localPlaylist.push(name);
  }

  await browser.close();

  const m3u8Path = path.join(workDir, "playlist.m3u8");
  fs.writeFileSync(m3u8Path, localPlaylist.join("\n"));

  await new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      [
        "-protocol_whitelist",
        "file,http,https,tcp,tls,crypto",
        "-i",
        m3u8Path,
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        "-movflags",
        "+faststart",
        "-y",
        outPath,
      ],
      { stdio: "ignore", cwd: workDir }
    );
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
  });

  fs.rmSync(workDir, { recursive: true, force: true });
}

module.exports = { downloadMasterDevVideo };
