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
const { Readable } = require("stream");
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
   Photo support is optional, and says so.

   gallery-dl handles Instagram photo and carousel posts. yt-dlp cannot: it is
   video-only, and an image post makes it exit with "There is no video in this
   post" -- which is exactly what NO_VIDEO_RE further down is matching on. So
   this is not a tool that can be swapped for the other.

   It is also the only tool here without a static binary to download, so a
   host without Python simply won't have it. Rather than let that surface as
   "spawn gallery-dl ENOENT" on the first photo post, it is probed once at boot
   and reported: video downloads are entirely unaffected, and the failure
   should read as "photos unavailable" rather than as a crash.
   -------------------------------------------------------------------------- */

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
  console.log(`[gallery-dl] ${GALLERYDL_STATUS.version} at ${GALLERYDL_STATUS.path} - photo posts supported`);
} else {
  console.warn(
    `[gallery-dl] NOT AVAILABLE (${GALLERYDL_STATUS.reason} for "${GALLERYDL_STATUS.path}"). ` +
    "Instagram photo and carousel posts will fail with a clear error; " +
    "video downloads on all platforms are unaffected. " +
    "Fix: redeploy so postinstall installs it, or set GALLERYDL_PATH."
  );
}

/** One sentence a visitor and an operator can both act on. */
const NO_GALLERYDL_ERROR = () => ({
  error:
    "Photo posts need gallery-dl, which is not installed on this server " +
    `(${GALLERYDL_STATUS.reason} for "${GALLERYDL_STATUS.path}"). ` +
    "Video downloads are unaffected.",
  code: "gallerydl_missing",
  detail: null
});

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
  console.log("[cookies] ---------------------------------------------");
})();

/* --------------------------------------------------------------------------
   Every run gets its own copy of the jar.

   yt-dlp does not just read the file it's handed -- it writes the whole jar
   back when it finishes, merging in whatever the site set during the fetch. A
   single request against YouTube turns an 89-byte file into a 972-byte one.
   gallery-dl does the same by default.

   Sharing one file across concurrent downloads therefore means two processes
   rewriting it at once, and the loser's write can leave a truncated jar --
   which takes out the configured session until the service restarts. So each
   invocation gets a disposable copy and the master is only ever read.

   Returns spawn args plus the cleanup to run once the process is done.
   -------------------------------------------------------------------------- */

const NO_COOKIES = { args: [], done: () => {} };

function cookieSession() {
  if (!COOKIE_FILE) return NO_COOKIES;

  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-ck-"));
    const copy = path.join(dir, "cookies.txt");
    fs.copyFileSync(COOKIE_FILE, copy);
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

const planKey = (url, selector) => `${selector || ""} ${url}`;

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
function ytdlpJson(url, timeoutMs = 25_000, selector = null) {
  return ytdlpJsonOnce(url, timeoutMs, selector).catch((err) => {
    if (!selector || err.code !== "format_unavailable") throw err;
    console.warn(
      `[ytdlp] selector "${selector}" is not satisfiable for this video; ` +
      "re-reading metadata without it (download will take the merge route)"
    );
    return ytdlpJsonOnce(url, timeoutMs, null);
  });
}

/** One attempt. Buffers stdout; used for metadata only, never for the video. */
function ytdlpJsonOnce(url, timeoutMs = 25_000, selector = null) {
  return new Promise((resolve, reject) => {
    // Metadata is login-walled on exactly the same posts the media is, so this
    // needs the session as much as the download does -- without it /api/info
    // fails first and the download is never even attempted.
    const jar = cookieSession();

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
    const args = ["-J", "--no-playlist", "--socket-timeout", "15"];
    if (selector) {
      args.push("-f", selector);
      if (FORMAT_SORT) args.push("-S", FORMAT_SORT);
    }
    args.push(...jar.args, url);

    // Args as an array + no shell: the URL can never be interpreted as a command.
    const child = spawnYtdlp(args, "metadata");

    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      jar.done();
      reject(Object.assign(new Error(`Timed out after ${timeoutMs}ms reading that link.`), {
        code: "timeout",
        stderr: err,
        detail: redact(err.trim()) || null
      }));
    }, timeoutMs);

    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => {
      clearTimeout(timer);
      jar.done();
      reject(Object.assign(new Error(redact(`Could not run yt-dlp (${YTDLP}): ${e.message}`)), {
        code: "tool_missing",
        stderr: "",
        detail: null
      }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      jar.done();
      if (code !== 0) {
        const info = toolError(err, "yt-dlp");
        const e = new Error(info.error);
        e.code = info.code;
        e.detail = info.detail;
        e.exitCode = code;
        // Keep the raw text too: /api/info reads it to tell "this is a photo
        // post" apart from a genuine failure, and that match needs the
        // original string rather than the redacted one.
        e.stderr = err;
        return reject(e);
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(Object.assign(new Error(`yt-dlp returned unparseable JSON: ${e.message}`), {
          code: "bad_json",
          stderr: err,
          detail: redact(out.slice(0, 500)) || null
        }));
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

/* --------------------------------------------------------------------------
   Instagram post shape

   A /p/ link can be one photo, one video, or a carousel mixing both, and this
   server could only ever see the first of those properly: yt-dlp with
   --no-playlist returns one video and says nothing about its siblings, and the
   gallery-dl fallback treated every URL it got back as a photo.

   `gallery-dl --dump-json` carries the metadata that settles it -- `typename`
   (GraphImage / GraphVideo / GraphSidecar), `video_url` when an item is a
   video, and `display_url`, which is the still frame *even for videos*, so a
   carousel can show a thumbnail for an item that is not a photo.

   `-g` stays as the fallback. It has been in use here for a while, and
   inferring type from the file extension is worse than reading metadata but a
   great deal better than calling everything a photo.
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
 * Parse `gallery-dl --dump-json` into media items.
 *
 * The output is an array of message tuples, and the ones that matter look like
 * [3, "<url>", { ...metadata }]. Anything shaped differently is skipped rather
 * than guessed at, so a change to gallery-dl's other message types cannot turn
 * into a malformed item here.
 *
 * Pure, and exported, because this is the one part of the feature that can be
 * tested without an Instagram session.
 */
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
    if (!Array.isArray(msg) || msg.length < 2) continue;
    const mediaUrl = typeof msg[1] === "string" ? msg[1] : null;
    if (!mediaUrl) continue;

    const meta = msg.length > 2 && msg[2] && typeof msg[2] === "object" ? msg[2] : {};
    const type = itemTypeFrom(mediaUrl, meta);

    /* display_url is the still frame and exists for videos too, which is the
       entire reason for preferring --dump-json. A photo is its own thumbnail. */
    const thumbnail = typeof meta.display_url === "string" ? meta.display_url
      : type === "photo" ? mediaUrl
      : null;

    items.push({ type, url: mediaUrl, thumbnail });
  }
  return items;
}

/** single_photo | single_video | carousel. Null when there is nothing to say. */
function classifyPostType(items) {
  if (!items || !items.length) return null;
  if (items.length > 1) return "carousel";
  return items[0].type === "video" ? "single_video" : "single_photo";
}

/**
 * Media items for a post, richest source first.
 *
 * Never rejects: a post-shape lookup is an enhancement, and failing it must not
 * fail /api/info. Callers get [] and fall back to the behaviour that existed
 * before this could be asked.
 */
async function galleryItems(url, timeoutMs = 25_000) {
  // Don't spawn a binary that was already established to be absent -- that is
  // where the raw ENOENT came from, once per attempt, saying nothing useful.
  if (!GALLERYDL_STATUS.available) return [];

  try {
    const raw = await galleryDump(url, timeoutMs);
    const items = parseGalleryItems(raw).filter((it) => isAllowedMedia(it.url));
    if (items.length) return items;
  } catch (e) {
    console.warn(`[instagram] --dump-json failed (${e.code || e.message}); falling back to -g`);
  }

  try {
    const urls = await galleryUrls(url, timeoutMs);
    return urls.map((u) => ({
      type: itemTypeFrom(u),
      url: u,
      thumbnail: itemTypeFrom(u) === "photo" ? u : null
    }));
  } catch (e) {
    console.warn(`[instagram] item lookup failed entirely (${e.code || e.message})`);
    return [];
  }
}

/**
 * The `postType` / `items` block added to an Instagram /api/info response.
 *
 * Additive on purpose. Every field that existed before still means what it
 * meant, so a client that ignores these two keys behaves exactly as it did;
 * `kind` only gains a new value ("carousel") for the case that was previously
 * misreported rather than reported differently.
 *
 * `download` is a path rather than an absolute URL because the server sits
 * behind a proxy and does not reliably know its own public origin -- the
 * client already has that and prefixes API_BASE. It points at the existing
 * item endpoint, so no new download route was needed.
 *
 * Returns {} when there is nothing to add, which keeps the spread at the call
 * sites harmless for every other platform.
 */
function describePost(items, fallbackUrls, url, platform) {
  if (platform !== "instagram") return {};

  const list = items && items.length
    ? items
    : (fallbackUrls || []).map((u) => ({ type: itemTypeFrom(u), url: u, thumbnail: null }));

  const postType = classifyPostType(list);
  if (!postType) return {};

  const q = encodeURIComponent(url);
  return {
    postType,
    itemCount: list.length,
    items: list.map((it, i) => ({
      index: i,
      type: it.type,
      // The proxied endpoint, not the CDN URL: those are header-locked and
      // expire, which is the reason this server exists at all.
      download: `/api/download?url=${q}&format=photo&i=${i}`,
      thumbnail: it.thumbnail || (it.type === "photo" ? it.url : null)
    }))
  };
}

/** Raw stdout of `gallery-dl --dump-json`. */
function galleryDump(url, timeoutMs = 25_000) {
  return new Promise((resolve, reject) => {
    const jar = cookieSession();
    const args = ["--dump-json", "--quiet", ...jar.args, url];
    const child = spawn(GALLERYDL, args);

    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      jar.done();
      reject(Object.assign(new Error("gallery-dl --dump-json timed out"), { code: "timeout" }));
    }, timeoutMs);

    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => {
      clearTimeout(timer);
      jar.done();
      reject(Object.assign(new Error(e.message), { code: "tool_missing" }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      jar.done();
      if (code !== 0) {
        return reject(Object.assign(new Error(meaningfulLines(err).join(" ") || `exit ${code}`), {
          code: classifyError(err)
        }));
      }
      resolve(out);
    });
  });
}

/**
 * Direct media URLs for a post, in order.
 *
 * Uses `-g` (one URL per line): a line-per-URL contract is hard to misread, and
 * the URL is all the download route needs. galleryItems() prefers --dump-json
 * when it wants types and thumbnails, and falls back to this.
 */
function galleryUrls(url, timeoutMs = 25_000) {
  if (!GALLERYDL_STATUS.available) {
    const e = new Error(NO_GALLERYDL_ERROR().error);
    e.code = "gallerydl_missing";
    e.detail = null;
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    // Same disposable copy the yt-dlp paths get: gallery-dl updates the jar it
    // is handed by default, so pointing it at the master has the same race.
    const jar = cookieSession();

    const args = ["-g", "--quiet", ...jar.args];
    args.push(url); // array + no shell: never interpreted as a command

    const child = spawn(GALLERYDL, args);

    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      jar.done();
      reject(new Error("Timed out reading that post."));
    }, timeoutMs);

    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => {
      clearTimeout(timer);
      jar.done();
      reject(Object.assign(new Error(redact(`Could not run gallery-dl (${GALLERYDL}): ${e.message}`)), {
        code: "tool_missing", detail: null
      }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      jar.done();
      const urls = out.split("\n").map((s) => s.trim()).filter(Boolean);

      if (code !== 0 || !urls.length) {
        console.error(`[gallery-dl] exit ${code}: ${err.trim()}`);
        const info = toolError(err, "gallery-dl");
        return reject(Object.assign(new Error(info.error), {
          code: info.code, detail: info.detail, exitCode: code
        }));
      }

      const safe = urls.filter(isAllowedMedia);
      if (!safe.length) {
        return reject(Object.assign(
          new Error(`gallery-dl returned ${urls.length} URL(s), none on an allowed media host.`),
          { code: "blocked_media_host", detail: redact(urls.slice(0, 3).join("\n")) }
        ));
      }
      resolve(safe);
    });
  });
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
 * Build the error payload for a failed yt-dlp / gallery-dl run.
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
  // Photo/carousel support, separately from video: it has its own binary and
  // its own way of being absent.
  galleryDl: GALLERYDL_STATUS
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

  /* Instagram only, and only for URLs that address a post. The item list is
     what makes a mixed carousel describable at all, and it is asked for
     alongside the yt-dlp extraction rather than after it -- both are network
     round-trips, and running them in sequence would double the wait on the one
     platform that needs both. Nothing else changes shape: TikTok, Facebook and
     YouTube never enter this branch. */
  const wantsItems = platform === "instagram" && IG_POST_RE.test(String(url));

  /* .catch() even though galleryItems() already swallows everything: this
     promise is started before the yt-dlp await and is not awaited on every
     path out of the handler, and an unhandled rejection terminates the process
     on modern Node. A belt on top of the braces costs nothing and the failure
     mode it prevents is the whole server going down. */
  const itemsPromise = wantsItems
    ? galleryItems(url).catch(() => [])
    : Promise.resolve([]);

  try {
    let info;
    try {
      /* Extract against the default download selector, not bare. The response
         is identical either way, but the dump then also carries the plan the
         download route needs -- so the click that follows this call costs no
         extraction at all. */
      info = await ytdlpJson(url, 25_000, FORMATS.hd);
      rememberPlan(url, FORMATS.hd, info);
    } catch (err) {
      // yt-dlp parsed the post and found only images. That isn't a failure --
      // it's the one case where the photo route can take over. Any other error
      // is a real error and still propagates.
      if (!NO_VIDEO_RE.test(err.stderr || "")) throw err;

      const items = wantsItems ? await itemsPromise : [];
      const photos = items.length
        ? items.map((it) => it.url)
        : await galleryUrls(url);

      const shape = describePost(items, photos, url, platform);
      return res.json({
        kind: "photo",
        platform,
        platformName: PLATFORMS[platform].name,
        title: photos.length > 1 ? `${PLATFORMS[platform].name} photo carousel` : `${PLATFORMS[platform].name} photo`,
        count: photos.length,
        quality: photos.length > 1 ? `${photos.length} photos` : "Original",
        size: null,      // the CDN reports it per-image; not worth 10 HEAD requests
        duration: null,
        thumbnail: photos[0],
        ...shape
      });
    }

    // Prefer a real reported size; fall back to yt-dlp's estimate.
    const size = info.filesize || info.filesize_approx ||
      (info.formats || []).map((f) => f.filesize || f.filesize_approx || 0).sort((a, b) => b - a)[0];

    const height = info.height ||
      Math.max(0, ...(info.formats || []).map((f) => f.height || 0));

    /* A video post can still be a carousel that happens to lead with a video --
       yt-dlp reports only the one it picked, so the item list is what reveals
       the rest. Awaited here rather than earlier so a slow or failing lookup
       cannot hold up a plain video response. */
    const items = wantsItems ? await itemsPromise : [];
    const shape = describePost(items, items.map((it) => it.url), url, platform);

    res.json({
      kind: shape.postType === "carousel" ? "carousel" : "video",
      platform,
      platformName: PLATFORMS[platform].name,
      title: info.title || info.description?.slice(0, 90) || "Untitled video",
      uploader: info.uploader || info.channel || null,
      duration: humanTime(info.duration),
      quality: height ? `${height}p${height >= 720 ? " • HD" : ""}` : "Best available",
      size: humanSize(size),
      thumbnail: info.thumbnail || null,
      ...shape
    });
  } catch (err) {
    console.error(`[${platform}] /api/info failed (${err.code || "?"}): ${err.stderr || err.message}`);
    res.status(502).json({
      error: err.message,
      code: err.code || "unknown",
      detail: err.detail || null
    });
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
async function streamMerged(req, res, url, format, platform, allowRetry = true) {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vh-mux-"));
  } catch {
    return res.status(500).json({ error: "Server has no writable temp space.", code: "no_temp_space", detail: null });
  }

  /* The jar gets its own directory, deliberately not this one: the merged file
     is found by reading `dir` back and taking what's there, so anything else
     dropped alongside it could be streamed to the visitor as their video. */
  const jar = cookieSession();

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
    "--no-playlist",
    "--no-part",
    "--socket-timeout", "15"
  );
  // Codec preference, applied to every branch of the selector at once. See the
  // format-selection note above for why this is a sort and not a filter.
  if (FORMAT_SORT) args.push("-S", FORMAT_SORT);
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
      if (allowRetry && format && classifyError(err) === "format_unavailable" && !res.headersSent) {
        console.warn(
          `[${platform}] selector "${format}" not satisfiable; retrying with yt-dlp's own choice`
        );
        return streamMerged(req, res, url, null, platform, false);
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
function streamProgressive(req, res, url, plan, title, platform, selector) {
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

  const jar = cookieSession();

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
    "--socket-timeout", "15"
  ];
  if (FORMAT_SORT) args.push("-S", FORMAT_SORT);
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
      return streamMerged(req, res, url, selector, platform);
    }

    // Bytes are already out; all that's left is to cut the stream and let the
    // browser surface it. The reason is in the log above.
    res.destroy();
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
    return res.status(502).json({
      error: err.message,
      code: err.code || "unknown",
      detail: err.detail || null
    });
  }

  if (index >= photos.length) {
    return res.status(404).json({
      error: `Photo index ${index} out of range; that post has ${photos.length}.`,
      code: "bad_photo_index",
      detail: null
    });
  }

  const target = photos[index];
  // galleryUrls() already filtered, but re-check at the line that actually
  // performs the fetch -- that's the one that matters.
  if (!isAllowedMedia(target)) {
    return res.status(502).json({ error: "Unexpected media host.", code: "blocked_media_host", detail: null });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  res.on("close", () => ctrl.abort()); // visitor cancelled -> drop the upstream fetch

  let upstream;
  try {
    upstream = await fetch(target, { signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    const host = (() => { try { return new URL(target).host; } catch { return "the CDN"; } })();
    console.error(`[${platform}] photo fetch failed from ${host}: ${e.message}`);
    if (!res.headersSent) {
      res.status(502).json({
        error: `Could not reach ${host}: ${e.name === "AbortError" ? "timed out after 25s" : e.message}`,
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
    const host = (() => { try { return new URL(target).host; } catch { return "the CDN"; } })();
    console.error(`[${platform}] photo CDN ${host} returned HTTP ${upstream.status}`);
    return res.status(502).json({
      error: `${host} returned HTTP ${upstream.status} ${upstream.statusText || ""}`.trim(),
      code: `http_${upstream.status}`,
      detail: null
    });
  }

  /* A carousel item is not necessarily a photo. This route proxies the Nth
     media item whatever it is, so the extension follows the CDN's content-type
     rather than assuming an image -- naming an mp4 ".jpg" produces a file the
     visitor's device refuses to open, for no reason they can see. */
  const type = upstream.headers.get("content-type") || "image/jpeg";
  const ext =
    type.includes("mp4") ? "mp4" :
    type.includes("quicktime") ? "mov" :
    type.includes("webm") ? "webm" :
    type.startsWith("video/") ? "mp4" :
    type.includes("png") ? "png" :
    type.includes("webp") ? "webp" :
    type.includes("gif") ? "gif" : "jpg";

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
    return res.status(400).json({ error: "Unsupported link.", code: "unsupported_link", detail: null });
  }

  /* Photos never touch yt-dlp: it can't see them. One image per request
     (?i=N) rather than a zip -- zipping would mean buffering a whole carousel
     to build the archive, and the streaming rule below exists precisely to
     avoid holding media in a 512MB box's memory. */
  if (format === "photo") {
    const i = Number.parseInt(req.query.i ?? "0", 10);
    if (!Number.isInteger(i) || i < 0) {
      return res.status(400).json({ error: "Bad photo index.", code: "bad_photo_index", detail: null });
    }
    return streamPhoto(req, res, url, i, platform);
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
      info = await ytdlpJson(url, 20_000, selector);
      rememberPlan(url, selector, info);
    } catch {
      // Non-fatal: a generic filename and the safe route beat failing outright.
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

    if (canStream) {
      console.log(`[${platform}] streaming ${plan.formatId} (${plan.vcodec}) — no merge needed, ${cookieNote}`);
      return streamProgressive(req, res, url, plan, title, platform, selector);
    }

    console.log(
      `[${platform}] merging ${plan ? plan.formatId : "?"} — ` +
      (plan ? `${plan.needsMerge ? "two streams" : `ext=${plan.ext}`}` : "no plan") +
      `, ${cookieNote}`
    );
    return streamMerged(req, res, url, selector, platform);
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
  const jar = cookieSession();

  const dl = spawnYtdlp([
    "-f", FORMATS.mp3,
    "--no-playlist",
    "--socket-timeout", "15",
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
  parseGalleryItems,
  classifyPostType,
  itemTypeFrom,
  describePost,
  IG_POST_RE
};
