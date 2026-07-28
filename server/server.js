/* ==========================================================================
   VID VORTEX — server.js

   Why this exists: a browser cannot fetch a TikTok/Instagram/Facebook video
   directly. Those sites send no CORS headers, and the real MP4 sits behind a
   signed, expiring URL. So the resolving has to happen server-side.

   This wraps yt-dlp behind two endpoints:
     GET /api/info?url=...              -> metadata as JSON
     GET /api/download?url=...&format=  -> the file itself, streamed

   The stream is proxied through this server rather than handing the CDN URL to
   the browser, because those URLs are header-locked and hotlink-protected, and
   because only we can set Content-Disposition so phones actually save the file.
   ========================================================================== */

"use strict";

const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const os = require("os");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
// yt-dlp finds ffmpeg on PATH by itself; only point it somewhere else if this
// deployment has, in which case the merge must use the same binary the MP3
// route does. Passing a bare "ffmpeg" here would be read as a path and fail.
const FFMPEG_LOCATION = process.env.FFMPEG_PATH || null;
const GALLERYDL = process.env.GALLERYDL_PATH || "gallery-dl";

/* --------------------------------------------------------------------------
   IG_COOKIES -- optional, and the difference between the photo route working
   and not.

   Instagram serves no photo media to logged-out clients: the post page returns
   200 but carries no image URL, because the media is fetched client-side from
   a login-walled API. gallery-dl hits that same API, so without a session it
   gets the same nothing.

   Set IG_COOKIES to the contents of a Netscape cookies.txt exported from a
   logged-in session and the photo route starts working. Leave it unset and
   photo posts fail with a clear message -- video is unaffected either way.

   Use a burner account. This fires from a datacenter IP, which Instagram
   treats as an automation signal, and the account can be banned for it.
   -------------------------------------------------------------------------- */

const COOKIE_FILE = (() => {
  const raw = process.env.IG_COOKIES || "";
  if (!raw.trim()) return null;
  const file = path.join(os.tmpdir(), "ig-cookies.txt");
  // Env vars usually can't hold real newlines, so accept escaped ones too.
  // 0600: the container runs as `node`, but don't leave a session readable.
  fs.writeFileSync(file, raw.replace(/\\n/g, "\n").trim() + "\n", { mode: 0o600 });
  return file;
})();

/* --------------------------------------------------------------------------
   SECURITY: host allowlist

   This is the single most important part of the file. `url` is user input that
   gets handed to yt-dlp, which will happily fetch damn near any protocol or
   address. Without a strict allowlist this endpoint is an SSRF hole: someone
   passes http://169.254.169.254/ (cloud metadata) or file:///etc/passwd and we
   fetch it for them from inside the host's network.

   So: parse the URL properly, require http(s), and match the hostname against
   an exact-suffix allowlist. Note `endsWith('.' + base)` rather than
   `includes(base)` -- the latter would happily accept `evil-tiktok.com.attacker.net`.
   -------------------------------------------------------------------------- */

const PLATFORMS = {
  tiktok: { name: "TikTok", hosts: ["tiktok.com"] },
  instagram: { name: "Instagram", hosts: ["instagram.com"] },
  facebook: { name: "Facebook", hosts: ["facebook.com", "fb.watch", "fb.com"] },
  youtube: { name: "YouTube", hosts: ["youtube.com", "youtu.be", "youtube-nocookie.com"] }
};

/** Returns the platform key for a URL, or null if it isn't one we allow. */
function classify(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null; // not a parseable absolute URL
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;

  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  for (const [key, p] of Object.entries(PLATFORMS)) {
    for (const base of p.hosts) {
      if (host === base || host.endsWith("." + base)) return key;
    }
  }
  return null;
}

/* --------------------------------------------------------------------------
   Rate limiting -- a tiny in-memory fixed window.

   Deliberately not a dependency: this runs as a single instance on a free tier,
   so a Map is enough. If you ever scale past one instance, swap in Redis --
   this counter is per-process and each instance would get its own budget.
   -------------------------------------------------------------------------- */

const WINDOW_MS = 60_000;
const MAX_HITS = 20;
const hits = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const now = Date.now();
  const rec = hits.get(ip);

  if (!rec || now > rec.reset) {
    hits.set(ip, { count: 1, reset: now + WINDOW_MS });
    return next();
  }
  if (rec.count >= MAX_HITS) {
    const retry = Math.ceil((rec.reset - now) / 1000);
    res.set("Retry-After", String(retry));
    return res.status(429).json({ error: `Too many requests. Try again in ${retry}s.` });
  }
  rec.count++;
  next();
}

// Keep the Map from growing forever on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits) if (now > rec.reset) hits.delete(ip);
}, WINDOW_MS).unref();

/* --------------------------------------------------------------------------
   yt-dlp helpers
   -------------------------------------------------------------------------- */

/* --------------------------------------------------------------------------
   Format selectors

   Every video request asks for the best video stream plus the best audio
   stream and lets ffmpeg mux the pair into an MP4 -- `bv*+ba/b` in yt-dlp's
   language, with a compatibility-first chain in front of it.

   Why this and not `best`: `best` means "best stream that already has audio in
   it". On TikTok/IG/FB that is the full-quality file, but on YouTube the only
   muxed stream is itag 18 (640x360) -- everything above it is video-only DASH,
   so `best[height<=1080]` silently hands back 360p. Asking for bv*+ba is the
   only way to get the real thing, and the merge is not optional: the 1080p
   stream carries no audio track at all, so an unmerged file is silent.

   Why a chain and not the bare selector: `bv*+ba` on its own will happily pick
   VP9/AV1 video and Opus audio, which are smaller but which older phones and
   stock players won't open -- the point of this site is a file that just
   plays. So H.264+AAC is asked for first, the bare `bv*+ba` sits behind it so
   anything without an avc1/m4a pair still resolves at full quality, and the
   final `b` covers sites that publish one progressive stream and no separate
   audio track to merge (TikTok, most of Instagram).

   `bv*` rather than `bestvideo`: the starred form also considers streams that
   already carry audio, so a progressive-only site still has a candidate rather
   than falling through the whole chain.

   The cost of putting compatibility first is real and worth knowing: YouTube
   publishes nothing above 1080p in H.264, so a 4K upload comes down as 1080p.
   Set MAX_QUALITY=1 to reverse the preference -- pure `bv*+ba/b`, highest
   resolution wins, codec be damned. Everything still ends up in an MP4; some
   older players just won't open a VP9/AV1 one.
   -------------------------------------------------------------------------- */

const MAX_QUALITY = /^(1|true|yes)$/i.test(process.env.MAX_QUALITY || "");

const BEST_VIDEO = (MAX_QUALITY
  ? [
      "bv*+ba",                                 // highest resolution, any codec
      "b"
    ]
  : [
      "bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]", // H.264 + AAC: plays everywhere
      "bv*[ext=mp4]+ba[ext=m4a]",
      "bv*+ba",                                 // best of anything, merged
      "b[ext=mp4]",
      "b"                                       // single progressive stream
    ]
).join("/");

/* Same shape, capped: `sd` exists so someone on a metered connection can take
   a smaller file, so the cap has to come before quality -- but it still merges
   audio in, and it still falls through to a merge-free stream if the site has
   nothing under the cap. */
const SD_VIDEO = [
  "bv*[height<=480][ext=mp4][vcodec^=avc1]+ba[ext=m4a]",
  "bv*[height<=480][ext=mp4]+ba[ext=m4a]",
  "bv*[height<=480]+ba",
  "b[height<=480][ext=mp4]",
  "b[height<=480]",
  "wv*+ba",
  "w"
].join("/");

const FORMATS = {
  hd: BEST_VIDEO,
  sd: SD_VIDEO,
  mp3: "bestaudio/best"
};

/** Run yt-dlp and buffer stdout. Used for metadata only, never for the video. */
function ytdlpJson(url, timeoutMs = 25_000) {
  return new Promise((resolve, reject) => {
    // Args as an array + no shell: the URL can never be interpreted as a command.
    const child = spawn(YTDLP, [
      "-J",
      "--no-playlist",
      "--no-warnings",
      "--socket-timeout", "15",
      url
    ]);

    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Timed out reading that link."));
    }, timeoutMs);

    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("yt-dlp is not installed on the server."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const e = new Error(friendlyError(err));
        // Keep the raw text: /api/info reads it to tell "this is a photo post"
        // apart from a genuine failure. friendlyError() flattens that away.
        e.stderr = err;
        return reject(e);
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error("Could not read that video's details."));
      }
    });
  });
}

/* --------------------------------------------------------------------------
   Photo posts (gallery-dl)
   -------------------------------------------------------------------------- */

/** yt-dlp's exact words when a post parsed fine but holds only images. */
const NO_VIDEO_RE = /there is no video in this post/i;

/**
 * Instagram serves photo media from these CDNs. gallery-dl's output is not
 * user input, but it is derived from a user-supplied URL, and this process
 * will fetch whatever comes back -- so pin the destination the same way
 * classify() pins the source. Without this, a hostile extractor result turns
 * the photo route into the SSRF hole the host allowlist exists to prevent.
 */
const MEDIA_HOSTS = ["cdninstagram.com", "fbcdn.net"];

function isAllowedMedia(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return MEDIA_HOSTS.some((b) => host === b || host.endsWith("." + b));
}

/**
 * Direct media URLs for a post, in order.
 *
 * Uses `-g` (one URL per line) rather than --dump-json: a line-per-URL contract
 * is far harder to misread than gallery-dl's JSON message tuples, and the URL
 * is all this route needs.
 */
function galleryUrls(url, timeoutMs = 25_000) {
  return new Promise((resolve, reject) => {
    const args = ["-g", "--quiet"];
    if (COOKIE_FILE) args.push("--cookies", COOKIE_FILE);
    args.push(url); // array + no shell: never interpreted as a command

    const child = spawn(GALLERYDL, args);

    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Timed out reading that post."));
    }, timeoutMs);

    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("gallery-dl is not installed on the server."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const urls = out.split("\n").map((s) => s.trim()).filter(Boolean);

      if (code !== 0 || !urls.length) return reject(new Error(photoError(err)));

      const safe = urls.filter(isAllowedMedia);
      if (!safe.length) return reject(new Error("Couldn't read that post's photos."));
      resolve(safe);
    });
  });
}

/** Turn gallery-dl's stderr into something a visitor can act on. */
function photoError(stderr) {
  const s = (stderr || "").toLowerCase();
  if (s.includes("login") || s.includes("authentication") || s.includes("401") || s.includes("403")) {
    return COOKIE_FILE
      ? "Instagram rejected the saved session. The cookies have likely expired."
      : "Instagram needs a login to fetch photos. The server has no session configured.";
  }
  if (s.includes("not found") || s.includes("404")) return "That post doesn't exist or was removed.";
  if (s.includes("private")) return "That account is private.";
  return "Couldn't fetch that post's photos.";
}

/** Turn yt-dlp's stderr into something a visitor can act on. */
function friendlyError(stderr) {
  const s = (stderr || "").toLowerCase();
  if (s.includes("private") || s.includes("login") || s.includes("cookies")) {
    return "That video is private or needs a login.";
  }
  if (s.includes("not available") || s.includes("unavailable") || s.includes("removed")) {
    return "That video is unavailable or has been removed.";
  }
  if (s.includes("404") || s.includes("not found")) {
    return "That link doesn't point to a video.";
  }
  if (s.includes("unsupported url")) {
    return "That link isn't a supported video page.";
  }
  return "Couldn't fetch that video. Check the link and try again.";
}

const humanSize = (bytes) => {
  if (!bytes || bytes < 0) return null;
  const mb = bytes / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : mb.toFixed(1) + " MB";
};

const humanTime = (sec) => {
  if (!sec && sec !== 0) return null;
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  return String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
};

/** Strip characters that break Content-Disposition or filesystems. */
function safeFilename(title, ext) {
  const base = String(title || "video")
    .replace(/[\\/:*?"<>|\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "video";
  return `${base}.${ext}`;
}

/* --------------------------------------------------------------------------
   Middleware
   -------------------------------------------------------------------------- */

// Render/Railway/Fly sit behind a proxy; without this req.ip is the proxy's.
app.set("trust proxy", 1);

// ALLOWED_ORIGINS: comma-separated, e.g.
//   https://you.github.io,http://localhost:5500
// Leave unset to allow any origin (fine while testing; tighten for production).
const allowed = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowed.length ? allowed : true,
  methods: ["GET"]
}));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* --------------------------------------------------------------------------
   GET /api/info -- metadata for the result panel
   -------------------------------------------------------------------------- */

app.get("/api/info", rateLimit, async (req, res) => {
  const url = req.query.url;
  const platform = classify(url);

  if (!platform) {
    return res.status(400).json({ error: "Unsupported link. Use TikTok, Instagram, Facebook or YouTube." });
  }

  try {
    let info;
    try {
      info = await ytdlpJson(url);
    } catch (err) {
      // yt-dlp parsed the post and found only images. That isn't a failure --
      // it's the one case where the photo route can take over. Any other error
      // is a real error and still propagates.
      if (!NO_VIDEO_RE.test(err.stderr || "")) throw err;

      const photos = await galleryUrls(url);
      return res.json({
        kind: "photo",
        platform,
        platformName: PLATFORMS[platform].name,
        title: photos.length > 1 ? `${PLATFORMS[platform].name} photo carousel` : `${PLATFORMS[platform].name} photo`,
        count: photos.length,
        quality: photos.length > 1 ? `${photos.length} photos` : "Original",
        size: null,      // the CDN reports it per-image; not worth 10 HEAD requests
        duration: null,
        thumbnail: photos[0]
      });
    }

    // Prefer a real reported size; fall back to yt-dlp's estimate.
    const size = info.filesize || info.filesize_approx ||
      (info.formats || []).map((f) => f.filesize || f.filesize_approx || 0).sort((a, b) => b - a)[0];

    const height = info.height ||
      Math.max(0, ...(info.formats || []).map((f) => f.height || 0));

    res.json({
      kind: "video",
      platform,
      platformName: PLATFORMS[platform].name,
      title: info.title || info.description?.slice(0, 90) || "Untitled video",
      uploader: info.uploader || info.channel || null,
      duration: humanTime(info.duration),
      quality: height ? `${height}p${height >= 720 ? " • HD" : ""}` : "Best available",
      size: humanSize(size),
      thumbnail: info.thumbnail || null
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * Merge a video to a temp file, stream it, delete it. Every platform takes
 * this route -- see the note on the format selectors above: asking for the
 * best video *and* the best audio means two streams, and two streams have to
 * be muxed before anything can be handed to the browser.
 *
 * Why not stream straight to stdout: piping a merge to stdout does not produce
 * an MP4. MP4 has to seek back and write its header once the length is known,
 * and a pipe cannot seek -- so ffmpeg silently falls back to MPEG-TS and
 * yt-dlp emits a transport stream with an .mp4 name. Phones refuse to save
 * that, which defeats the point of the site.
 *
 * The cost is latency: nothing reaches the visitor until the merge finishes.
 * Disk is the cheap part -- a 1080p clip is tens of MB and the container's
 * /tmp is ephemeral anyway. The alternative (buffer in RAM) would not survive
 * a 512MB box.
 */
async function streamMerged(req, res, url, format, platform) {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-mux-"));
  } catch {
    return res.status(500).json({ error: "Server has no writable temp space." });
  }

  // %(ext)s, not a fixed .mp4: yt-dlp names the merged file itself, and
  // guessing wrong means streaming a file that isn't there.
  const template = path.join(dir, "video.%(ext)s");
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  };

  const args = [
    "-f", format,
    // The merge target. --remux-video covers the other half: when the chain
    // falls through to a single progressive stream there is nothing to merge,
    // and this is what turns a lone .webm into the .mp4 we promised.
    "--merge-output-format", "mp4",
    "--remux-video", "mp4",
    // DASH video arrives as hundreds of small fragments fetched one at a time,
    // which is latency-bound rather than bandwidth-bound. Pulling 8 at once is
    // most of the wall-clock win here, and it matters more than it used to now
    // that nothing reaches the visitor until the merge finishes.
    "--concurrent-fragments", "8",
    "--no-playlist",
    "--no-warnings",
    "--no-part",
    "--socket-timeout", "15"
  ];
  if (FFMPEG_LOCATION) args.push("--ffmpeg-location", FFMPEG_LOCATION);
  args.push("-o", template, url);

  const dl = spawn(YTDLP, args);

  let err = "";
  dl.stderr.on("data", (d) => { err += d; });

  // A merge is slow; give it far longer than a straight copy, but not forever.
  const timer = setTimeout(() => { dl.kill("SIGKILL"); }, 240_000);

  // Visitor cancelled before the merge finished — stop and bin the temp dir.
  res.on("close", () => {
    if (!dl.killed) dl.kill("SIGKILL");
    cleanup();
  });

  dl.on("error", () => {
    clearTimeout(timer);
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: "yt-dlp is not installed on the server." });
  });

  dl.on("close", (code) => {
    clearTimeout(timer);
    if (res.destroyed) return cleanup();

    if (code !== 0) {
      // Log the raw text: friendlyError() flattens every failure into the same
      // sentence, which is right for a visitor and useless when a merge breaks
      // in production and this is all you have.
      console.error(`[${platform}] yt-dlp exit ${code}: ${err.trim().split("\n").slice(-3).join(" | ")}`);
      cleanup();
      if (!res.headersSent) res.status(502).json({ error: friendlyError(err) });
      return;
    }

    const files = (() => {
      try { return fs.readdirSync(dir); } catch { return []; }
    })();
    if (!files.length) {
      cleanup();
      return res.status(502).json({ error: "The merge produced no file." });
    }

    const file = path.join(dir, files[0]);
    const size = fs.statSync(file).size;
    const filename = safeFilename(res.locals.title || "video", path.extname(files[0]).slice(1) || "mp4");

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", String(size));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename.replace(/[^\x20-\x7E]/g, "_")}"; ` +
      `filename*=UTF-8''${encodeURIComponent(filename)}`
    );

    const stream = fs.createReadStream(file);
    stream.on("error", () => { cleanup(); res.destroy(); });
    // Delete once the bytes are out, whether that's success or a hang-up.
    stream.on("close", cleanup);
    stream.pipe(res);
  });
}

/**
 * Stream one image out of a post.
 *
 * Proxied rather than redirected to the CDN for the same reason the video
 * route is: only we can set Content-Disposition, so a 302 would open the photo
 * in a tab instead of saving it -- which is the whole point on a phone.
 */
async function streamPhoto(req, res, url, index, platform) {
  let photos;
  try {
    photos = await galleryUrls(url);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  if (index >= photos.length) {
    return res.status(404).json({
      error: photos.length === 1
        ? "That post has only one photo."
        : `That post has ${photos.length} photos.`
    });
  }

  const target = photos[index];
  // galleryUrls() already filtered, but re-check at the line that actually
  // performs the fetch -- that's the one that matters.
  if (!isAllowedMedia(target)) {
    return res.status(502).json({ error: "Unexpected media host." });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  res.on("close", () => ctrl.abort()); // visitor cancelled -> drop the upstream fetch

  let upstream;
  try {
    upstream = await fetch(target, { signal: ctrl.signal });
  } catch {
    clearTimeout(timer);
    if (!res.headersSent) res.status(502).json({ error: "Couldn't reach the photo CDN." });
    return;
  }
  // Headers are in. From here the stream is the client's to cancel, so the
  // timeout has done its job -- leaving it armed would kill a slow download.
  clearTimeout(timer);

  if (!upstream.ok || !upstream.body) {
    return res.status(502).json({ error: "The photo CDN refused that request." });
  }

  const type = upstream.headers.get("content-type") || "image/jpeg";
  const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";

  // Name the file after the post's shortcode: the CDN URL is a signed blob
  // with nothing human-readable in it, and photo posts carry no title.
  const shortcode = (url.match(/\/(?:p|reel|reels|tv)\/([\w-]+)/) || [])[1] || platform;
  const filename = safeFilename(
    photos.length > 1 ? `${shortcode}-${index + 1}` : shortcode,
    ext
  );

  res.setHeader("Content-Type", type);
  const len = upstream.headers.get("content-length");
  if (len) res.setHeader("Content-Length", len);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename.replace(/[^\x20-\x7E]/g, "_")}"; ` +
    `filename*=UTF-8''${encodeURIComponent(filename)}`
  );

  Readable.fromWeb(upstream.body).pipe(res).on("error", () => res.destroy());
}

/* --------------------------------------------------------------------------
   GET /api/download -- stream the file to the browser

   Never buffered in memory: a free-tier box has ~512MB RAM and holding a video
   in RAM before sending would kill it under any concurrency. Audio and photos
   stream through as bytes arrive; video stages to a temp file on disk (the
   merge needs somewhere seekable to write) and streams from there.
   -------------------------------------------------------------------------- */

app.get("/api/download", rateLimit, async (req, res) => {
  const url = req.query.url;
  const format = String(req.query.format || "hd").toLowerCase();
  const platform = classify(url);

  if (!platform) {
    return res.status(400).json({ error: "Unsupported link." });
  }

  /* Photos never touch yt-dlp: it can't see them. One image per request
     (?i=N) rather than a zip -- zipping would mean buffering a whole carousel
     to build the archive, and the streaming rule below exists precisely to
     avoid holding media in a 512MB box's memory. */
  if (format === "photo") {
    const i = Number.parseInt(req.query.i ?? "0", 10);
    if (!Number.isInteger(i) || i < 0) {
      return res.status(400).json({ error: "Bad photo index." });
    }
    return streamPhoto(req, res, url, i, platform);
  }

  if (!FORMATS[format]) {
    return res.status(400).json({ error: "Unknown format. Use hd, sd, mp3 or photo." });
  }

  // Fetch the title first so the saved file isn't called "download".
  let title = "video";
  try {
    const info = await ytdlpJson(url, 20_000);
    title = info.title || title;
    res.locals.title = title;
  } catch {
    // Non-fatal: a generic filename beats failing the whole download.
  }

  /* Every video takes the merge-to-disk route, on every platform: the format
     chain asks for video + audio as two streams, and two streams have to be
     muxed to a seekable file before an MP4 exists to send. It has to run
     before any header is set -- streamMerged sets its own, including a real
     Content-Length, which it can only know once the merge is done. */
  if (format !== "mp3") {
    return streamMerged(req, res, url, FORMATS[format], platform);
  }

  const filename = safeFilename(title, "mp3");

  res.setHeader("Content-Type", "audio/mpeg");
  // filename* (RFC 5987) carries the UTF-8 title; plain filename is the fallback.
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename.replace(/[^\x20-\x7E]/g, "_")}"; ` +
    `filename*=UTF-8''${encodeURIComponent(filename)}`
  );

  const dl = spawn(YTDLP, [
    "-f", FORMATS.mp3,
    "--no-playlist",
    "--no-warnings",
    "--socket-timeout", "15",
    "-o", "-",           // stream to stdout
    url
  ]);

  // yt-dlp's own --extract-audio can't post-process to stdout, so pipe its raw
  // audio stream through ffmpeg and transcode on the fly. Audio is one stream,
  // so unlike video this needs no merge and can start sending immediately.
  const ff = spawn(FFMPEG, [
    "-i", "pipe:0",
    "-vn",
    "-b:a", "192k",
    "-f", "mp3",
    "pipe:1"
  ]);
  const children = [dl, ff];

  dl.stdout.pipe(ff.stdin);
  ff.stdout.pipe(res);
  // EPIPE here just means the client hung up; it isn't an error worth logging.
  ff.stdin.on("error", () => {});

  let failed = "";
  dl.stderr.on("data", (d) => { failed += d; });

  const cleanup = () => children.forEach((c) => { if (!c.killed) c.kill("SIGKILL"); });

  // If the visitor cancels or navigates away, don't leave yt-dlp running.
  res.on("close", cleanup);

  dl.on("error", () => {
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: "yt-dlp is not installed on the server." });
  });

  dl.on("close", (code) => {
    if (code !== 0) {
      cleanup();
      // Headers are already out the moment bytes flow, so we can only report a
      // clean error if nothing has been sent yet. Otherwise: cut the stream and
      // let the browser surface it as a failed download.
      if (!res.headersSent) res.status(502).json({ error: friendlyError(failed) });
      else res.destroy();
    }
  });
});

/* --------------------------------------------------------------------------
   Local dev convenience: if index.html is sitting next to us (i.e. you ran
   `npm start` from a checkout, rather than the container, which only copies
   server.js), serve the site from here too. Same origin means CORS never
   enters the picture while you're testing.

   This never activates in production: the Docker image has no index.html.

   dotfiles:"deny" is load-bearing. serve-static's default only ignores dotfiles
   at the root -- it happily serves files *inside* a dot-directory, so .git/config
   would be readable. This listens on all interfaces, so that's everyone on your
   network, not just you.
   -------------------------------------------------------------------------- */

const SITE_DIR = path.join(__dirname, "..");
const SERVE_SITE = fs.existsSync(path.join(SITE_DIR, "index.html"));

if (SERVE_SITE) {
  app.use(express.static(SITE_DIR, {
    index: "index.html",
    extensions: ["html"],
    dotfiles: "deny"
  }));
}

app.use((_req, res) => res.status(404).json({ error: "Not found." }));

app.listen(PORT, () => {
  console.log(`Vid VorTex API listening on :${PORT}`);
  console.log(`CORS origins: ${allowed.length ? allowed.join(", ") : "(any)"}`);
  if (SERVE_SITE) console.log(`Site served from ${SITE_DIR} -> http://localhost:${PORT}`);
});
