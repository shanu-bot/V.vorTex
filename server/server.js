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
const { spawn, spawnSync } = require("child_process");
const { Readable } = require("stream");   // web ReadableStream -> Node stream, for the CDN proxy
const os = require("os");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;

/* Declared up here rather than beside redact(): boot-time code runs before the
   error-reporting section further down, and a const in the temporal dead zone
   throws rather than reading as undefined. See "Error reporting" for what it
   controls. */
const RAW_ERRORS = /^(1|true|yes)$/i.test(process.env.RAW_ERRORS || "");

/* --------------------------------------------------------------------------
   Locating the tools

   Three places, in order: an explicit env var, the bin/ directory that
   scripts/install-tools.js fills in at `npm install` time, then bare PATH.

   The middle one is what makes a non-container deploy work. Render's native
   Node runtime has no yt-dlp and no ffmpeg and no root to apt-get them with,
   so postinstall drops static builds into server/bin/ -- but nothing adds that
   directory to PATH, so spawn() would still get ENOENT. Resolving from
   __dirname rather than the working directory keeps it correct no matter where
   the process was started from.

   In the container bin/ doesn't exist (the install script sees both tools on
   PATH and skips), so this falls through to PATH and nothing changes.
   -------------------------------------------------------------------------- */

const BIN_DIR = path.join(__dirname, "bin");

function resolveTool(envVar, name) {
  if (process.env[envVar]) return process.env[envVar];
  const bundled = path.join(BIN_DIR, name);
  try {
    fs.accessSync(bundled, fs.constants.X_OK);
    return bundled;
  } catch {
    return name; // let PATH answer it
  }
}

const YTDLP = resolveTool("YTDLP_PATH", "yt-dlp");
const FFMPEG = resolveTool("FFMPEG_PATH", "ffmpeg");
const FFPROBE = resolveTool("FFPROBE_PATH", "ffprobe");
const GALLERYDL = resolveTool("GALLERYDL_PATH", "gallery-dl");

/* --------------------------------------------------------------------------
   yt-dlp everywhere; gallery-dl for instagram.com/p/ and nothing else.

   yt-dlp is video-only. Its Instagram extractor skips non-video nodes, so an
   image post exits "There is no video in this post" and images inside a mixed
   carousel never appear at all. No format selector fixes that -- there is no
   video track to select. Photo and carousel support therefore needs a second
   tool, and gallery-dl is it.

   The scope is the whole point, because an earlier version of this ran
   gallery-dl on *every* Instagram URL, concurrently with yt-dlp, inside a
   shared 25s budget. That is what produced "[instagram] --dump-json failed
   (timeout)" and "[gallery-dl] exit null" -- the second was this server's own
   SIGKILL. Two extractors, two logins, two sets of round-trips, on the
   platform least tolerant of any of it.

   So it is fenced in three ways:

     - By URL. Only instagram.com/p/ links, which are the only ones that can
       hold images. Reels, stories, TikTok, Facebook and YouTube never spawn
       it, which is why those four keep working exactly as they do today.
     - By budget. Its own timeout (GALLERYDL_TIMEOUT_MS), well inside
       Instagram's 90s ceiling, so a slow gallery-dl can never be what makes a
       request time out.
     - By consequence. Its result is optional everywhere. If it is missing,
       slow, or fails, the request falls back to what yt-dlp found and the
       visitor still gets the videos in the post.

   Failure to install is likewise not fatal: it is probed once at boot and
   reported, and every video download on all four platforms is unaffected.
   -------------------------------------------------------------------------- */

const GALLERYDL_TIMEOUT_MS = Number(process.env.GALLERYDL_TIMEOUT_MS) || 45_000;

/** Instagram post URLs that can contain images. Deliberately not reels. */
const IG_PHOTO_POST_RE = /instagram\.com\/(?:[^/]+\/)?p\//i;

const GALLERYDL_STATUS = (() => {
  const probe = spawnSync(GALLERYDL, ["--version"], { encoding: "utf8", timeout: 20_000 });
  if (probe.error || probe.status !== 0) {
    return {
      available: false,
      path: GALLERYDL,
      version: null,
      reason: probe.error ? probe.error.code : `exit ${probe.status}`
    };
  }
  return { available: true, path: GALLERYDL, version: (probe.stdout || "").trim(), reason: null };
})();

if (GALLERYDL_STATUS.available) {
  console.log(`[gallery-dl] ${GALLERYDL_STATUS.version} at ${GALLERYDL_STATUS.path} - instagram.com/p/ photo posts supported`);
} else {
  console.warn(
    `[gallery-dl] NOT AVAILABLE (${GALLERYDL_STATUS.reason} for "${GALLERYDL_STATUS.path}"). ` +
    "Instagram photo posts and the images inside carousels will be unavailable; " +
    "videos, reels, TikTok, Facebook and YouTube are unaffected. " +
    "Fix: redeploy so postinstall installs it, or set GALLERYDL_PATH."
  );
}

/* Instagram is slower than the rest, reliably and by a lot -- its API is
   rate-limited hard against datacenter IPs, and a carousel means walking every
   entry. The old 25s ceiling was tuned for a single video and is where
   "Timed out reading that post" came from. */
const IG_TIMEOUT_MS = Number(process.env.IG_TIMEOUT_MS) || 90_000;
const DEFAULT_TIMEOUT_MS = 25_000;

/** Per-platform extraction budget. Only Instagram differs. */
const timeoutFor = (platform) => (platform === "instagram" ? IG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

/* Socket timeout is per-connection, not per-request, so it has to rise too --
   otherwise a slow Instagram response is killed long before the overall budget
   is reached and the generous ceiling never applies. 15s stays everywhere
   else: TikTok and Facebook work today, and a longer socket timeout there
   would only make a genuinely dead host take longer to report itself. */
const DEFAULT_SOCKET_TIMEOUT = "15";
const IG_SOCKET_TIMEOUT = String(Number(process.env.IG_SOCKET_TIMEOUT) || 45);
const socketTimeoutFor = (platform) =>
  (platform === "instagram" ? IG_SOCKET_TIMEOUT : DEFAULT_SOCKET_TIMEOUT);

/* Everything per-platform about an extraction, in one place, so a call site
   cannot pick up the longer timeout and miss the retry. Instagram is the only
   platform that differs on any of it; the object this returns for the other
   three reproduces the previous behaviour exactly. */
const extractOpts = (platform, playlist = false) => ({
  label: platform,
  platform,
  socketTimeout: socketTimeoutFor(platform),
  retryOnce: platform === "instagram",
  // Only Instagram caps yt-dlp's internal retries; see the note at the flag.
  extractorRetries: platform === "instagram" ? 1 : null,
  playlist
});

/* --------------------------------------------------------------------------
   The cookie-free route out of a YouTube bot check.

   A YouTube session exported from a browser dies quickly when it is used from
   a datacenter IP -- days, not weeks -- and the failure is "Sign in to confirm
   you're not a bot" with the cookies loaded and sent. Nothing in this server
   can stop that happening; re-exporting the jar is the only cure and it is a
   cure with a short shelf life.

   What this server can do is stop treating a dead session as the end of the
   attempt. yt-dlp talks to YouTube as one of several "player clients", and
   they are not equally gated. Measured against this build (2026.07.04), with
   no cookies at all:

     web, web_safari, ios     no formats at all -- these want a PO token
     tv_simply, android, mweb  360p ceiling
     web_embedded              2160p offered; downloaded 1080p H.264 + AAC

   So web_embedded is the default here: it is the only client measured that
   costs nothing in quality. Verified end to end -- a 1080p H.264 + AAC merge
   with an empty cookie jar.

   It is a *fallback*, not the first choice. Cookies still lead, because a
   working session is the more capable path (age-gated and private videos
   exist, and no player client substitutes for being logged in). This fires
   only after YouTube has refused, and only once. Set YOUTUBE_PLAYER_CLIENT to
   change the client, or to `off` to disable the fallback entirely.
   -------------------------------------------------------------------------- */

const YT_FALLBACK_CLIENT = process.env.YOUTUBE_PLAYER_CLIENT || "web_embedded";
const YT_FALLBACK_ENABLED = YT_FALLBACK_CLIENT.toLowerCase() !== "off";

/** The failures a different player client can plausibly get past. */
const YT_BLOCKED_CODES = new Set([
  "bot_check", "login_required", "http_403", "http_401", "cookies",
  // Not an error shape, a refusal shape: YouTube strips the formats out rather
  // than saying no. See the note in classifyError().
  "no_formats"
]);

/** True when this failure is worth one more try as a different client. */
const canRetryAsClient = (platform, code, alreadyTried) =>
  YT_FALLBACK_ENABLED && platform === "youtube" && !alreadyTried && YT_BLOCKED_CODES.has(code);

/* Scoped with the `youtube:` prefix, so it is inert for every other extractor
   even if it ever leaks onto a non-YouTube command line. */
const playerClientArgs = (client) => ["--extractor-args", `youtube:player_client=${client}`];

/**
 * Codec of a file's first video stream.
 *
 * Returns "" when the file genuinely has no video track -- the case worth
 * catching -- and null when ffprobe couldn't answer at all, so a missing
 * ffprobe degrades to "don't know" rather than failing every download.
 *
 * Reads headers only, so it's milliseconds even on a large file.
 */
function videoCodec(file) {
  const r = spawnSync(FFPROBE, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file
  ], { encoding: "utf8", timeout: 20_000 });

  if (r.error || r.status !== 0) return null; // no ffprobe, or it choked
  return r.stdout.trim();
}

/* yt-dlp finds ffmpeg on PATH by itself, so it only needs telling when the
   binary is somewhere PATH won't look -- which is exactly the bin/ case above.
   Passing a bare "ffmpeg" here would be read as a path and fail, so only pass
   it when resolveTool returned an actual path.

   The containing directory rather than the binary: yt-dlp wants ffprobe as well
   as ffmpeg, and handing it the directory is what lets it find both. */
const FFMPEG_LOCATION = FFMPEG.includes(path.sep) ? path.dirname(FFMPEG) : null;

/* --------------------------------------------------------------------------
   Cookies -- optional, and increasingly the difference between this working
   and not.

   Platforms serve datacenter IPs a bot check rather than the video (YouTube's
   "Sign in to confirm you're not a bot" is the one you'll hit first), and a
   logged-in session is what gets past it.

   The session comes from a file, in this order:

     1. $COOKIES_FILE          -- an explicit path, if you set one.
     2. /etc/secrets/cookies.txt -- where Render mounts a Secret File. This is
        the one to use in production: the dashboard holds the contents, nothing
        touches the repo, and the mount is read-only.
     3. server/cookies.txt     -- for local development.

   A pasted env var still works ($YTDLP_COOKIES / $IG_COOKIES, escaped \n
   accepted) and is merged in after the file, but a full jar is far past what
   an env var should hold -- hence the file.

   NEVER COMMIT THE FILE. A cookies.txt is a password that skips 2FA, and this
   repo is public. It is in .gitignore and .dockerignore; leave it there.
   -------------------------------------------------------------------------- */

/** Netscape jars must open with this magic line or the parser rejects them. */
const COOKIE_HEADER = "# Netscape HTTP Cookie File";
const COOKIE_HEADER_RE = /^#\s*(?:Netscape|HTTP)\s+.*Cookie File/i;

/* --------------------------------------------------------------------------
   Only these domains survive into the jar this server actually uses.

   A browser export is everything you are logged into -- bank, email, source
   control -- and this process hands the jar to a subprocess that talks to the
   internet. yt-dlp is domain-scoped and wouldn't send your GitHub session to
   YouTube, but "the tool is careful" is a thin reason to keep the entries
   around at all. So the jar gets cut down to the four platforms this server
   supports, and everything else is dropped before anything is written.

   Google's own domains are deliberately absent: youtube.com cookies are what
   yt-dlp needs, and .google.com holds the master account session.

   COOKIE_DOMAINS (comma-separated) extends the list if a platform ever needs
   another host.
   -------------------------------------------------------------------------- */

const COOKIE_DOMAINS = [
  "youtube.com", "youtu.be", "youtube-nocookie.com",
  "tiktok.com",
  "instagram.com",
  "facebook.com", "fb.watch", "fb.com",
  "cdninstagram.com", "fbcdn.net",
  ...(process.env.COOKIE_DOMAINS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
];

/** Same exact-suffix match classify() uses -- `evilyoutube.com` must not pass. */
function cookieDomainAllowed(field) {
  const host = String(field).replace(/^\./, "").toLowerCase();
  return COOKIE_DOMAINS.some((d) => host === d || host.endsWith("." + d));
}

/* Render's secret mount. Listed by name so a misnamed Secret File shows up as
   a mismatch rather than as silence -- "you created youtube-cookies.txt, this
   looks for cookies.txt" is a two-second fix that is otherwise invisible. */
const SECRETS_DIR = "/etc/secrets";

function listSecretsDir() {
  try {
    return fs.readdirSync(SECRETS_DIR);
  } catch (e) {
    return e.code === "ENOENT" ? null : []; // null = no such directory at all
  }
}

/** Where to look for the jar, most specific first. */
const COOKIE_PATHS = (() => {
  if (process.env.COOKIES_FILE) return [process.env.COOKIES_FILE];

  // POSIX-joined, not path.join: this mount only exists on Linux, and showing
  // a Windows-style "\etc\secrets\..." in a diagnostic is just confusing.
  const candidates = [`${SECRETS_DIR}/cookies.txt`];

  /* Anything else in the secrets directory that looks like a jar. Covers the
     Secret File being called cookies.txt.txt, youtube_cookies.txt, or whatever
     the browser extension named its export. */
  for (const name of listSecretsDir() || []) {
    if (/cookie/i.test(name)) {
      const p = path.join(SECRETS_DIR, name);
      if (!candidates.includes(p)) candidates.push(p);
    }
  }

  candidates.push(path.join(__dirname, "cookies.txt")); // local development
  return candidates;
})();

/* --------------------------------------------------------------------------
   Everything learned while loading the jar, kept so it can be reported.

   "Sign in to confirm you're not a bot" is what a platform says when it sees
   no session, and from the outside that looks identical whether the file was
   missing, unreadable, misnamed, full of cookies for other sites, or simply
   expired. Those are five different fixes, so the loader records which one it
   was instead of just succeeding or not.
   -------------------------------------------------------------------------- */

const COOKIE_STATUS = {
  checked: [],        // [{ path, exists, readable, size, entries, error }]
  secretsDir: null,   // names in /etc/secrets, or null if there is no such dir
  source: null,       // where the jar that got used came from
  entries: 0,         // entries that survived the domain filter
  dropped: 0,         // entries for sites this server doesn't support
  byDomain: {},       // surviving entries per allowed domain
  seenDomains: [],    // domains present in the file, allowed or not (names only)
  loaded: false
};

/**
 * Netscape jars are tab-separated, but plenty of exporters emit spaces and
 * yt-dlp is lenient about it. Splitting only on tabs would put the whole line
 * in field 0, fail the domain check, and silently drop every cookie in the
 * file -- so fall back to any whitespace.
 */
function cookieFields(line) {
  const byTab = line.split("\t");
  return byTab.length >= 7 ? byTab : line.split(/\s+/);
}

const COOKIE_FILE = (() => {
  COOKIE_STATUS.secretsDir = listSecretsDir();

  const blobs = [];

  for (const p of COOKIE_PATHS) {
    const record = { path: p, exists: false, readable: false, size: 0, error: null };
    try {
      const st = fs.statSync(p);
      record.exists = true;
      record.size = st.size;
      // Readability is its own question: a mounted-but-unreadable secret is a
      // permissions problem, and it should not look like a missing file.
      fs.accessSync(p, fs.constants.R_OK);
      record.readable = true;

      const text = fs.readFileSync(p, "utf8");
      COOKIE_STATUS.checked.push(record);
      if (text.trim()) {
        blobs.push(text);
        COOKIE_STATUS.source = p;
        break; // first jar found wins; the rest are fallbacks, not extras
      }
      record.error = "file is empty";
      continue;
    } catch (e) {
      record.error = e.code || e.message;
      COOKIE_STATUS.checked.push(record);
      continue;
    }
  }

  for (const name of ["YTDLP_COOKIES", "IG_COOKIES"]) {
    const raw = (process.env[name] || "").replace(/\\n/g, "\n").trim();
    if (raw) {
      blobs.push(raw);
      COOKIE_STATUS.source = COOKIE_STATUS.source
        ? `${COOKIE_STATUS.source} + $${name}`
        : `$${name}`;
    }
  }

  if (!blobs.length) return null;

  let kept = 0;
  let dropped = 0;
  const lines = [];
  const seen = new Set();

  for (const raw of blobs.join("\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (COOKIE_HEADER_RE.test(line)) continue; // one header, added below

    // `#HttpOnly_` is a real entry wearing a comment's clothes, so it has to be
    // tested before comments are skipped -- and stripped before the domain is
    // read, or every httpOnly cookie would fail the allowlist and be dropped.
    const entry = line.replace(/^#HttpOnly_/i, "");
    if (entry.startsWith("#")) continue;

    const domain = cookieFields(entry)[0];
    if (!domain) continue;
    seen.add(domain.replace(/^\./, "").toLowerCase());

    if (!cookieDomainAllowed(domain)) { dropped++; continue; }
    kept++;
    const key = domain.replace(/^\./, "").toLowerCase();
    COOKIE_STATUS.byDomain[key] = (COOKIE_STATUS.byDomain[key] || 0) + 1;
    lines.push(line);
  }

  COOKIE_STATUS.entries = kept;
  COOKIE_STATUS.dropped = dropped;
  COOKIE_STATUS.seenDomains = [...seen].sort();

  if (!kept) return null;

  // 0600: the container runs as `node`, but don't leave a session readable.
  const file = path.join(os.tmpdir(), "vv-cookies.txt");
  fs.writeFileSync(file, `${COOKIE_HEADER}\n${lines.join("\n")}\n`, { mode: 0o600 });
  COOKIE_STATUS.loaded = true;
  return file;
})();

/* --------------------------------------------------------------------------
   A jar for Instagram on its own.

   The shared jar above is one file for all four platforms, which is fine until
   one of them expires. YouTube sessions die within days from a datacenter IP,
   Instagram's last far longer, and re-exporting the shared file to fix YouTube
   means re-exporting Instagram's working session along with it -- so a routine
   YouTube refresh can take Instagram down with it.

   So Instagram gets its own optional file. When `instagram_cookies.txt` is
   present, Instagram requests use it and nothing else does; when it is absent,
   Instagram falls back to the shared jar and behaves exactly as before. Both
   yt-dlp and gallery-dl are handed the same file.

   Filtered harder than the shared jar: only Meta's own domains, because that
   is all this file is for. An accidental export of everything therefore leaks
   nothing extra into the one process that talks to Instagram.
   -------------------------------------------------------------------------- */

const IG_COOKIE_DOMAINS = ["instagram.com", "cdninstagram.com", "facebook.com", "fbcdn.net"];

const IG_COOKIE_PATHS = process.env.INSTAGRAM_COOKIES_FILE
  ? [process.env.INSTAGRAM_COOKIES_FILE]
  : [`${SECRETS_DIR}/instagram_cookies.txt`, path.join(__dirname, "instagram_cookies.txt")];

const IG_COOKIE_STATUS = { checked: [], source: null, entries: 0, loaded: false };

const IG_COOKIE_FILE = (() => {
  for (const p of IG_COOKIE_PATHS) {
    const record = { path: p, exists: false, readable: false, size: 0, error: null };
    let text;
    try {
      const st = fs.statSync(p);
      record.exists = true;
      record.size = st.size;
      fs.accessSync(p, fs.constants.R_OK);
      record.readable = true;
      text = fs.readFileSync(p, "utf8");
    } catch (e) {
      record.error = e.code || e.message;
      IG_COOKIE_STATUS.checked.push(record);
      continue;
    }
    IG_COOKIE_STATUS.checked.push(record);
    if (!text.trim()) { record.error = "file is empty"; continue; }

    const lines = [];
    for (const raw of text.split("\n")) {
      const line = raw.trimEnd();
      if (!line || COOKIE_HEADER_RE.test(line)) continue;
      // #HttpOnly_ is an entry wearing a comment's clothes; strip before the
      // domain is read, or every httpOnly cookie fails the allowlist.
      const entry = line.replace(/^#HttpOnly_/i, "");
      if (entry.startsWith("#")) continue;
      const domain = String(cookieFields(entry)[0] || "").replace(/^\./, "").toLowerCase();
      if (!domain) continue;
      if (!IG_COOKIE_DOMAINS.some((d) => domain === d || domain.endsWith("." + d))) continue;
      lines.push(line);
    }

    if (!lines.length) { record.error = "no instagram.com entries"; continue; }

    try {
      const file = path.join(os.tmpdir(), "vv-ig-cookies.txt");
      fs.writeFileSync(file, `${COOKIE_HEADER}\n${lines.join("\n")}\n`, { mode: 0o600 });
      IG_COOKIE_STATUS.source = p;
      IG_COOKIE_STATUS.entries = lines.length;
      IG_COOKIE_STATUS.loaded = true;
      return file;
    } catch (e) {
      record.error = `could not stage: ${e.code || e.message}`;
    }
  }
  return null;
})();

/** The platforms a session actually matters for, and whether one is present. */
const COOKIE_PLATFORM_DOMAINS = ["youtube.com", "tiktok.com", "instagram.com", "facebook.com"];

function cookiesForDomain(domain) {
  return Object.entries(COOKIE_STATUS.byDomain)
    .filter(([d]) => d === domain || d.endsWith("." + domain))
    .reduce((n, [, c]) => n + c, 0);
}

/**
 * A compact, value-free summary. Safe to log, safe to return in an error, and
 * detailed enough to tell the five failure modes apart.
 */
function cookieSummary() {
  /* These paths are NOT redacted, unlike the ones in tool errors. The question
     this exists to answer is "is /etc/secrets/cookies.txt being read", and
     "…/cookies.txt" does not answer it. They are configuration, not secrets --
     the mount point is documented by Render, and no cookie name or value is
     ever included here. */
  return {
    loaded: COOKIE_STATUS.loaded,
    source: COOKIE_STATUS.loaded ? COOKIE_STATUS.source : null,
    entries: COOKIE_STATUS.entries,
    droppedForOtherSites: COOKIE_STATUS.dropped,
    perPlatform: Object.fromEntries(
      COOKIE_PLATFORM_DOMAINS.map((d) => [d, cookiesForDomain(d)])
    ),
    /* The dedicated Instagram jar, reported separately because it answers a
       different question: not "is there a session" but "which file is
       Instagram actually using". Absent is normal -- it means the shared jar. */
    instagram: {
      dedicatedFile: IG_COOKIE_STATUS.loaded,
      source: IG_COOKIE_STATUS.source,
      entries: IG_COOKIE_STATUS.entries,
      usingSharedJar: !IG_COOKIE_STATUS.loaded,
      pathsChecked: IG_COOKIE_STATUS.checked.map((c) => ({
        path: c.path, exists: c.exists, readable: c.readable, size: c.size, error: c.error
      }))
    },
    pathsChecked: COOKIE_STATUS.checked.map((c) => ({
      path: c.path,
      exists: c.exists,
      readable: c.readable,
      size: c.size,
      error: c.error
    })),
    secretsDir:
      COOKIE_STATUS.secretsDir === null
        ? `${SECRETS_DIR} does not exist (not running on Render, or no Secret Files added)`
        : COOKIE_STATUS.secretsDir
  };
}

/* Printed once at boot, because this is the question that actually gets asked
   and the logs are where it gets answered. */
(function reportCookieState() {
  const s = cookieSummary();
  console.log("[cookies] ---------------------------------------------");
  for (const c of COOKIE_STATUS.checked) {
    console.log(
      `[cookies] checked ${c.path} -> ` +
      (c.exists
        ? `exists, ${c.readable ? "readable" : "NOT READABLE"}, ${c.size} bytes` +
          (c.error ? ` (${c.error})` : "")
        : `missing (${c.error || "ENOENT"})`)
    );
  }
  console.log(
    `[cookies] ${SECRETS_DIR}: ` +
    (COOKIE_STATUS.secretsDir === null
      ? "no such directory"
      : COOKIE_STATUS.secretsDir.length
        ? COOKIE_STATUS.secretsDir.join(", ")
        : "(empty)")
  );

  if (!COOKIE_STATUS.loaded) {
    if (COOKIE_STATUS.entries === 0 && COOKIE_STATUS.dropped > 0) {
      console.error(
        `[cookies] LOADED NOTHING: the file had ${COOKIE_STATUS.dropped} entries but none ` +
        `for ${COOKIE_PLATFORM_DOMAINS.join(", ")}. Domains present: ` +
        `${COOKIE_STATUS.seenDomains.slice(0, 12).join(", ")}` +
        `${COOKIE_STATUS.seenDomains.length > 12 ? ", ..." : ""}`
      );
    } else {
      console.error(
        "[cookies] NO SESSION LOADED. YouTube will answer bot checks instead of videos. " +
        `Add a Secret File named cookies.txt (mounts at ${SECRETS_DIR}/cookies.txt), ` +
        "or set COOKIES_FILE to a path."
      );
    }
    console.log("[cookies] ---------------------------------------------");
    return;
  }

  console.log(`[cookies] loaded ${s.entries} entries from ${COOKIE_STATUS.source}`);
  console.log(`[cookies] per platform: ${JSON.stringify(s.perPlatform)}`);
  for (const [d, n] of Object.entries(s.perPlatform)) {
    if (n === 0) console.warn(`[cookies] none for ${d} - downloads from it will be anonymous`);
  }

  /* Which jar Instagram ended up on, said plainly at boot.
     One shared file is the normal case, and the dedicated file is opt-in --
     but "is gallery-dl getting my cookies too?" was previously only answerable
     by calling /api/health, and the logs are where it actually gets asked. */
  const igCount = cookiesForDomain("instagram.com");
  if (IG_COOKIE_STATUS.loaded) {
    console.log(
      `[cookies] instagram: using the dedicated jar ${IG_COOKIE_STATUS.source} ` +
      `(${IG_COOKIE_STATUS.entries} entries) for both yt-dlp and gallery-dl`
    );
  } else {
    console.log(
      `[cookies] instagram: using the shared jar (${igCount} instagram.com ` +
      "entries) for both yt-dlp and gallery-dl" +
      (igCount === 0 ? " - but it holds none, so Instagram requests will be anonymous" : "")
    );
  }

  console.log("[cookies] ---------------------------------------------");
})();

/* --------------------------------------------------------------------------
   Every run gets its own copy of the jar.

   yt-dlp does not just read the file it's handed -- it writes the whole jar
   back when it finishes, merging in whatever the site set during the fetch. A
   single request against YouTube turns an 89-byte file into a 972-byte one.

   Sharing one file across concurrent downloads therefore means two processes
   rewriting it at once, and the loser's write can leave a truncated jar --
   which takes out the configured session until the service restarts. So each
   invocation gets a disposable copy and the master is only ever read.

   Returns spawn args plus the cleanup to run once the process is done.
   -------------------------------------------------------------------------- */

const NO_COOKIES = { args: [], done: () => {} };

function cookieSession(platform) {
  /* Instagram gets its own file when one was configured; everything else, and
     Instagram without one, gets the shared jar. Chosen here rather than at the
     call sites so no path can be given the wrong session by omission. */
  const master = (platform === "instagram" && IG_COOKIE_FILE) ? IG_COOKIE_FILE : COOKIE_FILE;
  if (!master) return NO_COOKIES;

  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-ck-"));
    const copy = path.join(dir, "cookies.txt");
    fs.copyFileSync(master, copy);
    fs.chmodSync(copy, 0o600);

    /* Size at hand-over, so the copy can be checked afterwards -- see the note
       on cookiesProvenRead below for why that is the only real proof. */
    const sizeBefore = (() => {
      try { return fs.statSync(copy).size; } catch { return 0; }
    })();

    let finished = false;
    return {
      args: ["--cookies", copy],
      path: copy,
      done: () => {
        if (!finished) {
          finished = true;
          try {
            const sizeAfter = fs.statSync(copy).size;
            if (sizeAfter !== sizeBefore) noteCookiesRead(sizeBefore, sizeAfter);
          } catch { /* already gone, or never written */ }
        }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
      }
    };
  } catch (err) {
    // Degrade to an anonymous fetch rather than failing the request outright:
    // plenty of links need no session at all. Log it, because the ones that do
    // will fail further down with a much less obvious message.
    console.error(`[cookies] could not stage a jar copy: ${err.message}`);
    try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return NO_COOKIES;
  }
}

/* --------------------------------------------------------------------------
   Proving yt-dlp actually read the jar

   `--verbose` does not say. Checked against yt-dlp 2026.07.04: the only thing
   verbose output has to say about cookies is the echoed command line --
   "[debug] Command-line config: [... '--cookies', '<path>' ...]". That proves
   the flag was passed, which we already knew, and says nothing about whether
   the file was opened, parsed, or used.

   What does prove it is yt-dlp's own behaviour: it writes the jar back when it
   finishes, merging in whatever the site set during the fetch. Measured, a
   YouTube request turns an 89-byte file into a 972-byte one, and it does that
   even under --simulate. So if the disposable copy changed size, yt-dlp read
   it. That is a behavioural fact rather than an inference from a log line.

   Reported once per process. It answers a yes/no question, and the answer does
   not change between requests.
   -------------------------------------------------------------------------- */

let cookiesProvenRead = false;

function noteCookiesRead(before, after) {
  if (cookiesProvenRead) return;
  cookiesProvenRead = true;
  console.log(
    `[cookies] VERIFIED: yt-dlp read the jar - it rewrote the copy ` +
    `(${before} -> ${after} bytes). Source: ${COOKIE_STATUS.source}`
  );
}

/* --------------------------------------------------------------------------
   Pre-flight, and optional verbose passthrough.

   YTDLP_VERBOSE=1 turns on the block the operator asked for before every run:
   whether the jar exists, how big it is, the exact command, and the head of
   yt-dlp's verbose output. Off by default because --verbose is ~40 lines per
   invocation and there are up to two invocations per download.

   Never prints cookie contents -- only the path, the size, and the flags.
   -------------------------------------------------------------------------- */

const YTDLP_VERBOSE = /^(1|true|yes)$/i.test(process.env.YTDLP_VERBOSE || "");
const VERBOSE_HEAD_LINES = 15;

/* --------------------------------------------------------------------------
   JavaScript runtime

   YouTube now hands out a JS challenge that yt-dlp has to execute, and without
   a runtime to execute it in you get "No supported JavaScript runtime could be
   found" followed by the bot check -- which reads like a cookie problem and
   is not one.

   The subtlety is that yt-dlp *supports* node but does not *enable* it:
   `--js-runtimes` lists deno, node, quickjs and bun, and only deno is on by
   default. So a box with node installed and no deno reports
   "node (unavailable)", which means "not enabled", not "not found". Render's
   Node runtime is exactly that box.

   The path comes from process.execPath rather than PATH: this server is a node
   process, so that is a node binary that definitely exists and definitely
   works, in the container and on the native runtime alike.

   Node is *added*, not swapped in. Deno outranks it when present, so a host
   that has both keeps yt-dlp's preferred runtime.

   YTDLP_JS_RUNTIME=off disables the flag; anything else is taken as a runtime
   spec passed through verbatim (e.g. "deno" or "node:/usr/local/bin/node").
   -------------------------------------------------------------------------- */

const JS_RUNTIME = (() => {
  const setting = (process.env.YTDLP_JS_RUNTIME || "").trim();
  if (/^(off|none|0|false|no)$/i.test(setting)) return null;
  return setting || `node:${process.execPath}`;
})();

/* Asked and answered at boot, without touching the network.
   `yt-dlp --verbose` with no URL prints its startup banner and exits with a
   usage error, and that banner contains the line that settles this:

     [debug] JS runtimes: deno-2.9.2, node-24.18.0
     [debug] JS runtimes: none

   Running it with the flags this server intends to use therefore reports
   exactly what yt-dlp will have available at download time -- verified rather
   than assumed, which matters because "node is installed" and "yt-dlp can use
   node" turned out to be different statements.

   It also covers the older-build case for free: a yt-dlp that predates the
   option rejects it here, at boot, instead of on every download. */
/** What the boot probe found, so /api/health can report it too. */
const JS_RUNTIME_STATUS = { requested: JS_RUNTIME, available: null, enabled: false };

const JS_RUNTIME_ARGS = (() => {
  if (!JS_RUNTIME) {
    console.log("[jsruntime] disabled by YTDLP_JS_RUNTIME");
    JS_RUNTIME_STATUS.available = "disabled";
    return [];
  }

  const want = ["--js-runtimes", JS_RUNTIME];
  const probe = spawnSync(YTDLP, ["--verbose", ...want], { encoding: "utf8", timeout: 30_000 });
  const out = `${probe.stdout || ""}${probe.stderr || ""}`;

  if (probe.error) {
    console.warn(`[jsruntime] could not probe yt-dlp (${probe.error.code}); not passing --js-runtimes`);
    JS_RUNTIME_STATUS.available = `probe failed: ${probe.error.code}`;
    return [];
  }
  if (/no such option|unrecognized arguments?|Unknown option/i.test(out)) {
    console.warn("[jsruntime] this yt-dlp build has no --js-runtimes option; not passing it");
    JS_RUNTIME_STATUS.available = "option not supported by this yt-dlp build";
    return [];
  }

  const found = (out.match(/JS runtimes:\s*(.+)/) || [])[1]?.trim();
  JS_RUNTIME_STATUS.available = found || "unknown";
  JS_RUNTIME_STATUS.enabled = Boolean(found) && !/^none$/i.test(found);
  if (!found || /^none$/i.test(found)) {
    console.error(
      `[jsruntime] yt-dlp reports NO usable JS runtime with "${JS_RUNTIME}". ` +
      "YouTube's JS challenge will fail and downloads will look like bot checks. " +
      `(node binary this process is running from: ${process.execPath})`
    );
  } else {
    console.log(`[jsruntime] enabling "${JS_RUNTIME}" -> yt-dlp reports: ${found}`);
  }

  return want;
})();

/* The JS-challenge confirmation is a yes/no about this process, so it is
   reported once rather than on every request. */
let jsRuntimeConfirmed = false;

/** Indirection so the verbose/JS wrappers stay separable from the raw spawn. */
const spawnYtdlpProcess = (args) => spawn(YTDLP, args);

function spawnYtdlp(args, label) {
  /* Prepended here rather than at each call site: one choke point means every
     invocation gets it -- metadata, merge, stream and mp3 alike -- and none of
     the format or routing code has to know it exists. */
  const final = [...(YTDLP_VERBOSE ? ["--verbose"] : []), ...JS_RUNTIME_ARGS, ...args];

  /* The exact command, on every run, not only under YTDLP_VERBOSE. "Which
     flags actually went out" is the first question asked of every failure here
     and it was previously answerable only by redeploying with a debug switch
     on. One line, and it carries no secret -- the jar is a path to a temp copy,
     never its contents. */
  console.log(`[ytdlp:${label}] ${YTDLP} ${final.join(" ")}`);

  if (YTDLP_VERBOSE) {
    const i = final.indexOf("--cookies");
    const jarPath = i >= 0 ? final[i + 1] : null;
    let size = null;
    if (COOKIE_FILE) {
      try { size = fs.statSync(COOKIE_FILE).size; } catch { size = null; }
    }

    console.log(`[preflight:${label}] cookies file exists: ${COOKIE_FILE ? "yes" : "no"}`);
    console.log(
      `[preflight:${label}] file size: ` +
      (size === null ? "n/a" : `${size} bytes`) +
      (COOKIE_STATUS.source ? ` (from ${COOKIE_STATUS.source})` : "")
    );
    console.log(`[preflight:${label}] --cookies passed to yt-dlp: ${jarPath ? `yes -> ${jarPath}` : "NO"}`);
    console.log(`[preflight:${label}] command: ${YTDLP} ${final.join(" ")}`);
  }

  const child = spawnYtdlpProcess(final);

  /* Confirm the runtime was not merely enabled but actually picked, once per
     process. yt-dlp announces it plainly -- "[jsc:node] Solving JS challenges
     using node" -- and that line is the difference between "we passed a flag"
     and "the challenge got solved". Cheap to watch for: a regex on stderr that
     stops matching after the first hit. */
  if (!jsRuntimeConfirmed) {
    const watch = (d) => {
      if (jsRuntimeConfirmed) return;
      const m = String(d).match(/\[jsc:(\w+)\] Solving JS challenges using (\S+)/);
      if (m) {
        jsRuntimeConfirmed = true;
        console.log(`[jsruntime] VERIFIED: yt-dlp solved a JS challenge using "${m[2]}"`);
        child.stderr.off("data", watch);
        return;
      }
      if (/No supported JavaScript runtime/i.test(String(d))) {
        jsRuntimeConfirmed = true;
        console.error(
          "[jsruntime] yt-dlp reports NO supported JavaScript runtime. " +
          `Passing: ${JS_RUNTIME_ARGS.join(" ") || "(nothing)"}`
        );
        child.stderr.off("data", watch);
      }
    };
    child.stderr.on("data", watch);
  }

  if (YTDLP_VERBOSE) {
    let head = "";
    let printed = false;
    child.stderr.on("data", (d) => {
      if (printed) return;
      head += d;
      const lines = head.split("\n");
      if (lines.length > VERBOSE_HEAD_LINES) {
        printed = true;
        console.log(
          `[verbose:${label}] first ${VERBOSE_HEAD_LINES} lines:\n` +
          lines.slice(0, VERBOSE_HEAD_LINES).map((l) => `  ${l}`).join("\n")
        );
      }
    });
    // Short runs may never reach the line count; flush whatever arrived.
    child.on("close", () => {
      if (printed || !head.trim()) return;
      printed = true;
      console.log(
        `[verbose:${label}] output was shorter than ${VERBOSE_HEAD_LINES} lines:\n` +
        head.split("\n").map((l) => `  ${l}`).join("\n")
      );
    });
  }

  return child;
}

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
    return res.status(429).json({ error: `Too many requests. Try again in ${retry}s.`, code: "rate_limited", detail: null });
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
   Format selection: what to download, and how to rank the candidates

   Two separate jobs, and conflating them is what produced a file that played
   sound over a blank picture.

   WHAT: `bv*+ba/b`. Best video stream plus best audio stream, merged; failing
   that, the best single stream that already carries both. `bv*` and `b` are
   both video-bearing by definition and yt-dlp sorts `hasvid` above everything
   else, so no branch here can resolve to an audio-only format.

   `bv*+ba` rather than plain `b`: `b` means "best stream that already has
   audio in it". On TikTok/IG/FB that is the full-quality file, but on YouTube
   the only muxed stream is itag 18 at 640x360 -- everything above it is
   video-only DASH. Asking for the pair is the only way to get the real thing,
   and the merge is not optional: the 1080p stream has no audio track at all.

   HOW TO RANK: `-S vcodec:h264`, and this is the part that was missing.

   The old selector tried to express codec preference by chaining filtered
   alternatives, and only the first link in that chain actually pinned a codec.
   The second was `bv*[ext=mp4]+ba[ext=m4a]` -- and on YouTube AV1 formats are
   `ext=mp4`, so that link handed back AV1 whenever the first one missed. AV1
   and VP9 inside an MP4 are a valid file that Windows Media Player, stock
   Android players, older Safari and most TVs decode as audio plus a blank
   frame. The container promised something the player couldn't read.

   A sort field fixes what a filter chain kept getting wrong: it is a
   preference, not a requirement, so H.264 wins whenever it exists at any
   resolution and AV1/VP9 is still available when it's all the site has.
   Prepending it puts codec above resolution in yt-dlp's ordering, which is the
   trade this site wants -- a 1080p file that plays beats a 4K file that
   doesn't.

   Do not add `acodec:aac` to the sort. It ranks the audio field of the *video*
   candidate too, which pushes `bv*` toward low-res muxed streams: measured on
   a 4K source, adding it dropped the pick from 1080p avc1 to 360p itag 18.

   MAX_QUALITY=1 drops the codec preference entirely -- highest resolution
   wins, codec be damned. That is the setting that produces AV1, so if a
   download plays as sound-only, check whether it is set.
   -------------------------------------------------------------------------- */

const MAX_QUALITY = /^(1|true|yes)$/i.test(process.env.MAX_QUALITY || "");

/** Preference, not a filter — it can never make a selection fail. */
const FORMAT_SORT = MAX_QUALITY ? null : "vcodec:h264";

/* Two tails on every video selector, both there so a request cannot die of
   "Requested format is not available":

   `ba[acodec^=mp4a]` first, plain `ba` behind it. AAC is asked for by name
   because the alternative is Opus, and Opus inside an MP4 is the audio mirror
   of the AV1 problem -- a legal file that plays picture with no sound on the
   same players. This lives in the selector rather than in -S because
   `acodec:aac` in the sort also ranks the *video* candidate's audio field and
   drags `bv*` toward low-res muxed streams: measured, it moved a 4K source
   from 1080p avc1 down to 360p itag 18. Measured the other way, moving it here
   changed 137+251 (opus) to 137+140 (aac) with the same 1080p H.264 video.

   `/bv*` last, for a video with no audio track at all. Without it `bv*+ba`
   fails (nothing to pair) and `b` fails (nothing carries both) and a perfectly
   downloadable silent video returns an error. `bv*` is still video-bearing, so
   this cannot resurrect the audio-only bug; the worst case is a silent file,
   which beats no file. */
const FORMATS = {
  hd: "bv*+ba[acodec^=mp4a]/bv*+ba/b/bv*",

  /* `sd` exists so someone on a metered connection can take a smaller file, so
     the cap comes first -- but it still merges audio in, and it still falls
     back to the uncapped pair rather than failing if a site publishes nothing
     under the cap. */
  sd: "bv*[height<=480]+ba[acodec^=mp4a]/bv*[height<=480]+ba/b[height<=480]/bv*+ba/b/bv*",

  mp3: "bestaudio/best"
};

/* --------------------------------------------------------------------------
   Extraction cache

   An extraction is a real network round-trip to the platform -- measured at
   3.4-3.9s against YouTube from a laptop, and worse from a cold free-tier box.
   The site does one on /api/info and the download route used to do a second
   one purely to learn the title, so every download paid for the same work
   twice before a byte moved.

   The frontend always calls /api/info and only then offers the button, so by
   the time anyone clicks, the answer is already known. Caching it briefly
   removes the second extraction from the common path entirely.

   Short TTL on purpose: the plan embeds signed CDN URLs and a format list that
   both go stale, and this is a latency cache, not a data store. A miss just
   costs what the old code always paid.
   -------------------------------------------------------------------------- */

const PLAN_TTL_MS = 5 * 60_000;
const plans = new Map();

const planKey = (url, selector) => `${selector || ""}\\u0000${url}`;

function cachedPlan(url, selector) {
  const rec = plans.get(planKey(url, selector));
  if (!rec) return null;
  if (Date.now() - rec.at > PLAN_TTL_MS) {
    plans.delete(planKey(url, selector));
    return null;
  }
  return rec.info;
}

function rememberPlan(url, selector, info) {
  plans.set(planKey(url, selector), { at: Date.now(), info });
}

// Same reason the rate-limit map gets swept: this process runs for weeks.
setInterval(() => {
  const now = Date.now();
  for (const [k, rec] of plans) if (now - rec.at > PLAN_TTL_MS) plans.delete(k);
}, PLAN_TTL_MS).unref();

/**
 * What yt-dlp would actually download, read off a cached or fresh dump.
 *
 * Returns null when the dump didn't say -- callers treat that as "assume the
 * worst and take the merge path", which is the old behaviour.
 */
function downloadPlan(info) {
  const d = info?.requested_downloads?.[0];
  if (!d || !d.format_id) return null;
  return {
    formatId: d.format_id,
    ext: d.ext || null,
    vcodec: d.vcodec || null,
    // Present only when two streams have to be muxed. One stream means the
    // file is already playable as-is and ffmpeg has nothing to do.
    needsMerge: Array.isArray(d.requested_formats) && d.requested_formats.length > 1,
    // Exact size only. filesize_approx is an estimate, and a wrong
    // Content-Length truncates the download.
    size: Number.isFinite(d.filesize) ? d.filesize : null
  };
}

/**
 * Metadata, with the format selector treated as an optimisation rather than a
 * requirement.
 *
 * Passing -f to -J is what buys the download plan, but it also makes the dump
 * fail outright when the selector cannot be satisfied: `yt-dlp -J -f <bad>`
 * exits 1 with "Requested format is not available", where a bare -J on the
 * same video exits 0. That turned a format quirk into a dead /api/info and a
 * dead download, which is the wrong trade -- the plan is a speed-up, and a
 * speed-up must never be the reason something fails.
 *
 * So: ask with the selector, and if the answer is specifically "that selector
 * isn't available", ask again without it. The caller gets metadata either way;
 * it just loses the plan and falls back to the merge route, which can satisfy
 * anything.
 */
function ytdlpJson(url, timeoutMs = DEFAULT_TIMEOUT_MS, selector = null, opts = {}) {
  const label = opts.label || "ytdlp";

  return ytdlpJsonOnce(url, timeoutMs, selector, { ...opts, attempt: 1 })
    .catch((err) => {
      if (!selector || err.code !== "format_unavailable") throw err;
      console.warn(
        `[${label}] selector "${selector}" is not satisfiable for this video; ` +
        "re-reading metadata without it (download will take the merge route)"
      );
      return ytdlpJsonOnce(url, timeoutMs, null, { ...opts, attempt: 1 });
    })
    .catch((err) => {
      /* One retry, for transient failures only, and only where it was asked
         for. Instagram is the platform that needs it: it rate-limits by
         dropping the connection rather than answering, so an extraction that
         times out or dies mid-socket is very often fine seconds later. A
         second attempt is cheap next to returning an error for something that
         would have worked.

         Deliberately not retried: auth, format and "no video" failures. Those
         are answers, not accidents, and repeating them only doubles the wait
         before the visitor sees the same message. */
      /* YouTube refused the session. Try once more as a player client that
         does not need one -- see the note at YT_FALLBACK_CLIENT. Checked
         before the transient retry because the two are mutually exclusive:
         this is a refusal, not a stall. */
      if (canRetryAsClient(opts.platform, err.code, opts.playerClient)) {
        console.warn(
          `[${label}] refused (${err.code}); retrying once as player_client=${YT_FALLBACK_CLIENT}`
        );
        return ytdlpJsonOnce(url, timeoutMs, selector, {
          ...opts, playerClient: YT_FALLBACK_CLIENT, attempt: 2
        }).then((info) => {
          /* Tag the dump with the client that produced it. The formats in it
             are that client's formats, so the download has to be made as the
             same client or it is shopping from the wrong catalogue -- and this
             survives into the plan cache, which is where the download route
             reads it back. */
          if (info && typeof info === "object") info.__playerClient = YT_FALLBACK_CLIENT;
          return info;
        });
      }

      if (!opts.retryOnce || !RETRYABLE_CODES.has(err.code)) throw err;
      console.warn(`[${label}] attempt 1 failed (${err.code}: ${err.message}); retrying once`);
      return ytdlpJsonOnce(url, timeoutMs, selector, { ...opts, retryOnce: false, attempt: 2 })
        .catch((again) => {
          /* Report the second failure -- it is the current state of the world,
             and if the two differ the later one is the more useful. The flag
             is what lets the route say "twice", so a one-off is not mistaken
             for a dead platform. */
          again.retried = true;
          console.error(`[${label}] both attempts failed; final reason ${again.code}: ${again.message}`);
          throw again;
        });
    });
}

/* Failures worth a second attempt: the network, not the post. Deliberately
   short. "unknown" is not on it -- it is the bucket every unrecognised message
   lands in, so retrying it would double the wait on real errors far more often
   than it would rescue a transient one. */
const RETRYABLE_CODES = new Set(["timeout", "network", "rate_limited"]);

/** One attempt. Buffers stdout; used for metadata only, never for the video. */
function ytdlpJsonOnce(url, timeoutMs = DEFAULT_TIMEOUT_MS, selector = null, opts = {}) {
  return new Promise((resolve, reject) => {
    // Metadata is login-walled on exactly the same posts the media is, so this
    // needs the session as much as the download does -- without it /api/info
    // fails first and the download is never even attempted.
    const jar = cookieSession(opts.platform);

    /* Passing the selector costs nothing and buys the download plan: with -f
       and -S applied, the dump carries a `requested_downloads` entry naming
       the exact format that would be fetched, and a `requested_formats` array
       when that means merging two streams. One extraction answers both "what
       is this?" and "will this need ffmpeg?", which is what lets the download
       route skip its own probe entirely. */
    /* Warnings are left on. yt-dlp says things like "ffmpeg not found; merging
       is disabled" as a warning, not an error, and suppressing those while
       asking why a download failed is self-defeating. They land on stderr,
       which is only ever read on failure, so stdout stays clean JSON. */
    /* Playlist mode is opt-in and used by exactly one caller: an Instagram
       post URL, where the "playlist" is the carousel and its entries are the
       items. Every other caller keeps --no-playlist, so a TikTok, Facebook or
       YouTube link that happens to sit in a playlist still resolves to the one
       video that was asked for. --playlist-end caps a pathological post rather
       than trusting it; Instagram allows 20.

       The socket timeout is per-caller for the same reason: 15s is right for
       hosts that answer, and wrong for Instagram, which under rate-limiting
       stalls a connection it fully intends to serve. */
    const args = ["-J"];
    args.push(...(opts.playlist ? ["--playlist-end", String(opts.playlistEnd || 20)] : ["--no-playlist"]));
    args.push("--socket-timeout", String(opts.socketTimeout || DEFAULT_SOCKET_TIMEOUT));

    /* Fewer internal retries, not more. yt-dlp's default is 3 extractor
       attempts with a growing sleep between them, which is how a 25s budget
       was being spent entirely inside one yt-dlp process that then got killed
       with nothing to show. Capping it means a failing attempt reports back
       while there is still budget left, and the retry above -- a fresh
       process, fresh connections -- is the one that gets the second go. */
    if (opts.extractorRetries != null) {
      args.push("--extractor-retries", String(opts.extractorRetries));
    }
    if (opts.playerClient) args.push(...playerClientArgs(opts.playerClient));

    if (selector) {
      args.push("-f", selector);
      if (FORMAT_SORT) args.push("-S", FORMAT_SORT);
    }
    args.push(...jar.args, url);

    const attempt = opts.attempt || 1;
    const label = opts.label || "ytdlp";
    const started = Date.now();

    // Args as an array + no shell: the URL can never be interpreted as a command.
    const child = spawnYtdlp(args, `${label}:metadata`);

    console.log(
      `[${label}] extract attempt ${attempt}: timeout ${timeoutMs}ms, ` +
      `socket ${opts.socketTimeout || DEFAULT_SOCKET_TIMEOUT}s, ` +
      `${opts.playlist ? "playlist" : "single"}, cookies=${COOKIE_FILE ? "yes" : "no"}`
    );

    /* Every exit from this promise goes through here, so the duration line is
       printed exactly once per attempt whatever happened -- and the child is
       killed exactly once. An abandoned yt-dlp holds a socket and a cookie
       copy open for as long as it likes, which on a 512MB box is how a service
       ends up wedged after a handful of slow posts. */
    let settled = false;
    let timer = null;   // declared before finish() so an early spawn error is safe
    const finish = (outcome, fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.log(`[${label}] extract attempt ${attempt} ${outcome} in ${Date.now() - started}ms`);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      jar.done();
      fn();
    };

    let out = "";
    let err = "";
    timer = setTimeout(() => {
      finish("timed out", () => {
        reject(Object.assign(new Error(
          `Timed out after ${timeoutMs}ms reading that link` +
          (attempt > 1 ? " (second attempt)" : "") + "."
        ), {
          code: "timeout",
          stderr: err,
          detail: redact(err.trim()) || null
        }));
      });
    }, timeoutMs);

    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => {
      finish("could not start", () => {
        reject(Object.assign(new Error(redact(`Could not run yt-dlp (${YTDLP}): ${e.message}`)), {
          code: "tool_missing",
          stderr: "",
          detail: null
        }));
      });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const info = toolError(err, "yt-dlp");
        const e = new Error(info.error);
        e.code = info.code;
        e.detail = info.detail;
        e.exitCode = code;
        // Keep the raw text too: the routes read it to tell "this post holds
        // only images" apart from a genuine failure, and that match needs the
        // original string rather than the redacted one.
        e.stderr = err;
        return finish(`failed (exit ${code}, ${e.code})`, () => reject(e));
      }
      try {
        const parsed = JSON.parse(out);
        finish("ok", () => resolve(parsed));
      } catch (e) {
        finish("returned unparseable JSON", () => {
          reject(Object.assign(new Error(`yt-dlp returned unparseable JSON: ${e.message}`), {
            code: "bad_json",
            stderr: err,
            detail: redact(out.slice(0, 500)) || null
          }));
        });
      }
    });
  });
}

/* --------------------------------------------------------------------------
   Image-only posts

   yt-dlp raises this rather than returning an empty result, and it is the one
   Instagram failure that is not a failure of ours: the post parsed, the
   session worked, there is simply no video in it. It gets its own message so
   nobody goes looking for a cookie problem that isn't there.

   For an instagram.com/p/ URL this is the hand-off point to gallery-dl, which
   can see the images yt-dlp cannot. For anything else -- a reel, a story, a
   different platform -- it is the end of the line and returns a clear error.
   -------------------------------------------------------------------------- */

/* yt-dlp has more than one way of saying "this post holds no video", and which
   one you get depends on how far the extractor got:

     "There is no video in this post"   the extractor recognised the post and
                                        found only image nodes
     "No video formats found!"          it produced an info dict with an empty
                                        format list, which is what an image
                                        post looks like from the format layer

   Matching only the first was a real bug: an image post that reported the
   second threw out of /api/info as a hard failure, discarding the gallery-dl
   result that was already in flight beside it. Both mean the same thing to
   this server -- hand over to gallery-dl -- so both are matched here.

   Deliberately not included: "Requested format is not available". That is a
   selector problem on a post that does have video, and ytdlpJson() already
   retries it without the selector; treating it as "no video" would route a
   perfectly good video post to the photo extractor. */
const NO_VIDEO_RE = /there is no video in this post|no video formats found|no video could be found in this post/i;

/** True when yt-dlp is saying "no video here", however it phrased it. */
const saysNoVideo = (err) =>
  NO_VIDEO_RE.test(err?.stderr || "") || err?.code === "no_formats";

/* --------------------------------------------------------------------------
   Where photo media is allowed to come from.

   gallery-dl's output is not user input, but it is derived from a user-supplied
   URL, and this process will fetch whatever comes back -- so pin the
   destination the same way classify() pins the source. Without this, the photo
   route is the SSRF hole the host allowlist exists to prevent.
   -------------------------------------------------------------------------- */

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

/* --------------------------------------------------------------------------
   Instagram post shape

   A /p/ link can be one video or a carousel of several, and --no-playlist made
   the server blind to the difference: it returns whichever item yt-dlp picked
   and says nothing about its siblings.

   Dropping --no-playlist for post URLs settles it without a second tool. A
   carousel comes back as `_type: "playlist"` with one `entries` element per
   item, each carrying its own `vcodec`, `ext` and `thumbnail`; a single post
   has no entries and describes itself. Both shapes go through the same
   reader below, so the post structure is a free by-product of the extraction
   /api/info already performs.

   Known limit, stated plainly: yt-dlp's Instagram extractor skips non-video
   nodes, so images in a mixed carousel do not appear in `entries` and an
   image-only post raises NO_VIDEO_RE. Item indices therefore count videos.
   -------------------------------------------------------------------------- */

/** The Instagram URL shapes that address a post rather than a profile. */
const IG_POST_RE = /instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|stories)\//i;

const VIDEO_EXT_RE = /\.(mp4|mov|m4v|webm)(?:$|[?#])/i;
const PHOTO_EXT_RE = /\.(jpe?g|png|webp|heic|gif)(?:$|[?#])/i;

/** photo | video, from whatever evidence is available, best signal first. */
function itemTypeFrom(mediaUrl, meta = {}) {
  if (meta.video_url) return "video";
  if (typeof meta.typename === "string" && /video/i.test(meta.typename)) return "video";
  if (meta.is_video === true) return "video";
  if (VIDEO_EXT_RE.test(mediaUrl)) return "video";
  if (PHOTO_EXT_RE.test(mediaUrl)) return "photo";
  // Instagram CDN paths are not reliably suffixed; a video URL almost always
  // carries an mp4 marker somewhere, and what is left here is an image.
  return /\bmp4\b/i.test(mediaUrl) ? "video" : "photo";
}

/**
 * Media items for an Instagram post, read out of yt-dlp's own dump.
 *
 * A carousel comes back as a playlist: `_type: "playlist"` with an
 * `entries` array, one per item. A single post has no entries and describes
 * itself. Both shapes are handled here, so the post structure of a reel or a
 * video post comes free with the extraction /api/info already performs -- no
 * second process, which is what keeps reels off the gallery-dl path entirely.
 *
 * Videos only, necessarily: yt-dlp skips non-video nodes. Images come from
 * galleryItems() below, and only for instagram.com/p/ URLs.
 *
 * Pure, and exported, because it is the part of this that can be tested
 * without an Instagram session.
 */
function instagramItems(info) {
  if (!info || typeof info !== "object") return [];

  const entries = Array.isArray(info.entries) ? info.entries.filter(Boolean) : null;
  const list = entries && entries.length ? entries : [info];

  return list.map((entry) => {
    /* vcodec is the reliable signal: yt-dlp sets it to the literal string
       "none" for a stream with no video track. Extension is the fallback for
       entries that never got that far. */
    const vcodec = entry.vcodec || null;
    const type =
      vcodec && vcodec !== "none" ? "video"
      : vcodec === "none" ? "photo"
      : entry.ext && VIDEO_EXT_RE.test(`.${entry.ext}`) ? "video"
      : entry.ext && PHOTO_EXT_RE.test(`.${entry.ext}`) ? "photo"
      : itemTypeFrom(entry.url || "");

    return {
      type,
      url: typeof entry.url === "string" ? entry.url : null,
      thumbnail: typeof entry.thumbnail === "string" ? entry.thumbnail : null,
      title: entry.title || null
    };
  });
}

/* --------------------------------------------------------------------------
   gallery-dl: the images yt-dlp cannot see

   `gallery-dl --dump-json` carries the metadata that settles an item's type --
   `typename` (GraphImage / GraphVideo / GraphSidecar), `video_url` when an
   item is a video, and `display_url`, which is the still frame *even for
   videos*, so a carousel gets a thumbnail for an item that is not a photo.

   `-g` is the fallback: it prints URLs and nothing else, so the type has to be
   inferred from the extension. Worse than reading metadata, much better than
   calling everything a photo.

   Everything here is best-effort by construction. Every entry point resolves
   to an empty list rather than rejecting, because a failure to enumerate
   images must never be able to fail a request whose videos yt-dlp already
   found.
   -------------------------------------------------------------------------- */

/* Item lists share the plan cache rather than getting a Map of their own: same
   URL key, same TTL, same eviction. Not a real selector, so it cannot collide
   with one. */
const GALLERY_CACHE_KEY = "\\u0000gallery-items";

/** Parse `gallery-dl --dump-json` into media items. */
function parseGalleryItems(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const items = [];
  for (const msg of parsed) {
    // Messages are [type, url, metadata] tuples; anything else is progress
    // chatter and is skipped rather than guessed at.
    if (!Array.isArray(msg) || msg.length < 2) continue;
    const mediaUrl = typeof msg[1] === "string" ? msg[1] : null;
    if (!mediaUrl) continue;

    const meta = msg.length > 2 && msg[2] && typeof msg[2] === "object" ? msg[2] : {};
    const type = itemTypeFrom(mediaUrl, meta);

    /* display_url is the still frame even for videos, which is the entire
       reason for preferring --dump-json. A photo is its own thumbnail. */
    const thumbnail = typeof meta.display_url === "string" ? meta.display_url
      : type === "photo" ? mediaUrl
      : null;

    items.push({ type, url: mediaUrl, thumbnail });
  }
  return items;
}

/**
 * Cancellation for a gallery-dl run that nobody is waiting for any more.
 *
 * The images are fetched concurrently with the yt-dlp extraction, so when that
 * extraction fails the request answers immediately -- and would leave
 * gallery-dl running against Instagram for the rest of its budget, holding a
 * connection to the platform that is already rate-limiting us. Its own timeout
 * would eventually reap it, but "eventually" is the wrong answer for a process
 * whose result is already known to be unwanted.
 */
function abortGallery(ctl) {
  if (!ctl || ctl.cancelled) return;
  ctl.cancelled = true;
  const child = ctl.child;
  if (child && child.exitCode === null && child.signalCode === null) {
    console.log("[gallery-dl] cancelled: the request it belonged to has already failed");
    child.kill("SIGKILL");
  }
}

/** Run gallery-dl, buffer stdout, kill it if it outstays its budget. */
function spawnGallery(url, args, timeoutMs, label, ctl = {}) {
  return new Promise((resolve, reject) => {
    if (ctl.cancelled) return reject(Object.assign(new Error("cancelled"), { code: "cancelled" }));

    const jar = cookieSession("instagram");
    const final = [...args, ...jar.args, url]; // array + no shell: never a command
    const started = Date.now();

    console.log(`[gallery-dl:${label}] ${GALLERYDL} ${final.join(" ")}`);

    const child = spawn(GALLERYDL, final);
    ctl.child = child;   // so abortGallery() can reach it

    let out = "";
    let err = "";
    let settled = false;
    let timer = null;

    // One exit path, so the duration is logged once and the child is never
    // left running -- the failure that produced "[gallery-dl] exit null".
    const finish = (outcome, fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.log(`[gallery-dl:${label}] ${outcome} in ${Date.now() - started}ms`);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      jar.done();
      fn();
    };

    timer = setTimeout(() => {
      finish(`timed out after ${timeoutMs}ms`, () => {
        reject(Object.assign(new Error(`gallery-dl timed out after ${timeoutMs}ms`), {
          code: "timeout", stderr: err
        }));
      });
    }, timeoutMs);

    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });

    child.on("error", (e) => {
      finish(`could not start (${e.code || e.message})`, () => {
        reject(Object.assign(new Error(redact(`Could not run gallery-dl (${GALLERYDL}): ${e.message}`)), {
          code: "tool_missing", stderr: ""
        }));
      });
    });

    child.on("close", (code) => {
      if (code !== 0) {
        return finish(`exit ${code}`, () => {
          reject(Object.assign(new Error(meaningfulLines(err).join(" ") || `gallery-dl exited ${code}`), {
            code: classifyError(err), stderr: err, exitCode: code
          }));
        });
      }
      finish("ok", () => resolve(out));
    });
  });
}

/**
 * Every media item in an instagram.com/p/ post, images included.
 *
 * Never rejects. gallery-dl is an enhancement to what yt-dlp found, so a
 * failure here costs images and nothing else -- the caller keeps whatever
 * yt-dlp gave it. Every reason for returning nothing is logged, because
 * "the carousel only shows videos" is otherwise indistinguishable from
 * "the carousel only has videos".
 */
async function galleryItems(url, timeoutMs = GALLERYDL_TIMEOUT_MS, ctl = {}) {
  if (!IG_PHOTO_POST_RE.test(String(url))) return [];   // reels never come here
  if (!GALLERYDL_STATUS.available) {
    console.warn(`[gallery-dl] not installed (${GALLERYDL_STATUS.reason}); images unavailable for ${url}`);
    return [];
  }

  /* /api/info enumerated this post seconds ago and the visitor has just
     clicked one of the items it advertised. Reusing that list is not only
     faster, it is the thing that makes index N mean the same on both calls --
     a second gallery-dl run could in principle return a different order. */
  const cached = cachedPlan(url, GALLERY_CACHE_KEY);
  if (cached) {
    console.log(`[gallery-dl] ${cached.length} item(s) for ${url} (cached)`);
    return cached;
  }

  try {
    const raw = await spawnGallery(url, ["--dump-json", "--quiet"], timeoutMs, "dump-json", ctl);
    const items = parseGalleryItems(raw).filter((it) => isAllowedMedia(it.url));
    if (items.length) {
      console.log(`[gallery-dl] ${items.length} item(s) for ${url}: ${items.map((i) => i.type).join(", ")}`);
      rememberPlan(url, GALLERY_CACHE_KEY, items);
      return items;
    }
    console.warn("[gallery-dl] --dump-json returned no usable items; falling back to -g");
  } catch (e) {
    console.warn(`[gallery-dl] --dump-json failed (${e.code || e.message}); falling back to -g`);
  }

  /* -g is a second process, and it is worth it only because it is the
     difference between a photo post working and not. It gets what is left of
     the budget, halved, so the fallback cannot double the wait. */
  try {
    const raw = await spawnGallery(url, ["-g", "--quiet"], Math.max(10_000, Math.floor(timeoutMs / 2)), "urls", ctl);
    const urls = raw.split("\n").map((s) => s.trim()).filter(Boolean).filter(isAllowedMedia);
    if (!urls.length) {
      console.warn(`[gallery-dl] -g returned nothing usable for ${url}`);
      return [];
    }
    console.log(`[gallery-dl] ${urls.length} url(s) for ${url} via -g (types inferred from extension)`);
    const items = urls.map((u) => ({
      type: itemTypeFrom(u),
      url: u,
      thumbnail: itemTypeFrom(u) === "photo" ? u : null
    }));
    rememberPlan(url, GALLERY_CACHE_KEY, items);
    return items;
  } catch (e) {
    console.error(`[gallery-dl] item lookup failed entirely for ${url}: ${e.code || e.message}`);
    return [];
  }
}

/** single_photo | single_video | carousel. Null when there is nothing to say. */
function classifyPostType(items) {
  if (!items || !items.length) return null;
  if (items.length > 1) return "carousel";
  return items[0].type === "video" ? "single_video" : "single_photo";
}

/**
 * The `postType` / `items` block added to an Instagram /api/info response.
 *
 * Additive on purpose. Every field that existed before still means what it
 * meant, so a client that ignores these two keys behaves exactly as it did.
 *
 * `download` is a path rather than an absolute URL because the server sits
 * behind a proxy and does not reliably know its own public origin -- the
 * client already has that and prefixes API_BASE. It points at the existing
 * item endpoint, so no new download route was needed.
 *
 * Returns {} when there is nothing to add, which keeps the spread at the call
 * sites harmless for every other platform.
 */
function describePost(items, url, platform) {
  if (platform !== "instagram") return {};

  const postType = classifyPostType(items);
  if (!postType) return {};

  const q = encodeURIComponent(url);
  return {
    postType,
    itemCount: items.length,
    items: items.map((it, i) => ({
      index: i,
      type: it.type,
      // The proxied endpoint, not a CDN URL: those are header-locked and
      // expire, which is the reason this server exists at all.
      download: `/api/download?url=${q}&format=photo&i=${i}`,
      thumbnail: it.thumbnail
    }))
  };
}

/* --------------------------------------------------------------------------
   Error reporting

   These used to flatten every failure into one of five sentences, which is
   fine for a visitor and useless for anyone trying to work out why. "That
   video is unavailable or has been removed" was returned for a bot check, an
   expired session, a 403, and a genuinely deleted video alike -- four
   different problems with four different fixes.

   So the real text comes back now. `error` is the tool's own message, `code`
   is a machine-readable classification, and `detail` is the full stderr.

   REDACTION. These responses go to anyone who can reach the API, and yt-dlp
   happily prints absolute paths (`/etc/secrets/cookies.txt` tells a stranger
   both that a session exists and where it lives) and signed CDN URLs with
   credentials in the query string. Neither helps you debug: the diagnostic
   signal is the status code and the sentence, not the filesystem layout. So
   paths collapse to their basename and query strings are stripped, and
   everything else passes through untouched. Set RAW_ERRORS=1 to disable that
   if you'd rather have it verbatim.

   The unredacted text is always logged server-side regardless.
   -------------------------------------------------------------------------- */

// RAW_ERRORS is declared at the top of the file: the cookie loader redacts
// paths while reporting itself at boot, which happens before this point.

function redact(text) {
  if (RAW_ERRORS) return text;
  return String(text)
    // Signed media URLs: keep the host so you can see who refused you, drop
    // the query string, which is where the tokens live.
    .replace(/(https?:\/\/[^\s?"']+)\?[^\s"']*/gi, "$1?<redacted>")
    // Absolute paths, POSIX and Windows, down to the last segment.
    .replace(/(?:\/[\w.-]+)+\/([\w.-]+)/g, "…/$1")
    .replace(/[A-Za-z]:\\(?:[\w.-]+\\)+([\w.-]+)/g, "…\\$1");
}

/** The lines that actually say something, newest-first-ish, without the noise. */
function meaningfulLines(stderr) {
  const lines = String(stderr || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    // Python tracebacks are frames, not reasons; the reason is the last line.
    .filter((l) => !/^(File "|\s{2,}|Traceback)/.test(l));

  const errors = lines.filter((l) => /^(ERROR|yt-dlp: error)/i.test(l));
  return errors.length ? errors : lines;
}

/** Coarse classification, for log-grepping and for the frontend to branch on. */
function classifyError(stderr) {
  const s = String(stderr || "").toLowerCase();
  if (/sign in to confirm|not a bot|captcha/.test(s)) return "bot_check";
  if (/http error 429|too many requests/.test(s)) return "rate_limited";
  if (/http error 403|403 forbidden/.test(s)) return "http_403";
  if (/http error 401|401 unauthorized/.test(s)) return "http_401";
  if (/private video|members-only|login required|requires authentication|account.*private/.test(s)) {
    return "login_required";
  }
  if (/cookies/.test(s)) return "cookies";
  if (/unsupported url/.test(s)) return "unsupported_url";
  if (/geo|not available in your country|blocked it in your country/.test(s)) return "geo_blocked";
  if (/requested format is not available|requested format was not available/.test(s)) {
    return "format_unavailable";
  }
  /* YouTube's other refusal, and it does not look like one. When a client
     needs a PO token and hasn't got one, YouTube returns a player response
     with the formats stripped out rather than an error -- measured on this
     build against `web`, `web_safari` and `ios` with no cookies. It reads like
     a broken video and is really "this client is not allowed to have this",
     which is why it gets its own code: it is the second thing the player-client
     fallback exists to get past. */
  if (/no video formats found|requested format is not available.*only images/.test(s)) return "no_formats";
  if (/unable to extract|extractorerror|failed to parse/.test(s)) return "extractor_error";
  if (/http error 404|not found|does not exist|video unavailable|has been removed|been terminated/.test(s)) {
    return "unavailable";
  }
  if (/timed out|timeout|connection reset|temporary failure in name resolution/.test(s)) {
    return "network";
  }
  return "unknown";
}

/**
 * Build the error payload for a failed yt-dlp run.
 *
 * `tool` only shapes the fallback sentence for the case where the process died
 * without saying anything -- a SIGKILL from the timeout, typically.
 */
function toolError(stderr, tool = "yt-dlp") {
  const code = classifyError(stderr);
  const lines = meaningfulLines(stderr);

  let message = lines.length
    ? redact(lines.slice(-3).join(" "))
    : `${tool} failed without reporting a reason (it may have been killed by the timeout).`;

  /* The one thing the tool cannot tell you, because it doesn't know: what this
     server did about a session. "Sign in to confirm you're not a bot" looks
     identical whether the file was missing, unreadable, misnamed, full of
     cookies for other sites, or expired -- five different fixes. So an
     auth-shaped failure carries the loader's own findings, and the caller gets
     the paths that were checked rather than a guess.

     Plain ASCII in these strings on purpose: they end up in logs and consoles
     whose encoding is not always UTF-8, and a mangled em-dash reads like a bug. */
  const authShaped = ["bot_check", "login_required", "http_403", "http_401", "cookies"].includes(code);
  let cookies;

  if (authShaped) {
    cookies = cookieSummary();
    if (!COOKIE_STATUS.loaded) {
      const tried = COOKIE_STATUS.checked.length
        ? COOKIE_STATUS.checked
            .map((c) => `${c.path} (${c.exists ? (c.readable ? "exists" : "exists, UNREADABLE") : "missing"})`)
            .join("; ")
        : "no candidate paths";
      message +=
        COOKIE_STATUS.dropped > 0
          ? ` [cookie file was read but held no entries for this platform: ` +
            `${COOKIE_STATUS.dropped} entries, all for other sites]`
          : ` [no cookie jar loaded. Checked: ${tried}]`;
    } else {
      const platform = COOKIE_PLATFORM_DOMAINS.find((d) => new RegExp(d.split(".")[0], "i").test(stderr || ""));
      const n = platform ? cookiesForDomain(platform) : null;
      message +=
        n === 0
          ? ` [cookie jar loaded from ${COOKIE_STATUS.source} but it has no ${platform} entries]`
          : ` [cookie jar loaded from ${COOKIE_STATUS.source}` +
            `${n ? ` with ${n} ${platform} entries` : ""}; the session is likely expired]`;
    }
  }

  return {
    error: message,
    code,
    detail: redact(String(stderr || "").trim()) || null,
    ...(cookies ? { cookies } : {})
  };
}

/**
 * The response body for a failed extraction, with Instagram's own footnote.
 *
 * yt-dlp's message survives verbatim -- that rule does not change here. What
 * gets added is the one thing yt-dlp cannot know: whether a session was sent.
 *
 * It matters because Instagram's two failure modes look identical from the
 * outside. An anonymous request from a datacenter IP is not refused, it is
 * *stalled*, so a missing cookie jar reads as "timed out" and sends everyone
 * hunting for a network problem. An expired jar behaves the same way. Both are
 * cookie problems with a timeout's face, so a timeout says which one it is
 * rather than leaving the logs to be read backwards.
 *
 * toolError() already covers the failures that arrive labelled as auth
 * problems; this covers the ones that don't.
 */
function extractionFailure(err, platform) {
  const payload = {
    error: err.message + (err.retried ? " (tried twice)" : ""),
    code: err.code || "unknown",
    detail: err.detail || null
  };

  if (platform !== "instagram" || !RETRYABLE_CODES.has(payload.code)) return payload;

  const have = cookiesForDomain("instagram.com");
  payload.error += have
    ? ` [${have} instagram.com cookies were sent from ${COOKIE_STATUS.source}. ` +
      "If this keeps happening the session has most likely expired -- export a fresh cookies.txt.]"
    : " [No instagram.com cookies are loaded, so this request was anonymous. " +
      "Instagram throttles anonymous requests from datacenter IPs by stalling them, " +
      "which is what a timeout here usually means. Add instagram.com entries to cookies.txt.]";
  payload.cookies = cookieSummary();

  return payload;
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

/* Health carries the cookie state so "is the Secret File actually being read?"
   can be answered without triggering a download and reading the logs. Counts
   and paths only -- never a cookie name or value. */
app.get("/api/health", (_req, res) => res.json({
  ok: true,
  cookies: cookieSummary(),
  jsRuntime: JS_RUNTIME_STATUS,
  // Instagram's extraction budget, since it is the one that gets hit.
  instagramTimeoutMs: IG_TIMEOUT_MS,
  /* Photo support, separately from video: it has its own binary, its own way
     of being absent, and losing it costs images only. */
  galleryDl: { ...GALLERYDL_STATUS, timeoutMs: GALLERYDL_TIMEOUT_MS, usedFor: "instagram.com/p/ only" }
}));

/* --------------------------------------------------------------------------
   GET /api/info -- metadata for the result panel
   -------------------------------------------------------------------------- */

app.get("/api/info", rateLimit, async (req, res) => {
  const url = req.query.url;
  const platform = classify(url);

  if (!platform) {
    return res.status(400).json({ error: "Unsupported link. Use TikTok, Instagram, Facebook or YouTube.", code: "unsupported_link", detail: null });
  }

  /* Instagram only, and only for URLs that address a post: enumerating a
     carousel means letting yt-dlp treat the post as the playlist it is. It
     costs nothing on a single-item post -- there is no playlist to walk -- and
     nothing else changes shape, because TikTok, Facebook and YouTube never
     enter this branch and keep --no-playlist exactly as before. */
  const wantsItems = platform === "instagram" && IG_POST_RE.test(String(url));

  /* The images. Started here rather than awaited here so it overlaps the yt-dlp
     extraction instead of following it -- both are network round-trips and
     Instagram is the platform that can least afford them in series.

     Only instagram.com/p/ ever gets this far: galleryItems() returns [] for
     everything else, so a reel spawns nothing, and TikTok, Facebook and
     YouTube never reach this line at all.

     .catch() belts the braces. galleryItems() already swallows everything, but
     this promise is not awaited on every path out of the handler, and an
     unhandled rejection takes the process down on modern Node. */
  const galleryCtl = {};
  const photosPromise = wantsItems
    ? galleryItems(url, GALLERYDL_TIMEOUT_MS, galleryCtl).catch(() => [])
    : Promise.resolve([]);

  try {
    let info = null;
    let ytdlpError = null;
    try {
      /* Extract against the default download selector, not bare. The response
         is identical either way, but the dump then also carries the plan the
         download route needs -- so the click that follows this call costs no
         extraction at all. */
      info = await ytdlpJson(url, timeoutFor(platform), FORMATS.hd, extractOpts(platform, wantsItems));
      rememberPlan(url, FORMATS.hd, info);
    } catch (err) {
      /* "No video here" is not a failure on Instagram -- the post parsed, the
         session worked, it simply holds images, and for a /p/ URL that is the
         hand-off to gallery-dl already running beside this.

         Instagram-only, and the guard is load-bearing rather than tidiness:
         "No video formats found" is a *YouTube* string too, where it means a
         player client was refused a PO token. Letting that through here would
         answer a YouTube failure with "that post holds no video, and its
         images could not be read", which is both wrong and unactionable.
         TikTok, Facebook and YouTube keep the error path they had. */
      if (!(platform === "instagram" && saysNoVideo(err))) throw err;
      ytdlpError = err;
      console.log(
        `[${platform}] yt-dlp found no video in ${url} (${err.code || "no_video"}); ` +
        "handing over to gallery-dl for the images"
      );
    }

    /* Images win the item list when there are any.

       gallery-dl sees every node in a post; yt-dlp sees only the video ones.
       So on a mixed carousel yt-dlp's list is a strict subset, and taking it
       would silently drop the photos -- which is the bug this exists to fix.
       When gallery-dl found nothing (not installed, timed out, failed), the
       yt-dlp list is what is left and the post still shows its videos. */
    const photos = await photosPromise;
    const items = photos.length ? photos : (wantsItems && info ? instagramItems(info) : []);
    const itemSource = photos.length ? "gallery-dl" : "yt-dlp";

    if (wantsItems) {
      console.log(
        `[${platform}] ${url}: ${items.length} item(s) from ${itemSource}` +
        (photos.length && info ? ` (yt-dlp saw ${instagramItems(info).length} video item(s))` : "")
      );
    }

    /* An image-only post: yt-dlp declined and gallery-dl is all there is. This
       is the shape the photo route has always returned, so a client that
       handled photo posts before handles this one unchanged. */
    if (!info) {
      if (!items.length) {
        console.warn(`[${platform}] no video and no images recoverable for ${url}`);
        return res.status(GALLERYDL_STATUS.available ? 502 : 501).json({
          error: GALLERYDL_STATUS.available
            ? "That post holds no video, and its images could not be read."
            : "That post holds only images, and gallery-dl -- which reads them -- is not installed on this server.",
          code: GALLERYDL_STATUS.available ? "no_items" : "gallerydl_missing",
          detail: ytdlpError?.detail || null
        });
      }

      const shape = describePost(items, url, platform);
      const photoCount = items.filter((i) => i.type === "photo").length;
      return res.json({
        kind: "photo",
        platform,
        platformName: PLATFORMS[platform].name,
        title: items.length > 1
          ? `${PLATFORMS[platform].name} carousel`
          : `${PLATFORMS[platform].name} photo`,
        count: items.length,
        quality: items.length > 1 ? `${items.length} items` : "Original",
        size: null,      // the CDN reports it per-image; not worth 10 HEAD requests
        duration: null,
        thumbnail: items[0].thumbnail || items[0].url,
        photoCount,
        ...shape
      });
    }

    // Prefer a real reported size; fall back to yt-dlp's estimate.
    const size = info.filesize || info.filesize_approx ||
      (info.formats || []).map((f) => f.filesize || f.filesize_approx || 0).sort((a, b) => b - a)[0];

    const height = info.height ||
      Math.max(0, ...(info.formats || []).map((f) => f.height || 0));

    const shape = describePost(items, url, platform);

    // A carousel's playlist dict carries no thumbnail of its own; its first
    // item does. Same for the title, which otherwise reads "Untitled video".
    const lead = (info.entries || []).find(Boolean) || info;

    res.json({
      kind: shape.postType === "carousel" ? "carousel" : "video",
      platform,
      platformName: PLATFORMS[platform].name,
      title: info.title || lead.title || info.description?.slice(0, 90) || "Untitled video",
      uploader: info.uploader || info.channel || lead.uploader || null,
      duration: humanTime(info.duration ?? lead.duration),
      quality: height ? `${height}p${height >= 720 ? " • HD" : ""}` : "Best available",
      size: humanSize(size),
      thumbnail: info.thumbnail || lead.thumbnail || null,
      ...shape
    });
  } catch (err) {
    /* The answer is already known, so nothing is waiting on the images any
       more -- and leaving gallery-dl running would hold a connection open to
       the platform that is already refusing us. */
    abortGallery(galleryCtl);
    console.error(`[${platform}] /api/info failed (${err.code || "?"}): ${err.stderr || err.message}`);
    res.status(502).json(extractionFailure(err, platform));
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
async function streamMerged(req, res, url, format, platform, allowRetry = true, opts = {}) {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-mux-"));
  } catch {
    return res.status(500).json({ error: "Server has no writable temp space.", code: "no_temp_space", detail: null });
  }

  /* The jar gets its own directory, deliberately not this one: the merged file
     is found by reading `dir` back and taking what's there, so anything else
     dropped alongside it could be streamed to the visitor as their video. */
  const jar = cookieSession(platform);

  // %(ext)s, not a fixed .mp4: yt-dlp names the merged file itself, and
  // guessing wrong means streaming a file that isn't there.
  const template = path.join(dir, "video.%(ext)s");
  let done = false;
  const cleanup = () => {
    jar.done(); // safe to call twice; the close handler usually gets there first
    if (done) return;
    done = true;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  };

  /* A null selector means "let yt-dlp choose", which is what the retry below
     falls back to. Its default is bv*+ba/b, so it resolves whenever the video
     has any format at all -- and -S still applies, so H.264 is still preferred.
     There is no third attempt: if yt-dlp's own default cannot be satisfied,
     the video genuinely has nothing to download. */
  const args = [];
  if (format) args.push("-f", format);
  args.push(
    // The merge target. --remux-video covers the other half: when the selector
    // falls through to a single progressive stream there is nothing to merge,
    // and this is what turns a lone .webm into the .mp4 we promised.
    "--merge-output-format", "mp4",
    "--remux-video", "mp4",
    // DASH video arrives as hundreds of small fragments fetched one at a time,
    // which is latency-bound rather than bandwidth-bound. Pulling 8 at once is
    // most of the wall-clock win here, and it matters more than it used to now
    // that nothing reaches the visitor until the merge finishes.
    "--concurrent-fragments", "8",
    /* --no-playlist unless a specific carousel item was asked for, in which
       case --playlist-items names it. yt-dlp indexes from 1; the API from 0,
       and the conversion happens at the one call site that has the index. */
    ...(opts.playlistItem
      ? ["--playlist-items", String(opts.playlistItem)]
      : ["--no-playlist"]),
    "--no-part",
    "--socket-timeout", socketTimeoutFor(platform)
  );
  // Codec preference, applied to every branch of the selector at once. See the
  // format-selection note above for why this is a sort and not a filter.
  if (FORMAT_SORT) args.push("-S", FORMAT_SORT);
  if (opts.playerClient) args.push(...playerClientArgs(opts.playerClient));
  if (FFMPEG_LOCATION) args.push("--ffmpeg-location", FFMPEG_LOCATION);
  args.push(...jar.args, "-o", template, url);

  const dl = spawnYtdlp(args, `${platform}:merge`);

  let err = "";
  dl.stderr.on("data", (d) => { err += d; });

  // A merge is slow; give it far longer than a straight copy, but not forever.
  const timer = setTimeout(() => { dl.kill("SIGKILL"); }, 240_000);

  // Visitor cancelled before the merge finished — stop and bin the temp dir.
  res.on("close", () => {
    if (!dl.killed) dl.kill("SIGKILL");
    cleanup();
  });

  dl.on("error", (e) => {
    clearTimeout(timer);
    cleanup();
    if (!res.headersSent) {
      res.status(500).json({
        error: redact(`Could not run yt-dlp (${YTDLP}): ${e.message}`),
        code: "tool_missing",
        detail: null
      });
    }
  });

  dl.on("close", (code) => {
    clearTimeout(timer);
    // Drop the jar copy as soon as yt-dlp lets go of it — the video temp dir
    // has to outlive this handler to be streamed, but the cookies don't.
    jar.done();
    if (res.destroyed) return cleanup();

    if (code !== 0) {
      // Unredacted, and the whole thing: the logs are yours, the response is
      // the internet's.
      console.error(`[${platform}] yt-dlp exit ${code} (merge path):\n${err.trim()}`);
      cleanup();

      /* Last resort, and the one that makes "never fail because a format is
         missing" true rather than aspirational: if this selector could not be
         satisfied, drop it and let yt-dlp pick. Nothing has been written yet
         -- headers on this path are only set once the file is complete -- so
         the retry is invisible to the visitor. */
      // Not `code` -- that is the close handler's exit-status parameter, and
      // shadowing it here puts every use above this line in the temporal dead
      // zone. Cost of learning that: one crashed server.
      const failureCode = classifyError(err);

      if (allowRetry && format && failureCode === "format_unavailable" && !res.headersSent) {
        console.warn(
          `[${platform}] selector "${format}" not satisfiable; retrying with yt-dlp's own choice`
        );
        return streamMerged(req, res, url, null, platform, false, opts);
      }

      /* YouTube refused the session on the download itself. Same fallback the
         metadata call makes, for the same reason -- and available here too,
         because nothing has been written yet: headers on this path are only
         set once the file is complete, so the retry is invisible. */
      if (canRetryAsClient(platform, failureCode, opts.playerClient) && !res.headersSent) {
        console.warn(
          `[${platform}] refused (${failureCode}) on the merge path; ` +
          `retrying as player_client=${YT_FALLBACK_CLIENT}`
        );
        return streamMerged(req, res, url, format, platform, allowRetry, {
          ...opts, playerClient: YT_FALLBACK_CLIENT
        });
      }

      if (!res.headersSent) res.status(502).json(toolError(err, "yt-dlp"));
      return;
    }

    const files = (() => {
      try { return fs.readdirSync(dir); } catch { return []; }
    })();
    if (!files.length) {
      console.error(`[${platform}] yt-dlp exited 0 but produced no file. stderr:\n${err.trim()}`);
      cleanup();
      return res.status(502).json({
        error: "yt-dlp exited successfully but produced no file.",
        code: "no_output",
        detail: redact(err.trim()) || null
      });
    }

    /* The largest file, not the first. A completed merge leaves exactly one
       file behind, but if yt-dlp ever leaves a fragment next to it, readdir
       order is not defined to put the finished video first -- and the
       alphabetically-first name is usually the `.fNNN.m4a` audio fragment,
       which would stream out as an MP4 with no picture. */
    const file = files
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];

    /* Last line of defence: confirm there is actually a video track before
       calling this an MP4. Serving an audio stream under video/mp4 is the one
       failure a visitor cannot diagnose -- it plays, it just has no picture --
       so it fails loudly here instead. */
    const codec = videoCodec(file);
    if (codec === "") {
      /* Reached this with a deliberately broken ffmpeg during testing: yt-dlp
         exits 0, the merge never happens, and the only thing left in the
         directory is the `.fNNN.m4a` audio fragment. So say that, rather than
         just "no video" -- a failed merge is far and away the likeliest cause,
         and the file list is the evidence. */
      console.error(
        `[${platform}] no video stream in ${path.basename(file)}; ` +
        `merge likely failed. dir: [${files.join(", ")}] stderr:\n${err.trim()}`
      );
      cleanup();
      if (!res.headersSent) {
        res.status(502).json({
          error:
            `The finished file has no video stream — the merge appears to have failed ` +
            `(kept "${path.basename(file)}" of [${files.join(", ")}], selector: ${format}). ` +
            `Check that ffmpeg is present and runnable.`,
          code: "no_video_stream",
          detail: redact(err.trim()) || null
        });
      }
      return;
    }
    console.log(`[${platform}] serving ${path.basename(file)} (${codec || "codec unknown"})`);

    const size = fs.statSync(file).size;
    // extname of the file actually chosen, not files[0] -- they are the same
    // in the normal case and the point of choosing by size is the case where
    // they aren't.
    const filename = safeFilename(res.locals.title || "video", path.extname(file).slice(1) || "mp4");

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
 * Pipe a single already-muxed stream straight to the browser.
 *
 * The fast path, and the common one off YouTube: TikTok, Instagram and
 * Facebook publish one progressive MP4 that already carries audio, so there is
 * nothing to merge and nothing for ffmpeg to do. Staging that to disk only to
 * read it back means the visitor stares at a dead page for the entire download
 * before the browser even starts saving -- measured at 10s for a 615KB file,
 * where 6.5s of it was overhead and the rest was waiting for a file that was
 * already complete.
 *
 * Here the headers go out first and bytes flow as they arrive, so the save
 * dialog appears almost immediately and the transfer is the only cost.
 *
 * Only called when the plan says one stream, mp4, with a video track -- see
 * the routing note in /api/download. Anything else still takes the merge path,
 * because that is what can guarantee a seekable, remuxed MP4.
 */
function streamProgressive(req, res, url, plan, title, platform, selector, opts = {}) {
  const filename = safeFilename(title, "mp4");

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename.replace(/[^\x20-\x7E]/g, "_")}"; ` +
    `filename*=UTF-8''${encodeURIComponent(filename)}`
  );

  /* No Content-Length, deliberately. The plan's size belongs to the format id
     below, and that id is now allowed to fall back to a different one -- a
     Content-Length that disagrees with the body truncates the file, which is
     a far worse outcome than a download with no percentage on it. */

  const jar = cookieSession(platform);

  /* No format id here, deliberately. A format id is a fact about one
     extraction, not a permanent name: YouTube hands different clients
     different format sets, and the plan can be five minutes old, so naming an
     id is a standing invitation to "Requested format is not available" for a
     reason no visitor can act on. The plan's job is to decide *whether* this
     can be streamed; picking the format is yt-dlp's job.

     `b[ext=mp4]` says what this path actually requires: one already-muxed MP4.
     `b` is single-format by definition -- the full selector could resolve to a
     two-stream merge, and piping a merge to stdout produces MPEG-TS wearing an
     .mp4 name. `-S vcodec:h264` still applies, so H.264 wins where it exists.

     There is deliberately no `/b` fallback to any container: an unexpected
     .webm streamed out as video/mp4 would be a lie. If no muxed MP4 exists,
     the close handler re-routes to the merge path, which can remux one. */
  const args = [
    "-f", "b[ext=mp4]",
    "--no-playlist",
    "--concurrent-fragments", "8",
    "--socket-timeout", socketTimeoutFor(platform)
  ];
  if (FORMAT_SORT) args.push("-S", FORMAT_SORT);
  /* Same client the plan was built as. A format list is a fact about one
     client, so downloading as a different one is shopping from the wrong
     catalogue -- and on YouTube that surfaces as "Requested format is not
     available" for a reason nobody can act on. */
  if (opts.playerClient) args.push(...playerClientArgs(opts.playerClient));
  args.push(...jar.args, "-o", "-", url);

  const dl = spawnYtdlp(args, `${platform}:stream`);
  let failed = "";
  dl.stderr.on("data", (d) => { failed += d; });

  const cleanup = () => {
    jar.done();
    if (!dl.killed) dl.kill("SIGKILL");
  };
  res.on("close", cleanup);

  /* `end: false` is load-bearing. A plain pipe() ends the response as soon as
     yt-dlp's stdout closes -- including when it closes having produced nothing,
     which commits an empty 200 before the exit code is even known and leaves
     no way to recover. Holding the end back means a failed run that wrote
     nothing has still sent nothing, so it can be retried a different way. */
  dl.stdout.pipe(res, { end: false });

  dl.on("error", (e) => {
    cleanup();
    if (!res.headersSent) {
      res.status(500).json({
        error: redact(`Could not run yt-dlp (${YTDLP}): ${e.message}`),
        code: "tool_missing",
        detail: null
      });
    }
  });

  dl.on("close", (code) => {
    jar.done();

    // Bytes went out and the process was happy: finish the response ourselves,
    // since the pipe was told not to.
    if (code === 0 && res.headersSent) return res.end();

    if (code !== 0) {
      console.error(`[${platform}] yt-dlp exit ${code} (stream path):\n${failed.trim()}`);
    } else {
      console.error(`[${platform}] yt-dlp exited 0 on the stream path but produced no bytes`);
    }

    /* Nothing written means nothing committed, so this is still recoverable:
       hand the request to the merge path, which takes the full selector and
       can satisfy it by merging, remuxing or falling back further. Covers the
       reported failure exactly -- a format id from a cached plan that no
       longer exists -- and also the odder case of a clean exit with no output.

       The plan this attempt was built on is evidently wrong, so drop it rather
       than let the next click walk into the same wall. */
    if (!res.headersSent) {
      plans.delete(planKey(url, selector));
      console.log(`[${platform}] stream attempt failed, retrying via the merge path`);
      return streamMerged(req, res, url, selector, platform, true, opts);
    }

    // Bytes are already out; all that's left is to cut the stream and let the
    // browser surface it. The reason is in the log above.
    res.destroy();
  });
}

/**
 * Download one item out of a post: a photo, or one video from a carousel.
 *
 * The route is unchanged -- `?format=photo&i=N` is what /api/info has always
 * advertised and what the frontend already sends.
 *
 * The index has to mean the same thing here as it did in the /api/info
 * response that produced the link, so this resolves the item list by the
 * *same* precedence: gallery-dl first for an /p/ URL, yt-dlp's entries
 * otherwise. Both calls normally hit the cache /api/info populated seconds
 * ago, so the click costs nothing and cannot see a different list.
 *
 * Then the source decides the route, and the two are not interchangeable:
 *
 *   gallery-dl  ->  proxy the CDN URL. It is the only route that can serve an
 *                   image at all, and its indices count every node in the post.
 *   yt-dlp      ->  `--playlist-items N+1` down the ordinary merge path, whose
 *                   indices count only the video nodes.
 *
 * Crossing them would hand out the wrong item on a mixed carousel.
 */
async function streamItem(req, res, url, index, platform) {
  // Empty for anything that is not instagram.com/p/, which is what keeps
  // reels, TikTok and Facebook off this path entirely.
  const photos = await galleryItems(url).catch(() => []);

  let items = photos;
  let source = "gallery-dl";

  if (!items.length) {
    let info = cachedPlan(url, FORMATS.hd);
    try {
      if (!info) {
        info = await ytdlpJson(url, timeoutFor(platform), FORMATS.hd, extractOpts(platform, true));
        rememberPlan(url, FORMATS.hd, info);
      }
    } catch (err) {
      // Instagram-only for the same reason as /api/info: "No video formats
      // found" means something different on YouTube.
      if (platform === "instagram" && saysNoVideo(err)) {
        console.warn(`[${platform}] no video in ${url} and no images from gallery-dl`);
        return res.status(GALLERYDL_STATUS.available ? 502 : 501).json({
          error: GALLERYDL_STATUS.available
            ? "That post holds no video, and its images could not be read."
            : "That post holds only images, and gallery-dl -- which reads them -- is not installed on this server.",
          code: GALLERYDL_STATUS.available ? "no_items" : "gallerydl_missing",
          detail: err.detail || null
        });
      }
      console.error(`[${platform}] item lookup failed (${err.code || "?"}): ${err.stderr || err.message}`);
      return res.status(502).json(extractionFailure(err, platform));
    }
    items = instagramItems(info);
    source = "yt-dlp";
  }

  if (!items.length) {
    return res.status(502).json({
      error: "That post reported no downloadable items.",
      code: "no_items",
      detail: null
    });
  }
  if (index >= items.length) {
    return res.status(404).json({
      error: `Item index ${index} out of range; that post has ${items.length}.`,
      code: "bad_photo_index",
      detail: null
    });
  }

  /* Named after the post's shortcode: a carousel entry's own title is usually
     the caption, repeated identically for every item, which would have a
     visitor saving five files with the same name. */
  const shortcode = (url.match(/\/(?:p|reel|reels|tv)\/([\w-]+)/) || [])[1] || platform;
  const name = items.length > 1 ? `${shortcode}-${index + 1}` : shortcode;
  res.locals.title = name;

  const item = items[index];
  console.log(`[${platform}] item ${index} of ${items.length} (${item.type}) via ${source}`);

  if (source === "yt-dlp") {
    return streamMerged(req, res, url, null, platform, true, { playlistItem: index + 1 });
  }
  return streamProxied(req, res, item, name, platform);
}

/**
 * Proxy one media file straight from Instagram's CDN.
 *
 * Proxied rather than redirected for the same reason the video route is: only
 * we can set Content-Disposition, so a 302 would open the photo in a tab
 * instead of saving it -- which is the whole point on a phone.
 *
 * Nothing is transcoded. For a photo there is nothing to do, and for a video
 * this is Instagram's own file: a single muxed MP4 with its audio track
 * already in it, which is exactly what should be handed over. Remuxing it
 * would cost a round-trip through ffmpeg to produce the same thing.
 */
async function streamProxied(req, res, item, name, platform) {
  const target = item.url;

  // galleryItems() already filtered, but re-check at the line that actually
  // performs the fetch -- that is the one that matters.
  if (!isAllowedMedia(target)) {
    console.error(`[${platform}] refusing to fetch media from an unexpected host`);
    return res.status(502).json({ error: "Unexpected media host.", code: "blocked_media_host", detail: null });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  res.on("close", () => ctrl.abort()); // visitor cancelled -> drop the upstream fetch

  const host = (() => { try { return new URL(target).host; } catch { return "the CDN"; } })();

  let upstream;
  try {
    upstream = await fetch(target, { signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    console.error(`[${platform}] media fetch failed from ${host}: ${e.message}`);
    if (!res.headersSent) {
      res.status(502).json({
        error: `Could not reach ${host}: ${e.name === "AbortError" ? "timed out after 30s" : e.message}`,
        code: e.name === "AbortError" ? "timeout" : "network",
        detail: null
      });
    }
    return;
  }
  // Headers are in. From here the stream is the client's to cancel, so the
  // timeout has done its job -- leaving it armed would kill a slow download.
  clearTimeout(timer);

  if (!upstream.ok || !upstream.body) {
    console.error(`[${platform}] CDN ${host} returned HTTP ${upstream.status} for a ${item.type} item`);
    return res.status(502).json({
      error: `${host} returned HTTP ${upstream.status} ${upstream.statusText || ""}`.trim() +
        (upstream.status === 403
          ? " -- signed CDN URLs expire, so re-running /api/info usually fixes this"
          : ""),
      code: `http_${upstream.status}`,
      detail: null
    });
  }

  /* A carousel item is not necessarily a photo. This route proxies the Nth
     media item whatever it is, so the extension follows the CDN's content-type
     rather than assuming an image -- naming an mp4 ".jpg" produces a file the
     visitor's device refuses to open, for no reason they can see. */
  const type = upstream.headers.get("content-type") || (item.type === "video" ? "video/mp4" : "image/jpeg");
  const ext =
    type.includes("mp4") ? "mp4" :
    type.includes("quicktime") ? "mov" :
    type.includes("webm") ? "webm" :
    type.startsWith("video/") ? "mp4" :
    type.includes("png") ? "png" :
    type.includes("webp") ? "webp" :
    type.includes("gif") ? "gif" : "jpg";

  const filename = safeFilename(name, ext);
  const len = upstream.headers.get("content-length");
  console.log(`[${platform}] proxying ${item.type} as ${type}${len ? ` (${len} bytes)` : ""}`);

  res.setHeader("Content-Type", type);
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
    return res.status(400).json({ error: "Unsupported link.", code: "unsupported_link", detail: null });
  }

  /* One carousel item per request (?i=N) rather than a zip -- zipping would
     mean buffering the whole post to build the archive, and the streaming rule
     below exists precisely to avoid holding media in a 512MB box's memory.

     The name "photo" is what the frontend sends and what every /api/info
     response has advertised, and it now means what it says again: for an
     instagram.com/p/ post this really can be an image. It also still serves
     the video items in a carousel, so the name is narrower than the route. */
  if (format === "photo") {
    const i = Number.parseInt(req.query.i ?? "0", 10);
    if (!Number.isInteger(i) || i < 0) {
      return res.status(400).json({ error: "Bad photo index.", code: "bad_photo_index", detail: null });
    }
    return streamItem(req, res, url, i, platform);
  }

  if (!FORMATS[format]) {
    return res.status(400).json({ error: `Unknown format "${format}". Use hd, sd, mp3 or photo.`, code: "bad_format", detail: null });
  }

  /* One extraction, and usually zero: /api/info ran this exact query moments
     ago and left the answer in the cache, so the click that lands here
     normally pays nothing for it. A miss costs what every download used to. */
  const selector = FORMATS[format];
  let info = cachedPlan(url, selector);
  if (!info) {
    try {
      info = await ytdlpJson(url, timeoutFor(platform), selector, extractOpts(platform));
      rememberPlan(url, selector, info);
    } catch (err) {
      /* An image post asked for as a video. It reaches here through a stale
         link or a direct call rather than the UI -- the result panel hides the
         HD button for a photo post -- but running the merge path anyway means
         yt-dlp is spawned a second time only to fail with the same "no video
         formats" it just gave, and the visitor gets a 502 for a post whose
         images are sitting right there.

         So route it the way the post itself is shaped: hand off to the item
         route, which asks gallery-dl. Index 0, because a bare ?format=hd names
         no item and the first is the one the post leads with. */
      if (platform === "instagram" && IG_PHOTO_POST_RE.test(String(url)) && saysNoVideo(err)) {
        console.log(
          `[${platform}] ${format} requested for a post with no video (${err.code || "no_video"}); ` +
          "routing to the item path for gallery-dl"
        );
        return streamItem(req, res, url, 0, platform);
      }
      // Otherwise non-fatal: a generic filename and the safe route beat
      // failing outright, and the merge path can still satisfy plenty.
    }
  }

  const title = info?.title || "video";
  res.locals.title = title;

  if (format !== "mp3") {
    const plan = downloadPlan(info);

    /* Merge only when there is something to merge.

       Three conditions have to hold to take the fast path, and each one is a
       promise this site makes:
         - one stream, not two   -> nothing for ffmpeg to mux
         - already .mp4          -> nothing to remux, so the extension is honest
         - a real video track    -> not audio being passed off as video

       Anything else -- including "the plan is unknown because the extraction
       failed" -- falls through to the merge route, which stages to disk and
       can guarantee all three. That is the old behaviour, so a miss here is
       slower, never wrong. */
    const canStream =
      plan &&
      !plan.needsMerge &&
      plan.ext === "mp4" &&
      plan.vcodec && plan.vcodec !== "none";

    /* Whether a session is going out with this request, on the same line as
       the routing decision. "Is yt-dlp actually loading the cookies file" is
       the question that gets asked when a platform starts refusing, and this
       answers it per download rather than only at boot. */
    const domain = PLATFORMS[platform].hosts[0];
    const cookieNote = COOKIE_FILE
      ? `cookies=${cookiesForDomain(domain)} ${domain}`
      : "cookies=none";

    /* If the metadata came back only because a fallback player client was
       used, the download has to be made as that same client -- the formats in
       the plan are its formats. Carried on the dump so it survives the plan
       cache; null for every ordinary extraction, which is all of them until
       YouTube refuses a session. */
    const dlOpts = info?.__playerClient ? { playerClient: info.__playerClient } : {};
    const clientNote = dlOpts.playerClient ? `, client=${dlOpts.playerClient}` : "";

    if (canStream) {
      console.log(
        `[${platform}] streaming ${plan.formatId} (${plan.vcodec}) — no merge needed, ${cookieNote}${clientNote}`
      );
      return streamProgressive(req, res, url, plan, title, platform, selector, dlOpts);
    }

    console.log(
      `[${platform}] merging ${plan ? plan.formatId : "?"} — ` +
      (plan ? `${plan.needsMerge ? "two streams" : `ext=${plan.ext}`}` : "no plan") +
      `, ${cookieNote}${clientNote}`
    );
    return streamMerged(req, res, url, selector, platform, true, dlOpts);
  }

  const filename = safeFilename(title, "mp3");

  res.setHeader("Content-Type", "audio/mpeg");
  // filename* (RFC 5987) carries the UTF-8 title; plain filename is the fallback.
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename.replace(/[^\x20-\x7E]/g, "_")}"; ` +
    `filename*=UTF-8''${encodeURIComponent(filename)}`
  );

  /* The audio of a login-walled video is just as login-walled as the video, so
     this needs the session too -- an MP3 of a post the visitor could only reach
     signed in fails the same way the MP4 would without it. */
  const jar = cookieSession(platform);

  const dl = spawnYtdlp([
    "-f", FORMATS.mp3,
    "--no-playlist",
    "--socket-timeout", socketTimeoutFor(platform),
    // Same client the metadata was read as, when a fallback was needed. No
    // retry loop here: this path commits its headers before the first byte, so
    // there is nothing to recover to -- the extraction above is where a
    // refusal gets caught, and this just follows its choice.
    ...(info?.__playerClient ? playerClientArgs(info.__playerClient) : []),
    ...jar.args,
    "-o", "-",           // stream to stdout
    url
  ], `${platform}:mp3`);

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

  const cleanup = () => {
    jar.done();
    children.forEach((c) => { if (!c.killed) c.kill("SIGKILL"); });
  };

  // If the visitor cancels or navigates away, don't leave yt-dlp running.
  res.on("close", cleanup);

  dl.on("error", (e) => {
    cleanup();
    if (!res.headersSent) {
      res.status(500).json({
        error: redact(`Could not run yt-dlp (${YTDLP}): ${e.message}`),
        code: "tool_missing",
        detail: null
      });
    }
  });

  dl.on("close", (code) => {
    jar.done();
    if (code !== 0) {
      console.error(`[${platform}] yt-dlp exit ${code} (mp3 path):\n${failed.trim()}`);
      cleanup();
      // Headers are already out the moment bytes flow, so we can only report a
      // clean error if nothing has been sent yet. Otherwise: cut the stream and
      // let the browser surface it as a failed download.
      if (!res.headersSent) res.status(502).json(toolError(failed, "yt-dlp"));
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

app.use((_req, res) => res.status(404).json({ error: "Not found.", code: "not_found", detail: null }));

/* Only listen when run directly. Requiring this file instead hands back the
   pure helpers, which is what lets the Instagram post-shape parsing be tested
   against fixtures -- the one part of that feature testable without a live
   session. `node server.js` is unaffected. */
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Vid VorTex API listening on :${PORT}`);
    console.log(`CORS origins: ${allowed.length ? allowed.join(", ") : "(any)"}`);
    if (SERVE_SITE) console.log(`Site served from ${SITE_DIR} -> http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  instagramItems,
  parseGalleryItems,
  isAllowedMedia,
  saysNoVideo,
  IG_PHOTO_POST_RE,
  classifyPostType,
  itemTypeFrom,
  describePost,
  extractOpts,
  timeoutFor,
  socketTimeoutFor,
  canRetryAsClient,
  playerClientArgs,
  classifyError,
  YT_FALLBACK_CLIENT,
  IG_POST_RE
};
