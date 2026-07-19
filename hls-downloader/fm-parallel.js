const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

function buildFetchHeaders(parsed) {
  const headers = { ...parsed.headers };
  delete headers["content-length"];
  delete headers["Content-Length"];
  if (parsed.cookies) headers.Cookie = parsed.cookies;
  return headers;
}

function fetchBuffer(url, parsed, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error("cancelled"));

    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers: buildFetchHeaders(parsed) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchBuffer(new URL(res.headers.location, url).toString(), parsed, signal)
          .then(resolve)
          .catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    if (signal) {
      const onAbort = () => {
        req.destroy(signal.reason || new Error("cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal.removeEventListener("abort", onAbort));
    }
  });
}

function parseSegments(playlistBody, playlistUrl) {
  const base = new URL(playlistUrl);
  const segments = [];
  const seen = new Set();

  for (const line of playlistBody.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !/\.ts(?:\?|$)/i.test(trimmed)) continue;

    const url = new URL(trimmed, base).toString();
    const name = path.basename(new URL(url).pathname);
    if (seen.has(name)) continue;
    seen.add(name);
    segments.push({ url, name });
  }

  return segments;
}

function buildLocalPlaylist(playlistBody, playlistUrl) {
  const base = new URL(playlistUrl);
  return playlistBody
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !/\.ts(?:\?|$)/i.test(trimmed)) {
        return line;
      }
      return path.basename(new URL(trimmed, base).pathname);
    })
    .join("\n");
}

async function runPool(items, concurrency, worker, signal) {
  let next = 0;
  let firstError = null;

  async function runner() {
    while (!firstError) {
      if (signal?.aborted) return;
      const idx = next++;
      if (idx >= items.length) return;
      try {
        await worker(items[idx], idx);
      } catch (err) {
        firstError = err;
        throw err;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length || 1) }, runner)
  );
  if (firstError) throw firstError;
}

function parallelWorkers(readRate) {
  return Math.min(16, Math.max(4, Math.round(readRate * 6)));
}

async function downloadFrontendMastersParallel(parsed, outPath, prepared, options = {}) {
  const { onProgress, readRate = 2, signal } = options;
  const { playlistBody, playlistUrl } = prepared;
  if (!playlistBody || !playlistUrl) {
    throw new Error("Missing playlist data for parallel download");
  }

  const segments = parseSegments(playlistBody, playlistUrl);
  if (!segments.length) throw new Error("No video segments found in playlist");

  const workDir = path.join(path.dirname(outPath), `work-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  const concurrency = parallelWorkers(readRate);
  let done = 0;
  const startedAt = Date.now();

  onProgress?.({ phase: "segments", done: 0, total: segments.length, concurrency });

  try {
    await runPool(
      segments,
      concurrency,
      async (segment) => {
        const data = await fetchBuffer(segment.url, parsed, signal);
        fs.writeFileSync(path.join(workDir, segment.name), data);
        done += 1;
        const elapsed = Math.max(1, (Date.now() - startedAt) / 1000);
        onProgress?.({
          phase: "segments",
          done,
          total: segments.length,
          concurrency,
          speed: `${(done / elapsed).toFixed(1)} seg/s`,
        });
      },
      signal
    );

    const m3u8Path = path.join(workDir, "playlist.m3u8");
    fs.writeFileSync(m3u8Path, buildLocalPlaylist(playlistBody, playlistUrl));

    onProgress?.({ phase: "mux", done: segments.length, total: segments.length });

    await new Promise((resolve, reject) => {
      const ff = spawn(
        "ffmpeg",
        [
          "-protocol_whitelist",
          "file,http,https,tcp,tls,crypto",
          "-i",
          "playlist.m3u8",
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
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            ff.kill("SIGTERM");
            reject(signal.reason || new Error("cancelled"));
          },
          { once: true }
        );
      }
      ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
      ff.on("error", reject);
    });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

module.exports = { downloadFrontendMastersParallel, parallelWorkers };
