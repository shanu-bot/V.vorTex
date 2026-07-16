/* ==========================================================================
   VIDEO-HUB — server.js

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

const app = express();
const PORT = process.env.PORT || 8080;
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

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
  facebook: { name: "Facebook", hosts: ["facebook.com", "fb.watch", "fb.com"] }
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

/**
 * Format selectors. TikTok/IG/FB serve progressive MP4s (audio+video already
 * muxed), so we can pick a single format and stream it straight out with no
 * ffmpeg merge step -- merging cannot stream to stdout cleanly.
 */
const FORMATS = {
  hd: "best[height<=1080][ext=mp4]/best[ext=mp4]/best",
  sd: "best[height<=480][ext=mp4]/worst[ext=mp4]/worst",
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
      if (code !== 0) return reject(new Error(friendlyError(err)));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error("Could not read that video's details."));
      }
    });
  });
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
    return res.status(400).json({ error: "Unsupported link. Use TikTok, Instagram or Facebook." });
  }

  try {
    const info = await ytdlpJson(url);

    // Prefer a real reported size; fall back to yt-dlp's estimate.
    const size = info.filesize || info.filesize_approx ||
      (info.formats || []).map((f) => f.filesize || f.filesize_approx || 0).sort((a, b) => b - a)[0];

    const height = info.height ||
      Math.max(0, ...(info.formats || []).map((f) => f.height || 0));

    res.json({
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

/* --------------------------------------------------------------------------
   GET /api/download -- stream the file to the browser

   Streamed, not buffered: a free-tier box has ~512MB RAM and buffering a video
   into memory before sending would kill it under any concurrency.
   -------------------------------------------------------------------------- */

app.get("/api/download", rateLimit, async (req, res) => {
  const url = req.query.url;
  const format = String(req.query.format || "hd").toLowerCase();
  const platform = classify(url);

  if (!platform) {
    return res.status(400).json({ error: "Unsupported link." });
  }
  if (!FORMATS[format]) {
    return res.status(400).json({ error: "Unknown format. Use hd, sd or mp3." });
  }

  // Fetch the title first so the saved file isn't called "download".
  let title = "video";
  try {
    const info = await ytdlpJson(url, 20_000);
    title = info.title || title;
  } catch {
    // Non-fatal: a generic filename beats failing the whole download.
  }

  const isAudio = format === "mp3";
  const filename = safeFilename(title, isAudio ? "mp3" : "mp4");

  res.setHeader("Content-Type", isAudio ? "audio/mpeg" : "video/mp4");
  // filename* (RFC 5987) carries the UTF-8 title; plain filename is the fallback.
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename.replace(/[^\x20-\x7E]/g, "_")}"; ` +
    `filename*=UTF-8''${encodeURIComponent(filename)}`
  );

  const dl = spawn(YTDLP, [
    "-f", FORMATS[format],
    "--no-playlist",
    "--no-warnings",
    "--socket-timeout", "15",
    "-o", "-",           // stream to stdout
    url
  ]);

  let ff = null;
  const children = [dl];

  if (isAudio) {
    // yt-dlp's own --extract-audio can't post-process to stdout, so pipe its
    // raw audio stream through ffmpeg and transcode on the fly.
    ff = spawn(FFMPEG, [
      "-i", "pipe:0",
      "-vn",
      "-b:a", "192k",
      "-f", "mp3",
      "pipe:1"
    ]);
    children.push(ff);
    dl.stdout.pipe(ff.stdin);
    ff.stdout.pipe(res);
    // EPIPE here just means the client hung up; it isn't an error worth logging.
    ff.stdin.on("error", () => {});
  } else {
    dl.stdout.pipe(res);
  }

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

const path = require("path");
const fs = require("fs");

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
  console.log(`Video-Hub API listening on :${PORT}`);
  console.log(`CORS origins: ${allowed.length ? allowed.join(", ") : "(any)"}`);
  if (SERVE_SITE) console.log(`Site served from ${SITE_DIR} -> http://localhost:${PORT}`);
});
