const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { downloadFrontendMastersParallel } = require("./fm-parallel");

function buildFetchHeaders(parsed) {
  const headers = { Accept: "application/json", ...parsed.headers };
  delete headers["content-length"];
  delete headers["Content-Length"];
  if (parsed.cookies) headers.Cookie = parsed.cookies;
  return headers;
}

function fetchTextOnce(url, parsed) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { headers: buildFetchHeaders(parsed) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchTextOnce(new URL(res.headers.location, url).toString(), parsed)
          .then(resolve)
          .catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        const err = new Error(`HTTP ${res.statusCode} fetching ${url}`);
        err.statusCode = res.statusCode;
        err.url = url;
        const retryAfter = Number(res.headers["retry-after"]);
        if (retryAfter > 0) err.retryAfter = retryAfter;
        reject(err);
        return;
      }
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
  });
}

async function fetchText(url, parsed, options = {}) {
  const { retries = 0, onRetry } = options;
  let attempt = 0;
  while (true) {
    try {
      return await fetchTextOnce(url, parsed);
    } catch (err) {
      const retryable = err.statusCode === 429 || err.statusCode === 503;
      if (!retryable || attempt >= retries) throw err;
      attempt += 1;
      const waitMs = Math.max(
        (err.retryAfter || 0) * 1000,
        Math.min(60000, 2000 * Math.pow(2, attempt))
      );
      onRetry?.({ attempt, waitMs, statusCode: err.statusCode });
      await sleep(waitMs);
    }
  }
}

async function fetchJson(url, parsed, options = {}) {
  return JSON.parse(await fetchText(url, parsed, options));
}

function parseCourseUrl(courseUrl) {
  let u;
  try {
    u = new URL(courseUrl.trim());
  } catch {
    throw new Error("Invalid course URL");
  }
  const match = u.pathname.match(/\/courses\/([^/]+)\/?/);
  if (!match) {
    throw new Error("URL must be like https://frontendmasters.com/courses/my-course/ or https://master.dev/courses/my-course/");
  }
  const isFm = /^(www\.)?frontendmasters\.com$/i.test(u.hostname);
  const isMd = /^(www\.)?master\.dev$/i.test(u.hostname);
  if (!isFm && !isMd) {
    throw new Error("Batch download supports frontendmasters.com and master.dev only");
  }
  return {
    slug: match[1],
    siteHost: isFm ? "frontendmasters.com" : "master.dev",
    apiHost: isFm ? "api.frontendmasters.com" : "api.master.dev",
  };
}

function apiParsed(authParsed, courseMeta, courseSlug, lessonSlug) {
  const { siteHost } = courseMeta;
  const referer = lessonSlug
    ? `https://${siteHost}/courses/${courseSlug}/${lessonSlug}/`
    : `https://${siteHost}/courses/${courseSlug}/`;
  return {
    ...authParsed,
    headers: {
      ...authParsed.headers,
      Accept: "application/json",
      origin: `https://${siteHost}`,
      referer,
    },
  };
}

function lessonAuthParsed(authParsed, m3u8Url, courseMeta, courseSlug, lessonSlug) {
  const { siteHost } = courseMeta;
  return {
    url: m3u8Url,
    headers: {
      ...authParsed.headers,
      origin: `https://${siteHost}`,
      referer: `https://${siteHost}/courses/${courseSlug}/${lessonSlug}/`,
    },
    cookies: authParsed.cookies,
    authQuery: "",
    signatureExpired: false,
  };
}

function formatApiError(err, lesson, siteHost) {
  const site = siteHost || "frontendmasters.com";
  if (err.statusCode === 401) {
    const title = lesson?.title ? ` (“${lesson.title}”)` : "";
    return (
      `Not authorized for lesson${title} (HTTP 401). ` +
      `Open that lesson on ${site} while logged in, copy a fresh curl ` +
      `(must include fem_auth_mod and FM_EMCS), then Retry.`
    );
  }
  if (err.statusCode === 429) {
    return "API rate limit (429). Wait 1–2 minutes, then Retry.";
  }
  return err.message || String(err);
}

async function discoverLessons(authParsed, courseMeta, onRetry) {
  const { slug, apiHost } = courseMeta;
  const data = await fetchJson(
    `https://${apiHost}/v2/kabuki/courses/${slug}`,
    apiParsed(authParsed, courseMeta, slug),
    { retries: 4, onRetry }
  );

  const lessons = [];
  for (const lessonSlug of data.lessonSlugs || []) {
    const lesson = Object.values(data.lessonData || {}).find((l) => l.slug === lessonSlug);
    if (!lesson?.hash) continue;
    lessons.push({ slug: lessonSlug, title: lesson.title, hash: lesson.hash });
  }

  if (!lessons.length) {
    throw new Error("No lessons found — paste a curl with fem_auth_mod while logged in.");
  }
  return { title: data.title || slug, slug, lessons };
}

async function fetchLessonM3u8(authParsed, courseMeta, lesson, onRetry) {
  const { slug, apiHost, siteHost } = courseMeta;
  try {
    const source = await fetchJson(
      `https://${apiHost}/v2/kabuki/video/${lesson.hash}/source?f=m3u8`,
      apiParsed(authParsed, courseMeta, slug, lesson.slug),
      { retries: 12, onRetry }
    );
    if (!source?.url) throw new Error(`No stream URL for lesson: ${lesson.title}`);
    return source.url;
  } catch (err) {
    throw new Error(formatApiError(err, lesson, siteHost));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastKabukiApiAt = 0;
async function throttleKabukiApi() {
  const gap = 4500;
  const elapsed = Date.now() - lastKabukiApiAt;
  if (lastKabukiApiAt > 0 && elapsed < gap) await sleep(gap - elapsed);
  lastKabukiApiAt = Date.now();
}

function lessonOutputName(index, lesson) {
  return `${String(index).padStart(2, "0")}-${lesson.slug}.mp4`;
}

function existingLessonFile(courseDir, index, lesson) {
  const outPath = path.join(courseDir, lessonOutputName(index, lesson));
  if (!fs.existsSync(outPath)) return null;
  const size = fs.statSync(outPath).size;
  if (size < 100_000) return null;
  return { outPath, size };
}

async function downloadCourse(authParsed, courseUrl, deps, options = {}) {
  const { prepareHlsInput, normalizeParsedInput, downloadsDir, downloadMasterDevVideo } = deps;
  const { onProgress, onLessonComplete, readRate = 2, signal } = options;

  const courseMeta = parseCourseUrl(courseUrl);
  const isMasterDev = courseMeta.siteHost === "master.dev";
  onProgress?.({ phase: "discover", message: "Fetching lesson list…" });

  const onApiRetry = (info) => {
    onProgress?.({
      phase: "discover",
      message: `API rate limit (${info.statusCode}) — retrying in ${Math.ceil(info.waitMs / 1000)}s…`,
    });
  };

  const { title, slug, lessons } = await discoverLessons(authParsed, courseMeta, onApiRetry);
  onProgress?.({
    phase: "discover",
    courseTitle: title,
    lessonTotal: lessons.length,
    message: `Found ${lessons.length} lessons in “${title}”`,
  });

  const courseDir = path.join(downloadsDir, slug);
  fs.mkdirSync(courseDir, { recursive: true });

  const completed = [];

  for (let i = 0; i < lessons.length; i++) {
    if (signal?.aborted) throw new Error("cancelled");

    const lesson = lessons[i];
    const index = i + 1;
    const outName = lessonOutputName(index, lesson);
    const outPath = path.join(courseDir, outName);

    const existing = existingLessonFile(courseDir, index, lesson);
    if (existing) {
      const entry = {
        slug: lesson.slug,
        title: lesson.title,
        filename: outName,
        downloadUrl: `/downloads/${slug}/${outName}`,
        fileSize: existing.size,
      };
      completed.push(entry);
      onLessonComplete?.(entry);
      onProgress?.({
        phase: "lesson",
        lessonIndex: index,
        lessonTotal: lessons.length,
        message: `Lesson ${index}/${lessons.length}: ${lesson.title} (skipped — already downloaded)`,
      });
      continue;
    }

    onProgress?.({
      phase: "lesson",
      lessonIndex: index,
      lessonTotal: lessons.length,
      message: `Lesson ${index}/${lessons.length}: ${lesson.title}${isMasterDev ? " (browser…)" : " (resolving stream…)"}`,
    });

    if (isMasterDev) {
      if (!downloadMasterDevVideo) {
        throw new Error("master.dev browser downloader not configured");
      }
      const lessonPageUrl = `https://master.dev/courses/${slug}/${lesson.slug}/`;
      await downloadMasterDevVideo(authParsed, outPath, (msg) => {
        onProgress?.({
          phase: "segments",
          lessonIndex: index,
          lessonTotal: lessons.length,
          message: `Lesson ${index}/${lessons.length}: ${msg}`,
        });
      }, {
        coursePageUrl: lessonPageUrl,
        videoHash: lesson.hash,
        signal,
      });
    } else {
      await throttleKabukiApi();

      const lessonApiRetry = (info) => {
        onProgress?.({
          phase: "lesson",
          lessonIndex: index,
          lessonTotal: lessons.length,
          message: `Lesson ${index}/${lessons.length}: rate limited — retry in ${Math.ceil(info.waitMs / 1000)}s…`,
        });
      };

      const m3u8Url = await fetchLessonM3u8(authParsed, courseMeta, lesson, lessonApiRetry);

      onProgress?.({
        phase: "lesson",
        lessonIndex: index,
        lessonTotal: lessons.length,
        message: `Lesson ${index}/${lessons.length}: ${lesson.title}`,
      });

      let lessonParsed = lessonAuthParsed(authParsed, m3u8Url, courseMeta, slug, lesson.slug);
      if (normalizeParsedInput) lessonParsed = normalizeParsedInput(lessonParsed);

      const prepared = await prepareHlsInput(lessonParsed);

      await downloadFrontendMastersParallel(lessonParsed, outPath, prepared, {
        readRate,
        signal,
        onProgress: (info) => {
          if (info.phase === "mux") {
            onProgress?.({
              phase: "mux",
              lessonIndex: index,
              lessonTotal: lessons.length,
              message: `Lesson ${index}/${lessons.length}: Muxing…`,
            });
            return;
          }
          onProgress?.({
            phase: "segments",
            lessonIndex: index,
            lessonTotal: lessons.length,
            speed: info.speed,
            message: `Lesson ${index}/${lessons.length}: ${info.done}/${info.total} segments`,
          });
        },
      });
    }

    const entry = {
      slug: lesson.slug,
      title: lesson.title,
      filename: outName,
      downloadUrl: `/downloads/${slug}/${outName}`,
      fileSize: fs.statSync(outPath).size,
    };
    completed.push(entry);
    onLessonComplete?.(entry);
  }

  return { courseTitle: title, courseSlug: slug, lessons: completed };
}

module.exports = { parseCourseUrl, discoverLessons, downloadCourse };
