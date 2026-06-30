const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

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
    return { url: input, headers: {}, cookies: "" };
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

  return { url, headers, cookies };
}

// ---------------------------------------------------------------------------
// API: Start download
// ---------------------------------------------------------------------------
app.post("/api/download", (req, res) => {
  const { input, filename } = req.body;
  if (!input) return res.status(400).json({ error: "No input provided" });

  const parsed = parseCurlCommand(input);
  if (!parsed.url) return res.status(400).json({ error: "Could not extract URL from input" });

  const jobId = crypto.randomBytes(6).toString("hex");
  const outName = (filename || `stream-${jobId}`) + ".mp4";
  const outPath = path.join(DOWNLOADS_DIR, outName);

  // Build ffmpeg header string
  const headerParts = [];
  for (const [k, v] of Object.entries(parsed.headers)) {
    if (/^sec-|^accept$|^accept-language$/i.test(k)) continue; // skip browser-only headers
    headerParts.push(`${k}: ${v}`);
  }
  if (parsed.cookies) {
    headerParts.push(`Cookie: ${parsed.cookies}`);
  }

  const ffmpegArgs = [];
  if (headerParts.length) {
    ffmpegArgs.push("-headers", headerParts.map((h) => h + "\r\n").join(""));
  }
  ffmpegArgs.push(
    "-i", parsed.url,
    "-c", "copy",
    "-bsf:a", "aac_adtstoasc",
    "-movflags", "+faststart",
    "-y",
    outPath
  );

  const proc = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "pipe", "pipe"] });

  const job = {
    id: jobId,
    filename: outName,
    status: "downloading",
    progress: "",
    error: null,
    startedAt: Date.now(),
  };
  activeJobs.set(jobId, job);

  let stderr = "";
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    // Parse last time= line for progress
    const timeMatch = stderr.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/g);
    if (timeMatch) job.progress = timeMatch[timeMatch.length - 1].replace("time=", "");
    // Parse speed
    const speedMatch = stderr.match(/speed=\s*([^\s]+)/g);
    if (speedMatch) job.speed = speedMatch[speedMatch.length - 1].replace("speed=", "").trim();
  });

  proc.on("close", (code) => {
    if (code === 0) {
      const stats = fs.statSync(outPath);
      job.status = "done";
      job.fileSize = stats.size;
    } else {
      job.status = "error";
      job.error = stderr.slice(-500);
    }
  });

  proc.on("error", (err) => {
    job.status = "error";
    job.error = err.message;
  });

  job.proc = proc;

  res.json({ jobId, filename: outName });
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
    error: job.error,
    elapsed: Math.round((Date.now() - job.startedAt) / 1000),
  };

  if (job.status === "done") {
    result.fileSize = job.fileSize;
    result.downloadUrl = `/downloads/${job.filename}`;
  }

  res.json(result);
});

// ---------------------------------------------------------------------------
// API: Cancel
// ---------------------------------------------------------------------------
app.post("/api/cancel/:id", (req, res) => {
  const job = activeJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.proc) job.proc.kill("SIGTERM");
  job.status = "cancelled";
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`HLS Downloader running at http://localhost:${PORT}`);
});
