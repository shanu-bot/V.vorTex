#!/usr/bin/env node
/* ==========================================================================
   install-tools.js — fetch yt-dlp and ffmpeg at install time

   Why this exists: the Dockerfile installs both with apt and curl, and when
   the API runs as a container that is the whole story. But Render's *native*
   Node runtime is a plain Ubuntu image with node on it -- no yt-dlp, no
   ffmpeg, and no root, so there is no apt-get to reach for. A service created
   through Render's dashboard form gets that runtime, and a runtime cannot be
   changed after the service exists. The symptom is the API coming up healthy
   and then every download failing with "yt-dlp is not installed on the
   server", because spawn() gets ENOENT.

   So: this hangs off npm's `postinstall`, which means Render's default build
   command (`npm install`) triggers it with nothing to configure. The binaries
   land in server/bin/ and server.js looks there before falling back to PATH.

   It deliberately does nothing in the container. yt-dlp and ffmpeg are already
   installed by the time `npm ci` runs there, this script sees them on PATH and
   exits -- so the image doesn't pay for a 40MB download it doesn't need.

   Both binaries are static builds: yt-dlp_linux is a self-contained PyInstaller
   bundle that does not need Python on the box, and the ffmpeg tarball is a
   fully static amd64/arm64 build. Neither needs a package manager.
   ========================================================================== */

"use strict";

const { spawnSync } = require("child_process");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BIN_DIR = path.join(__dirname, "..", "bin");

/* Pinned for the same reason the Dockerfile pins it: "latest" means the build
   silently changes between deploys, so a broken release becomes a mystery
   outage. Bump deliberately when a platform breaks. */
const YTDLP_VERSION = "2026.07.04";

const log = (msg) => console.log(`[install-tools] ${msg}`);

/* --------------------------------------------------------------------------
   Should this run at all?
   -------------------------------------------------------------------------- */

/** True if a command exists and answers --version. */
function onPath(cmd) {
  try {
    const r = spawnSync(cmd, ["--version"], { stdio: "ignore", timeout: 20_000 });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

const ARCH = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;

/** Reasons to do nothing at all. Returns a string to log, or null to proceed. */
function skipReason() {
  // Escape hatch for anyone who installs these themselves.
  if (process.env.SKIP_TOOL_INSTALL) return "SKIP_TOOL_INSTALL set";

  /* Only Linux gets binaries. A developer running `npm install` on Windows or
     a Mac would otherwise eat a 40MB download for tools this script can't even
     pick the right build of -- and they almost certainly have both already. */
  if (process.platform !== "linux") {
    return `platform is ${process.platform}, not linux (install yt-dlp and ffmpeg yourself for local dev)`;
  }
  if (!ARCH) return `unsupported arch ${process.arch} — set YTDLP_PATH and FFMPEG_PATH by hand`;

  return null;
}

/* --------------------------------------------------------------------------
   Download helpers
   -------------------------------------------------------------------------- */

/**
 * GET to a file, following redirects. GitHub release URLs always redirect to
 * objects.githubusercontent.com, so following them isn't optional.
 */
function download(url, dest, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error("too many redirects"));

    https.get(url, { headers: { "User-Agent": "vid-vortex-installer" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain, or the socket stays open
        return resolve(download(new URL(res.headers.location, url).href, dest, hops + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    }).on("error", reject);
  });
}

/** Run a command, throwing with its stderr if it fails. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${cmd} exited ${r.status}: ${(r.stderr || "").trim().split("\n").slice(-3).join(" | ")}`);
  }
  return r.stdout;
}

/* --------------------------------------------------------------------------
   yt-dlp
   -------------------------------------------------------------------------- */

async function installYtdlp() {
  const target = path.join(BIN_DIR, "yt-dlp");

  if (fs.existsSync(target)) {
    log("yt-dlp already in bin/ — skipping.");
    return;
  }
  if (onPath("yt-dlp")) {
    log("yt-dlp already on PATH (container build?) — skipping.");
    return;
  }

  // yt-dlp_linux is the self-contained build; the plain `yt-dlp` asset is a
  // zipapp that needs a system Python, which this runtime may not have.
  const asset = ARCH === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
  const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${asset}`;

  log(`downloading ${asset} ${YTDLP_VERSION}...`);
  await download(url, target);
  fs.chmodSync(target, 0o755);

  const version = run(target, ["--version"]).trim();
  log(`yt-dlp ${version} installed to bin/`);
}

/* --------------------------------------------------------------------------
   ffmpeg

   Not optional any more: every video download merges a separate video and
   audio stream into the MP4, so no ffmpeg means no downloads at all.
   -------------------------------------------------------------------------- */

async function installFfmpeg() {
  const target = path.join(BIN_DIR, "ffmpeg");

  if (fs.existsSync(target)) {
    log("ffmpeg already in bin/ — skipping.");
    return;
  }
  if (onPath("ffmpeg")) {
    log("ffmpeg already on PATH (container build?) — skipping.");
    return;
  }

  const build = ARCH === "arm64" ? "arm64" : "amd64";
  const url = `https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${build}-static.tar.xz`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ffmpeg-"));
  const archive = path.join(tmp, "ffmpeg.tar.xz");

  try {
    log(`downloading static ffmpeg (${build}, ~40MB)...`);
    await download(url, archive);

    // The tarball wraps everything in a versioned directory (ffmpeg-N-static/),
    // so strip it and pull out only the two binaries -- the rest is manpages
    // and licence text.
    //
    // --wildcards is GNU tar's, and GNU tar is what Ubuntu-based hosts ship, but
    // it's rejected outright by bsdtar and busybox tar. Both of those glob
    // extraction patterns by default, so dropping the flag is the right retry
    // rather than a lesser one.
    log("extracting...");
    const patterns = ["-xJf", archive, "-C", tmp, "--strip-components=1"];
    try {
      run("tar", [...patterns, "--wildcards", "*/ffmpeg", "*/ffprobe"]);
    } catch {
      run("tar", [...patterns, "*/ffmpeg", "*/ffprobe"]);
    }

    // ffprobe too: yt-dlp uses it to inspect streams before a merge. It works
    // without one, but it warns and takes a slower path to the same answer.
    for (const name of ["ffmpeg", "ffprobe"]) {
      const src = path.join(tmp, name);
      if (!fs.existsSync(src)) throw new Error(`${name} missing from archive`);
      fs.copyFileSync(src, path.join(BIN_DIR, name));
      fs.chmodSync(path.join(BIN_DIR, name), 0o755);
    }

    const banner = run(target, ["-version"]).split("\n")[0].trim();
    log(`${banner} installed to bin/`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/* --------------------------------------------------------------------------
   Go
   -------------------------------------------------------------------------- */

async function main() {
  const skip = skipReason();
  if (skip) return log(`${skip} — skipping.`);

  fs.mkdirSync(BIN_DIR, { recursive: true });
  await installYtdlp();
  await installFfmpeg();
  log("done.");
}

// Exported so the download and extract paths can be exercised from a test
// harness on a machine that isn't the Linux host they're written for.
module.exports = { download, installYtdlp, installFfmpeg, skipReason, BIN_DIR, YTDLP_VERSION };

if (require.main === module) {
  main().catch((err) => {
    // Fail the build rather than deploy a server that can't download anything.
    // A broken deploy is loud; a live service that 500s on every request is not.
    console.error(`[install-tools] FAILED: ${err.message}`);
    process.exit(1);
  });
}
