const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { downloadMasterDevVideo } = require("./masterdev-browser");
const { downloadFrontendMastersParallel } = require("./fm-parallel");
const { downloadCourse } = require("./fm-course");

const app = express();
const PORT = 3456;
const DOWNLOADS_DIR = path.join(__dirname, "downloads");

fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
fs.mkdirSync(path.join(__dirname, "public"), { recursive: true });

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/downloads", express.static(DOWNLOADS_DIR));

const activeJobs = new Map();

// ---------------------------------------------------------------------------
// Curl command parser
// ---------------------------------------------------------------------------
function parseCurlCommand(raw) {
  const input = raw.trim();

  // If it's just a URL (no curl prefix), return it directly
  if (/^https?:\/\//.test(input)) {
    return normalizeParsedInput({ url: input, headers: {}, cookies: "" });
  }

  // Remove line continuations (backslash + newline) and collapse
  const flat = input.replace(/\\\s*\n/g, " ");

  const headers = {};
  let cookies = "";
  let url = "";

  // Extract URL — first single-quoted or double-quoted string after 'curl', or bare URL
  const urlMatch =
    flat.match(/curl\s+(?:--\S+\s+)*'(https?:\/\/[^']+)'/) ||
    flat.match(/curl\s+(?:--\S+\s+)*"(https?:\/\/[^"]+)"/) ||
    flat.match(/curl\s+(?:--\S+\s+)*(https?:\/\/\S+)/);
  if (urlMatch) url = urlMatch[1];

  // Extract -H / --header values
  const headerRe = /(?:-H|--header)\s+'([^']+)'/g;
  let m;
  while ((m = headerRe.exec(flat)) !== null) {
    const idx = m[1].indexOf(":");
    if (idx > 0) {
      const key = m[1].slice(0, idx).trim();
      const val = m[1].slice(idx + 1).trim();
      headers[key] = val;
    }
  }
  // Also try double-quoted headers
  const headerRe2 = /(?:-H|--header)\s+"([^"]+)"/g;
  while ((m = headerRe2.exec(flat)) !== null) {
    const idx = m[1].indexOf(":");
    if (idx > 0) {
      const key = m[1].slice(0, idx).trim();
      const val = m[1].slice(idx + 1).trim();
      headers[key] = val;
    }
  }

  // Extract -b / --cookie values
  const cookieMatch =
    flat.match(/(?:-b|--cookie)\s+'([^']+)'/) ||
    flat.match(/(?:-b|--cookie)\s+"([^"]+)"/);
  if (cookieMatch) cookies = cookieMatch[1];

  return normalizeParsedInput({ url, headers, cookies });
}

function hasCloudFrontCookies(cookies) {
  return (
    cookies &&
    /CloudFront-Policy=/.test(cookies) &&
    /CloudFront-Signature=/.test(cookies)
  );
}

function normalizeParsedInput(parsed) {
  if (!parsed.url) return parsed;

  try {
    const u = new URL(parsed.url);
    parsed.authQuery = u.search;

    const expires = u.searchParams.get("Expires");
    parsed.signatureExpired = !!(expires && Date.now() / 1000 > Number(expires));

    // CloudFront cookies outlast signed-URL query params; cookies alone fetch playlists.
    if (hasCloudFrontCookies(parsed.cookies)) {
      u.search = "";
      parsed.url = u.toString();
    }
  } catch {
    parsed.authQuery = "";
    parsed.signatureExpired = false;
  }

  if (!parsed.headers["User-Agent"] && !parsed.headers["user-agent"]) {
    parsed.headers["User-Agent"] =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  }

  return parsed;
}

function buildFetchHeaders(parsed) {
  const headers = { ...parsed.headers };
  delete headers["content-length"];
  delete headers["Content-Length"];
  if (parsed.cookies) headers.Cookie = parsed.cookies;
  return headers;
}

function fetchText(url, parsed) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers: buildFetchHeaders(parsed) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchText(new URL(res.headers.location, url).toString(), parsed)
          .then(resolve)
          .catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
  });
}

async function fetchPlaylistText(url, parsed) {
  try {
    return await fetchText(url, parsed);
  } catch (err) {
    if (!parsed.signatureExpired || !hasCloudFrontCookies(parsed.cookies)) throw err;
    const cookieUrl = new URL(url);
    cookieUrl.search = "";
    return fetchText(cookieUrl.toString(), parsed);
  }
}

function withMasterdevPrefix(urlString) {
  try {
    const u = new URL(urlString);
    if (u.pathname.startsWith("/masterdev/")) return u.toString();
    if (/^\/\d{4}\//.test(u.pathname)) {
      u.pathname = "/masterdev" + u.pathname;
      return u.toString();
    }
  } catch {
    // ignore
  }
  return null;
}

function applyAuthQuery(urlString, authQuery) {
  if (!authQuery) return urlString;
  try {
    const u = new URL(urlString);
    u.search = authQuery.startsWith("?") ? authQuery.slice(1) : authQuery;
    return u.toString();
  } catch {
    return urlString;
  }
}

async function fetchPlaylistWithFallbacks(url, parsed, authQuery) {
  const candidates = [];
  const add = (u) => {
    if (u && !candidates.includes(u)) candidates.push(u);
  };

  add(url);
  add(withMasterdevPrefix(url));
  if (authQuery) {
    add(applyAuthQuery(url, authQuery));
    add(applyAuthQuery(withMasterdevPrefix(url) || "", authQuery));
  }

  let lastErr;
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const body = await fetchPlaylistText(candidate, parsed);
      return { body, url: candidate };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`HTTP error fetching ${url}`);
}

function probeUrl(url, parsed) {
  return new Promise((resolve) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.request(url, { method: "GET", headers: { ...buildFetchHeaders(parsed), Range: "bytes=0-0" } }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on("error", () => resolve(0));
    req.end();
  });
}

function detectPathPrefix(playlistUrl, probeSegmentUrl) {
  if (probeSegmentUrl) {
    try {
      const pathname = new URL(probeSegmentUrl).pathname;
      if (pathname.startsWith("/masterdev/")) return "/masterdev";
      return "";
    } catch {
      // fall through
    }
  }
  const match = playlistUrl.pathname.match(/^(\/[^/]+)\/\d{4}\//);
  return match ? match[1] : "";
}

function resolvePlaylistLine(line, playlistUrl, pathPrefix, segmentAuthQuery) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return line;

  let segmentPath = trimmed;
  const isSegment = /\.ts(?:\?|$)/i.test(segmentPath);

  if (
    isSegment &&
    segmentPath.startsWith("/") &&
    pathPrefix &&
    !segmentPath.startsWith(pathPrefix + "/")
  ) {
    segmentPath = pathPrefix + segmentPath;
  }

  let resolved;
  try {
    resolved = new URL(segmentPath, playlistUrl);
  } catch {
    return line;
  }

  // CloudFront cookies authenticate segments; the m3u8 Signature breaks segment requests.
  if (isSegment && segmentAuthQuery && !resolved.search) {
    resolved.search = segmentAuthQuery.startsWith("?")
      ? segmentAuthQuery.slice(1)
      : segmentAuthQuery;
  }

  return resolved.toString();
}

function segmentAuthQueryFor(parsed) {
  if (hasCloudFrontCookies(parsed.cookies)) return "";
  return parsed.authQuery || "";
}

function firstSegmentUrl(playlistBody, playlistUrl, pathPrefix, segmentAuthQuery) {
  for (const line of playlistBody.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return resolvePlaylistLine(trimmed, playlistUrl, pathPrefix, segmentAuthQuery);
  }
  return null;
}

function rewritePlaylist(body, playlistUrl, pathPrefix, segmentAuthQuery) {
  return body
    .split("\n")
    .map((line) => resolvePlaylistLine(line, playlistUrl, pathPrefix, segmentAuthQuery))
    .join("\n");
}

function pickVariantPlaylist(masterBody, masterUrl, preferredHint) {
  const lines = masterBody.split("\n");
  const variants = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const bwMatch = line.match(/BANDWIDTH=(\d+)/);
    const uri = lines[i + 1]?.trim();
    if (!uri || uri.startsWith("#")) continue;
    variants.push({
      bandwidth: bwMatch ? Number(bwMatch[1]) : 0,
      url: new URL(uri, masterUrl).toString(),
    });
  }

  if (!variants.length) return null;

  if (preferredHint) {
    const hinted = variants.find((v) => v.url.includes(preferredHint));
    if (hinted) return hinted.url;
  }

  variants.sort((a, b) => a.bandwidth - b.bandwidth);
  const preferred =
    variants.find((v) => /1080|720/.test(v.url)) ||
    variants[Math.floor(variants.length / 2)] ||
    variants[0];
  return preferred.url;
}

function variantHintFromSegmentUrl(segmentUrl) {
  try {
    const match = new URL(segmentUrl).pathname.match(/(index_[^_]+(?:_[^_]+)*?)_\d+\.ts$/i);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function stripAuthQuery(urlString) {
  try {
    const u = new URL(urlString);
    u.search = "";
    return u.toString();
  } catch {
    return urlString;
  }
}

function isMasterDevStream(url) {
  try {
    return /stream\.master\.dev/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isFrontendMastersStream(url) {
  try {
    return /stream\.frontendmasters\.com/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isBrowserDownloadStream(url) {
  return isMasterDevStream(url);
}

function isTsSegmentUrl(url) {
  try {
    return /\.ts$/i.test(new URL(url).pathname);
  } catch {
    return /\.ts(?:\?|$)/i.test(url);
  }
}

// index_720_Q8_5mbps_00001.ts -> index_720_Q8_5mbps.m3u8
function segmentUrlToVariantPlaylist(segmentUrl) {
  const u = new URL(segmentUrl);
  u.pathname = u.pathname.replace(/_\d+\.ts$/i, ".m3u8");
  u.search = "";
  return u.toString();
}

function segmentUrlToMasterPlaylist(segmentUrl) {
  const u = new URL(segmentUrl);
  u.pathname = u.pathname.replace(/\/[^/]+$/, "/index.m3u8");
  u.search = "";
  return u.toString();
}

async function prepareHlsInput(parsed) {
  let probeSegmentUrl = null;

  if (isMasterDevStream(parsed.url)) {
    if (!parsed.headers.origin && !parsed.headers.Origin) {
      parsed.headers.origin = "https://master.dev";
    }
    if (!parsed.headers.referer && !parsed.headers.Referer) {
      parsed.headers.referer = "https://master.dev/";
    }
  } else if (isFrontendMastersStream(parsed.url)) {
    if (!parsed.headers.origin && !parsed.headers.Origin) {
      parsed.headers.origin = "https://frontendmasters.com";
    }
    if (!parsed.headers.referer && !parsed.headers.Referer) {
      parsed.headers.referer = "https://frontendmasters.com/";
    }
  }

  // User pasted a .ts segment curl — derive the variant playlist from it.
  if (isTsSegmentUrl(parsed.url)) {
    probeSegmentUrl = parsed.url;
    const segmentUrl = new URL(parsed.url);
    parsed.authQuery = segmentUrl.search;

    const segStatus = await probeUrl(probeSegmentUrl, parsed);
    if (segStatus === 403 || segStatus === 401) {
      throw new Error(
        "Segment auth failed (403). Copy a fresh .ts segment curl from DevTools while the video is playing — signed URLs expire in ~15 minutes."
      );
    }

    parsed.url = segmentUrlToVariantPlaylist(parsed.url);
  }

  const playlistUrl = new URL(parsed.url);
  const pathPrefix = detectPathPrefix(playlistUrl, probeSegmentUrl);
  const authQuery = parsed.authQuery || playlistUrl.search;
  const segAuth = segmentAuthQueryFor(parsed);
  const masterDev = isMasterDevStream(parsed.url);

  let fetched;
  const playlistCandidates = [parsed.url];
  if (probeSegmentUrl) {
    playlistCandidates.push(segmentUrlToMasterPlaylist(probeSegmentUrl));
  }

  let lastErr;
  fetched = null;
  for (const candidate of playlistCandidates) {
    try {
      fetched = await fetchPlaylistWithFallbacks(candidate, parsed, authQuery);
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!fetched) {
    if (probeSegmentUrl) {
      throw new Error(
        `Could not fetch playlist for this segment. Copy the full curl including any -b cookies from DevTools. (${lastErr?.message || "unknown error"})`
      );
    }
    throw lastErr;
  }

  let body = fetched.body;
  let sourceUrl = fetched.url;

  const variantHint = probeSegmentUrl ? variantHintFromSegmentUrl(probeSegmentUrl) : "";

  if (body.includes("#EXT-X-STREAM-INF:")) {
    const variantUrl = pickVariantPlaylist(body, new URL(sourceUrl), variantHint);
    if (variantUrl) {
      const variantFetched = await fetchPlaylistWithFallbacks(
        stripAuthQuery(variantUrl),
        parsed,
        authQuery
      );
      sourceUrl = variantFetched.url;
      body = variantFetched.body;
    }
  }

  const rewritten = rewritePlaylist(body, new URL(sourceUrl), pathPrefix, segAuth);

  const segmentUrl =
    probeSegmentUrl ||
    firstSegmentUrl(rewritten, new URL(sourceUrl), pathPrefix, segAuth);

  if (masterDev) {
    if (segmentUrl) {
      const status = await probeUrl(segmentUrl, parsed);
      if (status === 403 || status === 401) {
        throw new Error(
          probeSegmentUrl
            ? "Segment auth failed (403). Copy a fresh .ts segment curl from DevTools while the video is playing — signed URLs expire in ~15 minutes."
            : "master.dev blocks direct segment downloads. Copy a .ts segment request (not index.m3u8) from DevTools Network tab while the video plays."
        );
      }
    }
  } else {
    if (segmentUrl) {
      const status = await probeUrl(segmentUrl, parsed);
      if (status === 403 || status === 401) {
        throw new Error(
          "Video segments are blocked (auth expired or invalid). Copy a fresh curl while the video is playing."
        );
      }
      if (status !== 200 && status !== 206) {
        throw new Error(`Video segments are unreachable (HTTP ${status || "error"}).`);
      }
    }
  }

  // ffmpeg does not reliably pass -headers to HLS segments from local .m3u8.
  // Use remote playlist URL when no path/auth rewriting is needed.
  const prepared = {
    inputUrl: sourceUrl,
    cleanup: null,
    playlistBody: body,
    playlistUrl: sourceUrl,
  };

  if (!pathPrefix && !segAuth) {
    return prepared;
  }

  const tmpPath = path.join(
    DOWNLOADS_DIR,
    `playlist-${crypto.randomBytes(6).toString("hex")}.m3u8`
  );
  fs.writeFileSync(tmpPath, rewritten);
  prepared.inputUrl = tmpPath;
  prepared.cleanup = tmpPath;
  return prepared;
}

// ---------------------------------------------------------------------------
// API: Start download
// ---------------------------------------------------------------------------
const MAX_CONCURRENT = 2;
const downloadQueue = [];

function processQueue() {
  const running = [...activeJobs.values()].filter((j) => j.status === "downloading").length;
  while (running + downloadQueue.length > 0 && downloadQueue.length > 0) {
    const currentRunning = [...activeJobs.values()].filter((j) => j.status === "downloading").length;
    if (currentRunning >= MAX_CONCURRENT) break;
    const next = downloadQueue.shift();
    if (next) next();
  }
}

app.post("/api/download", async (req, res) => {
  const { input, filename, speed } = req.body;
  if (!input) return res.status(400).json({ error: "No input provided" });

  const parsed = parseCurlCommand(input);
  if (!parsed.url) return res.status(400).json({ error: "Could not extract URL from input" });

  // Clamp speed: 1 = real-time (safest), up to 3x
  const readRate = Math.max(0.5, Math.min(parseFloat(speed) || 1, 3));

  const jobId = crypto.randomBytes(6).toString("hex");
  const outName = (filename || `stream-${jobId}`) + ".mp4";
  const outPath = path.join(DOWNLOADS_DIR, outName);

  const job = {
    id: jobId,
    filename: outName,
    status: "queued",
    progress: "",
    speed: "",
    readRate,
    error: null,
    startedAt: Date.now(),
  };
  activeJobs.set(jobId, job);

  if (isBrowserDownloadStream(parsed.url)) {
    function startBrowserJob() {
      job.status = "downloading";
      job.startedAt = Date.now();
      job.progress = "browser";
      downloadMasterDevVideo(parsed, outPath, (msg) => {
        job.progress = msg;
      })
        .then(() => {
          const stats = fs.statSync(outPath);
          job.status = "done";
          job.fileSize = stats.size;
          job.progress = "complete";
          processQueue();
        })
        .catch((err) => {
          job.status = "error";
          job.error = String(err.message || err);
          processQueue();
        });
    }

    const running = [...activeJobs.values()].filter((j) => j.status === "downloading").length;
    if (running < MAX_CONCURRENT) startBrowserJob();
    else downloadQueue.push(startBrowserJob);

    return res.json({ jobId, filename: outName, readRate, mode: "browser" });
  }

  let prepared;
  try {
    prepared = await prepareHlsInput(parsed);
  } catch (err) {
    activeJobs.delete(jobId);
    const msg = String(err.message || err);
    const hint = /403|401/.test(msg)
      ? " Copy a fresh curl from your browser while the video is playing."
      : "";
    return res.status(400).json({ error: `Could not fetch playlist: ${msg}.${hint}` });
  }

  if (isFrontendMastersStream(parsed.url)) {
    function startParallelJob() {
      job.status = "downloading";
      job.startedAt = Date.now();
      job.abortController = new AbortController();

      downloadFrontendMastersParallel(parsed, outPath, prepared, {
        readRate,
        signal: job.abortController.signal,
        onProgress: (info) => {
          if (info.phase === "mux") {
            job.progress = "Muxing…";
            return;
          }
          job.progress = `${info.done}/${info.total} segments`;
          if (info.speed) job.speed = info.speed;
        },
      })
        .then(() => {
          const stats = fs.statSync(outPath);
          job.status = "done";
          job.fileSize = stats.size;
          job.progress = "complete";
          processQueue();
        })
        .catch((err) => {
          if (job.status === "cancelled") return;
          job.status = "error";
          job.error = String(err.message || err);
          processQueue();
        });
    }

    const running = [...activeJobs.values()].filter((j) => j.status === "downloading").length;
    if (running < MAX_CONCURRENT) startParallelJob();
    else downloadQueue.push(startParallelJob);

    return res.json({ jobId, filename: outName, readRate, mode: "parallel" });
  }

  function buildFfmpegArgs(inputUrl) {
    const headerParts = [];
    for (const [k, v] of Object.entries(parsed.headers)) {
      if (/^sec-|^accept$|^accept-language$|^priority$/i.test(k)) continue;
      headerParts.push(`${k}: ${v}`);
    }
    if (parsed.cookies) {
      headerParts.push(`Cookie: ${parsed.cookies}`);
    }

    const ffmpegArgs = [];
    if (!/^https?:\/\//i.test(inputUrl)) {
      ffmpegArgs.push("-protocol_whitelist", "file,http,https,tcp,tls,crypto");
    }
    if (headerParts.length) {
      ffmpegArgs.push("-headers", headerParts.map((h) => h + "\r\n").join(""));
    }
    ffmpegArgs.push(
      "-readrate",
      String(readRate),
      "-i",
      inputUrl,
      "-c",
      "copy",
      "-bsf:a",
      "aac_adtstoasc",
      "-movflags",
      "+faststart",
      "-y",
      outPath
    );
    return ffmpegArgs;
  }

  function startJob() {
    job.status = "downloading";
    job.startedAt = Date.now();

    const proc = spawn("ffmpeg", buildFfmpegArgs(prepared.inputUrl), {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const timeMatch = stderr.match(/time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/g);
      if (timeMatch) job.progress = timeMatch[timeMatch.length - 1].replace("time=", "");
      const speedMatch = stderr.match(/speed=\s*([^\s]+)/g);
      if (speedMatch) job.speed = speedMatch[speedMatch.length - 1].replace("speed=", "").trim();
      if (!job.progress && /Opening 'crypto/i.test(stderr)) {
        job.progress = "Fetching segments…";
      }
    });

    proc.on("close", (code) => {
      if (prepared.cleanup) {
        try {
          fs.unlinkSync(prepared.cleanup);
        } catch {
          // ignore
        }
      }
      if (code === 0) {
        const stats = fs.statSync(outPath);
        job.status = "done";
        job.fileSize = stats.size;
      } else {
        job.status = "error";
        const tail = stderr.slice(-500);
        job.error = /403 Forbidden/i.test(tail)
          ? "Access denied (403). The stream URL or cookies may have expired — copy a fresh curl from your browser while the video is playing."
          : /Unable to open resource|Invalid data found|loading first segment/i.test(tail)
            ? "Could not fetch video segments. Copy a fresh curl while the video is playing — signed URLs expire quickly."
            : tail;
      }
      processQueue();
    });

    proc.on("error", (err) => {
      job.status = "error";
      job.error = err.message;
      processQueue();
    });

    job.proc = proc;
  }

  const running = [...activeJobs.values()].filter((j) => j.status === "downloading").length;
  if (running < MAX_CONCURRENT) {
    startJob();
  } else {
    downloadQueue.push(startJob);
  }

  res.json({ jobId, filename: outName, readRate });
});

// ---------------------------------------------------------------------------
// API: Download entire course from a single course URL
// ---------------------------------------------------------------------------
function runCourseJob(job, authParsed) {
  job.status = "downloading";
  job.startedAt = Date.now();
  job.error = null;
  job.abortController = new AbortController();

  const match = job.courseUrl.match(/\/courses\/([^/]+)/);
  if (match) {
    const slug = match[1];
    job.courseSlug = slug;
    const dir = path.join(DOWNLOADS_DIR, slug);
    if (fs.existsSync(dir)) {
      job.files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".mp4"))
        .sort()
        .map((filename) => ({
          filename,
          downloadUrl: `/downloads/${slug}/${filename}`,
          fileSize: fs.statSync(path.join(dir, filename)).size,
        }));
      job.lessonIndex = job.files.length;
    }
  }

  downloadCourse(authParsed, job.courseUrl, {
    prepareHlsInput,
    normalizeParsedInput,
    downloadsDir: DOWNLOADS_DIR,
  }, {
    readRate: job.readRate,
    signal: job.abortController.signal,
    onLessonComplete: (entry) => {
      const idx = job.files.findIndex((f) => f.filename === entry.filename);
      if (idx >= 0) job.files[idx] = entry;
      else job.files.push(entry);
      job.files.sort((a, b) => a.filename.localeCompare(b.filename));
      job.lessonIndex = job.files.length;
    },
    onProgress: (info) => {
      if (info.courseTitle) job.courseTitle = info.courseTitle;
      if (info.lessonTotal) job.lessonTotal = info.lessonTotal;
      if (info.phase === "discover") {
        job.progress = info.message;
        return;
      }
      job.lessonIndex = info.lessonIndex || job.lessonIndex;
      job.lessonTotal = info.lessonTotal || job.lessonTotal;
      job.progress = info.message || job.progress;
      if (info.speed) job.speed = info.speed;
    },
  })
    .then((result) => {
      job.status = "done";
      job.courseTitle = result.courseTitle;
      job.courseSlug = result.courseSlug;
      job.files = result.lessons;
      job.lessonTotal = result.lessons.length;
      job.lessonIndex = result.lessons.length;
      job.progress = `${result.lessons.length} lessons`;
      job.fileSize = result.lessons.reduce((sum, f) => sum + f.fileSize, 0);
      processQueue();
    })
    .catch((err) => {
      if (job.status === "cancelled") return;
      job.status = "error";
      const msg = String(err.message || err);
      job.error = /429/.test(msg)
        ? "Frontend Masters API rate limit (429). Wait 1–2 minutes, then click Retry — completed lessons are skipped."
        : msg;
      processQueue();
    });
}

app.post("/api/download-course", async (req, res) => {
  const { courseUrl, input, speed } = req.body;
  if (!courseUrl) return res.status(400).json({ error: "No course URL provided" });
  if (!input) {
    return res.status(400).json({
      error: "Paste a curl from DevTools (any index.m3u8) so we can use your login cookies.",
    });
  }

  const authParsed = parseCurlCommand(input);
  if (!authParsed.cookies || !/fem_auth_mod=/.test(authParsed.cookies)) {
    return res.status(400).json({
      error: "Curl must include fem_auth_mod — copy it while logged in on frontendmasters.com.",
    });
  }
  if (!/FM_EMCS=/.test(authParsed.cookies)) {
    return res.status(400).json({
      error: "Curl must include FM_EMCS — copy the full -b cookie line while a video is playing.",
    });
  }

  const readRate = Math.max(0.5, Math.min(parseFloat(speed) || 1, 3));
  const jobId = crypto.randomBytes(6).toString("hex");

  const job = {
    id: jobId,
    filename: `course-${jobId}`,
    status: "queued",
    progress: "",
    speed: "",
    readRate,
    error: null,
    startedAt: Date.now(),
    mode: "course",
    courseUrl,
    courseTitle: "",
    lessonIndex: 0,
    lessonTotal: 0,
    files: [],
    authInput: input,
  };
  activeJobs.set(jobId, job);

  const running = [...activeJobs.values()].filter((j) => j.status === "downloading").length;
  if (running < MAX_CONCURRENT) runCourseJob(job, authParsed);
  else downloadQueue.push(() => runCourseJob(job, authParsed));

  res.json({ jobId, mode: "course", readRate });
});

app.post("/api/retry/:id", (req, res) => {
  const job = activeJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.mode !== "course") return res.status(400).json({ error: "Retry is only for course downloads" });
  if (job.status !== "error" && job.status !== "cancelled") {
    return res.status(400).json({ error: "Job is not in a retryable state" });
  }

  const input = req.body?.input || job.authInput;
  if (!input) return res.status(400).json({ error: "Paste a fresh curl, then click Retry" });

  const authParsed = parseCurlCommand(input);
  if (!authParsed.cookies || !/fem_auth_mod=/.test(authParsed.cookies)) {
    return res.status(400).json({ error: "Curl must include fem_auth_mod cookie" });
  }

  job.authInput = input;
  job.error = null;
  job.progress = "Resuming…";

  const running = [...activeJobs.values()].filter((j) => j.status === "downloading").length;
  if (running < MAX_CONCURRENT) runCourseJob(job, authParsed);
  else downloadQueue.push(() => runCourseJob(job, authParsed));

  res.json({ ok: true, jobId: job.id });
});

// ---------------------------------------------------------------------------
// API: Job status
// ---------------------------------------------------------------------------
app.get("/api/status/:id", (req, res) => {
  const job = activeJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });

  const result = {
    id: job.id,
    filename: job.filename,
    status: job.status,
    progress: job.progress,
    speed: job.speed,
    readRate: job.readRate,
    error: job.error,
    elapsed: Math.round((Date.now() - job.startedAt) / 1000),
    mode: job.mode || "single",
  };

  if (job.mode === "course") {
    result.courseTitle = job.courseTitle;
    result.courseSlug = job.courseSlug;
    result.lessonIndex = job.lessonIndex;
    result.lessonTotal = job.lessonTotal;
    result.canRetry = job.status === "error" || job.status === "cancelled";
    if (job.files?.length) result.files = job.files;
  }

  if (job.status === "done" && job.mode !== "course") {
    result.fileSize = job.fileSize;
    result.downloadUrl = `/downloads/${job.filename}`;
  }

  if (job.status === "done" && job.mode === "course") {
    result.fileSize = job.fileSize;
  }

  res.json(result);
});

// ---------------------------------------------------------------------------
// API: Cancel
// ---------------------------------------------------------------------------
app.post("/api/cancel/:id", (req, res) => {
  const job = activeJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.abortController) job.abortController.abort(new Error("cancelled"));
  if (job.proc) job.proc.kill("SIGTERM");
  job.status = "cancelled";
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`HLS Downloader running at http://localhost:${PORT}`);
});
