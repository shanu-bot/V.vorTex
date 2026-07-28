# Vid VorTex API

The resolver behind the Download buttons. The website itself is static and can
live on GitHub Pages; this part cannot, because it has to run `yt-dlp`.

## Why this is needed at all

A browser can't fetch a TikTok/Instagram/Facebook video directly:

- **CORS** — those sites send no `Access-Control-Allow-Origin`, so JavaScript on
  your domain is blocked from reading their pages.
- **Signed URLs** — the real MP4 is behind a tokenized, expiring link that you
  can't derive from the page URL.

So a server resolves the link, then streams the file back with a
`Content-Disposition` header. That header is also what makes phones *save* the
file instead of opening it in a player.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /api/health` | Liveness check. Returns `{"ok":true}`. |
| `GET /api/info?url=<link>` | Metadata: title, duration, quality, size, thumbnail. |
| `GET /api/download?url=<link>&format=hd\|sd\|mp3` | The file, streamed. |

## Run it locally

Needs [Docker](https://www.docker.com/products/docker-desktop/).

```bash
cd server
docker build -t video-hub-api .
docker run --rm -p 8080:8080 video-hub-api
```

Check it:

```bash
curl "http://localhost:8080/api/health"
curl "http://localhost:8080/api/info?url=https://www.tiktok.com/@user/video/123"
```

Then set this in `script.js` and open `index.html`:

```js
const API_BASE = "http://localhost:8080";
```

### Without Docker

You need Node 18+, Python 3, `ffmpeg`, and `yt-dlp` on your PATH:

```bash
pip install yt-dlp
cd server && npm install && npm start
```

## Deploy free (Render)

The repo root has a `render.yaml`, so the least error-prone route is **New** →
**Blueprint** → pick the repo. That configures runtime, root directory and
health check from the file instead of you filling in the form.

To do it by hand:

1. Push this repo to GitHub.
2. On [render.com](https://render.com) → **New** → **Web Service** → pick the repo.
3. Set **Root Directory** to `server` and **Runtime** to **Docker**. Render reads
   the `Dockerfile` and ignores the rest.
4. Instance type: **Free**.
5. Add an environment variable:

   | Key | Value |
   |---|---|
   | `ALLOWED_ORIGINS` | `https://<your-username>.github.io` |

6. Deploy, then copy the URL Render gives you (e.g.
   `https://video-hub-api.onrender.com`) into `API_BASE` in `script.js`.

Railway and Fly.io work the same way — both detect the `Dockerfile`.

### If the runtime isn't Docker

Every download fails with **"yt-dlp is not installed on the server"** while
`/api/health` stays green. That is `spawn()` returning ENOENT: the service is on
Render's *native* Node runtime, which is a plain Ubuntu image with node on it —
no yt-dlp, no ffmpeg, and no root to `apt-get` them with. A service created
through the dashboard form defaults to it, and **Render cannot change a
service's runtime after it exists.**

You don't have to rebuild the service. `npm install` runs
`scripts/install-tools.js`, which fetches static yt-dlp and ffmpeg builds into
`server/bin/` and which `server.js` looks for before falling back to PATH — so
the default build command already fixes it on the next deploy. Just make sure
**Root Directory** is `server`, or npm never sees this `package.json`.

It costs ~40 s and ~190 MB of slug on each build. Recreating the service as a
Blueprint gets you the Docker image instead, where the layer is cached and the
script no-ops. Worth doing when convenient, but not urgent.

> **Free tier sleeps.** Render idles the service after ~15 minutes of no
> traffic, and the next request takes ~50s to wake it. The frontend already
> handles this: it shows *"Can't reach the server. It may be waking up"* rather
> than hanging. It's not a bug, it's the free plan.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Your host usually sets this. Don't hardcode it. |
| `ALLOWED_ORIGINS` | *(any)* | Comma-separated. **Set this in production** or anyone can point their site at your server and burn your bandwidth. |
| `YTDLP_PATH` | `server/bin/yt-dlp`, else PATH | Only needed if it's somewhere else. |
| `FFMPEG_PATH` | `server/bin/ffmpeg`, else PATH | Required, not optional — every video download merges a separate video and audio stream into the MP4, and `mp3` transcodes with it. Passed to yt-dlp as `--ffmpeg-location` whenever it resolves to a path. |
| `SKIP_TOOL_INSTALL` | *(unset)* | Set to skip the `postinstall` binary fetch entirely — for when you install yt-dlp and ffmpeg yourself. It already no-ops off Linux and whenever both are on PATH (which is what happens in the Docker build). |
| `COOKIES_FILE` | *(see below)* | Path to a Netscape `cookies.txt`. Overrides the search order. |
| `COOKIE_DOMAINS` | *(unset)* | Comma-separated extra domains allowed into the jar, on top of the four platforms. |
| `YTDLP_COOKIES` / `IG_COOKIES` | *(unset)* | The jar pasted into an env var instead of a file. Still works, merged in after the file, escaped `\n` accepted — but a full jar is far past what an env var should hold. Prefer the file. |

### Cookies, and why downloads fail without them

Every platform here treats a datacenter IP as an automation signal. From a
laptop these links resolve anonymously; from Render they get a bot check
instead. YouTube's is the one you'll hit first — *"Sign in to confirm you're
not a bot"* — which the API reports as **"That video is private or needs a
login."** on a video that is plainly public. A logged-in session is what gets
past it.

**The jar is read from a file**, first match wins:

1. `$COOKIES_FILE`
2. `/etc/secrets/cookies.txt` — where Render mounts a Secret File
3. `server/cookies.txt` — local development

### "No supported JavaScript runtime could be found"

YouTube hands out a JS challenge that yt-dlp has to execute. Without a runtime
it can't, and what you see is that message followed by a bot check — which
reads like a cookie problem and isn't one.

The catch is that yt-dlp *supports* Node but does not *enable* it. `--js-runtimes`
lists deno, node, quickjs and bun, and **only deno is enabled by default**, so a
box with Node and no Deno reports `node (unavailable)` — meaning "not enabled",
not "not found". Render's Node runtime is exactly that box.

The server now passes `--js-runtimes node:<process.execPath>` on every yt-dlp
invocation. The path comes from `process.execPath` rather than `PATH` because
this server *is* a Node process, so that binary certainly exists and certainly
works — in the container and on the native runtime alike. Node is **added**, not
swapped in: Deno still outranks it where present.

Verified at boot without touching the network. `yt-dlp --verbose` with no URL
prints its banner and exits with a usage error, and the banner carries the line
that settles it:

```
[debug] JS runtimes: deno-2.9.2, node-24.18.0
[debug] JS runtimes: none
```

Running that probe with the flags the server intends to use reports exactly what
yt-dlp will have at download time. The result is logged and exposed on
`/api/health` as `jsRuntime`:

```json
"jsRuntime": { "requested": "node:/usr/local/bin/node", "available": "node-20.11.1", "enabled": true }
```

`available: "none"` is the failure case and is logged as an error. `YTDLP_JS_RUNTIME=off`
disables the flag; any other value is passed through verbatim (e.g. `deno`).

#### Verifying the jar is actually being read

`GET /api/health` reports it, so you don't have to trigger a download and read
the logs:

```json
{ "ok": true,
  "cookies": {
    "loaded": true,
    "source": "/etc/secrets/cookies.txt",
    "entries": 42,
    "droppedForOtherSites": 310,
    "perPlatform": { "youtube.com": 12, "tiktok.com": 0, "instagram.com": 0, "facebook.com": 0 },
    "pathsChecked": [{ "path": "/etc/secrets/cookies.txt", "exists": true, "readable": true, "size": 91204, "error": null }],
    "secretsDir": ["cookies.txt"] } }
```

Counts and paths only — never a cookie name or value. `pathsChecked` is
deliberately **not** redacted, unlike paths in tool errors: the whole question
is whether `/etc/secrets/cookies.txt` is the file being read, and `…/cookies.txt`
doesn't answer it.

The same is printed at boot, and every download logs `cookies=N youtube.com`
next to its routing decision, so you can confirm a session went out with that
specific request.

`perPlatform` is the number that usually matters. A jar can load fine and still
contain nothing for the platform you're downloading from — a browser export
taken from a Google account page has plenty of `.google.com` cookies and no
`.youtube.com` ones, and yt-dlp will then behave exactly as if no jar were
passed at all.

#### When YouTube still says "Sign in to confirm you're not a bot"

That message looks identical for five different causes, so the error now says
which one it is:

| Response says | Cause | Fix |
|---|---|---|
| `no cookie jar loaded. Checked: /etc/secrets/cookies.txt (missing); …` | No file at any candidate path | Add the Secret File |
| `… (exists, UNREADABLE)` | Mounted but permissions deny it | Re-create the Secret File |
| `cookie file was read but held no entries for this platform` | Wrong export — all cookies are for other sites | Export while on youtube.com |
| `cookie jar loaded from … but it has no youtube.com entries` | Same, but other supported platforms are present | As above |
| `cookie jar loaded from … with N youtube.com entries; the session is likely expired` | Everything wired up, cookies stale | Re-export and replace the Secret File |

Check `secretsDir` in the health output too — it lists what is actually mounted.
A Secret File named `youtube-cookies.txt` shows up there and is picked up
automatically (any filename containing "cookie" in `/etc/secrets` is tried), but
seeing the list makes a naming mismatch obvious.

#### On Render: use a Secret File, not the repo

Dashboard → your service → **Environment** → **Secret Files** → **Add Secret
File**. Filename `cookies.txt`, contents = your exported jar. Render mounts it
read-only at `/etc/secrets/cookies.txt`, which the server already looks for.
Nothing touches git, and the value is editable without a code change.

#### Never commit the file

> A `cookies.txt` is a password that skips 2FA, and **this repo is public**.
> Anyone who reads a committed jar is signed in as you everywhere in it, and
> deleting the file later does not help — git keeps every version. `cookies.txt`
> is in `.gitignore` and `.dockerignore`; leave it there. If one is ever
> committed, treat every account in it as compromised and sign out of all
> sessions before rewriting history.

**Only the four platforms' cookies are loaded.** A browser export is everything
you're logged into — email, bank, source control. On startup the jar is filtered
down to `youtube.com`, `tiktok.com`, `instagram.com`, `facebook.com` and their
CDNs; every other entry is dropped before anything is written, and the count is
logged. Google's own domains are excluded on purpose: yt-dlp needs
`youtube.com` cookies, and `.google.com` holds the master account session.
Even so, export from a **burner account** — requests come from a datacenter IP
and accounts do get banned for it.

**Sessions expire**, typically in weeks and faster for YouTube from cloud IPs.
When downloads start failing with the login message again, re-export and
replace the Secret File. There is no way around this from inside the server.

Cookies are never read from the master jar directly: yt-dlp and gallery-dl both
*rewrite* the file they're handed, so every run gets a disposable copy — which
also means the read-only Render mount is never written to.
| `FFPROBE_PATH` | `server/bin/ffprobe`, else PATH | Used to confirm the finished file actually has a video track. If it can't run, the check is skipped rather than failing the download. |
| `RAW_ERRORS` | *(off)* | Set to `1` to stop redacting filesystem paths and URL query strings out of error responses. The server log is unredacted either way. |
| `YTDLP_JS_RUNTIME` | `node:<process.execPath>` | JS runtime for YouTube's challenge. `off` disables the flag; any other value is passed to `--js-runtimes` verbatim. See below. |
| `YTDLP_VERBOSE` | *(off)* | Set to `1` to add `--verbose` to every yt-dlp run and log a pre-flight block: whether the jar exists, its size, whether `--cookies` was passed, the full command, and the first 15 lines of verbose output. Noisy — for debugging, not production. Never prints cookie contents. |
| `MAX_QUALITY` | *(off)* | Set to `1` to drop the H.264 preference — highest resolution wins, codec be damned. **This is the setting that produces AV1.** Leave it off unless you know every player you care about handles AV1/VP9; see below. |

### "Requested format is not available"

A format id is a fact about one extraction, not a permanent name. YouTube hands
different clients different format sets, and the fast path reuses an id from a
plan that can be five minutes old, so the id can simply be gone by the time the
download runs.

**No format id is ever requested.** The plan decides *whether* a download can
be streamed; choosing the format is left to yt-dlp. Four layers, all measured:

1. The fast path asks for `b[ext=mp4]` — what it actually requires, one
   already-muxed MP4. `b` is single-format by definition; the full selector
   could resolve to a two-stream merge, and piping a merge to stdout produces
   MPEG-TS wearing an `.mp4` name. There is deliberately no `/b` fallback to
   any container: an unexpected `.webm` served as `video/mp4` would be a lie.
2. If that fails **and nothing has been written**, the request goes to the
   merge path with the full selector, which can merge and remux. The stale
   plan is dropped from the cache on the way.
3. If the merge path's own selector cannot be satisfied, it retries **without
   `-f` at all** and lets yt-dlp choose. yt-dlp's default is `bv*+ba/b`, so it
   resolves whenever the video has any format, and `-S vcodec:h264` still
   applies so H.264 is still preferred. There is no third attempt: if the
   default cannot be satisfied, the video genuinely has nothing to download.
4. Every video selector ends in `/bv*`, so a video with no audio track at all
   comes down silent rather than failing. `bv*` is video-bearing, so this
   cannot bring back the audio-only bug.

The metadata call needed the same treatment, and this was the second source of
the error. Passing `-f` to `-J` is what buys the download plan, but it also
makes the dump fail outright when the selector cannot be satisfied:
`yt-dlp -J -f <bad>` exits 1 with *"Requested format is not available"* where a
bare `-J` on the same video exits 0. A speed-up must never be the reason
something fails, so that call now retries without the selector and simply loses
the plan, falling back to the merge route.

Verified by replacing the `hd` selector with a deliberately impossible one:
both retries fire, and the download still returns 200 with H.264 + AAC.

Layer 2 depends on a detail worth not undoing: the pipe is created with
`{ end: false }`. A plain `pipe()` ends the response the moment yt-dlp's stdout
closes — including when it closes having produced nothing — which commits an
empty `200` before the exit code is known and leaves nothing to recover from.
That was a real bug, found by forcing a bad id with the fallback removed: the
download returned `200` with zero bytes.

The classification for this failure is `format_unavailable`.

### "spawn gallery-dl ENOENT"

The command name is right — `gallery-dl` is the real binary. The problem is
that it genuinely isn't installed.

**It cannot be replaced by yt-dlp.** yt-dlp is video-only; an Instagram image
post makes it exit with *"There is no video in this post"*, which is the string
`NO_VIDEO_RE` matches on to hand over to the photo route. Dropping gallery-dl
means dropping photo and carousel support entirely, not moving it elsewhere.

**It also can't be installed the way yt-dlp and ffmpeg are.** Those publish
static binaries; gallery-dl publishes none — every release from v1.32.3 to
v1.32.8 carries zero assets, and `/releases/download/v1.32.6/gallery-dl.bin` is
a 404. It's a Python package and has to be installed as one.

So `scripts/install-tools.js` now installs it into a venv, mirroring what the
Dockerfile has always done. A venv rather than `pip install --user` because
Debian and Ubuntu mark the system Python externally-managed (PEP 668), which
makes a bare pip refuse to run. `bin/gallery-dl` is symlinked to the venv entry
point — a copy would break, since pip generates a script whose shebang points
back into the venv.

**Failure there is never fatal.** No Python on the host means no gallery-dl,
which means no photo posts — and video downloads on all four platforms are
completely unaffected, so the deploy should not fail over it. The installer
warns and continues.

The server probes gallery-dl once at boot and reports it:

```
[gallery-dl] 1.32.6 at /opt/render/project/src/server/bin/gallery-dl - photo posts supported
[gallery-dl] NOT AVAILABLE (ENOENT for "gallery-dl"). Instagram photo and carousel
             posts will fail with a clear error; video downloads on all platforms
             are unaffected. Fix: redeploy so postinstall installs it, or set GALLERYDL_PATH.
```

`GET /api/health` carries the same under `galleryDl`. When it's missing, photo
requests return `code: "gallerydl_missing"` with a sentence saying so, instead
of spawning a binary already known to be absent and surfacing a raw `ENOENT`.

### Instagram post shape

A `/p/` link can be one photo, one video, or a carousel mixing both, and until
recently this server could only see the first of those properly — yt-dlp with
`--no-playlist` returns one video and says nothing about its siblings, and the
gallery-dl fallback treated every URL it got back as a photo.

For `/p/`, `/reel/`, `/reels/` and `/stories/` URLs, `/api/info` now adds two
keys:

```json
{
  "kind": "carousel",
  "postType": "carousel",
  "itemCount": 3,
  "items": [
    { "index": 0, "type": "photo", "download": "/api/download?url=…&format=photo&i=0", "thumbnail": "https://…/1_n.jpg" },
    { "index": 1, "type": "video", "download": "/api/download?url=…&format=photo&i=1", "thumbnail": "https://…/poster_n.jpg" },
    { "index": 2, "type": "photo", "download": "/api/download?url=…&format=photo&i=2", "thumbnail": "https://…/2_n.webp" }
  ]
}
```

`postType` is `single_photo`, `single_video` or `carousel`.

**Additive.** Every field that existed before still means what it meant, so a
client ignoring these two keys behaves exactly as it did. `kind` only gains a
new value — `carousel` — for the case that was previously *misreported* rather
than reported differently. TikTok, Facebook and YouTube never enter this branch
and their responses are unchanged.

`download` is a path, not an absolute URL: the server sits behind a proxy and
does not reliably know its own public origin, and the client already has that.
It points at the existing item endpoint, so no new download route was added.

Types and thumbnails come from `gallery-dl --dump-json`, whose Instagram
metadata carries `typename`, `video_url`, and `display_url` — the last being the
still frame *even for videos*, which is how a carousel gets a thumbnail for an
item that isn't a photo. If that call fails, `-g` is the fallback and the type
is inferred from the URL; thumbnails are then unavailable for video items.

The two lookups run concurrently, so Instagram doesn't get slower for needing
both. A failed item lookup never fails `/api/info` — it degrades to the
behaviour that existed before.

One related fix: the item download route derived its file extension assuming an
image, so a carousel video would have been saved as `.jpg`. It now follows the
CDN's content-type.

### Errors

Every failure returns the same shape, and the message is the tool's own text
rather than a sentence this server made up:

```json
{
  "error":  "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot. ... [server has no cookie jar loaded — see COOKIES_FILE / Render Secret Files]",
  "code":   "bot_check",
  "detail": "full stderr, including yt-dlp's warnings"
}
```

`code` is there so you can grep logs and so the frontend can branch without
regexing prose: `bot_check`, `rate_limited`, `http_403`, `http_401`,
`login_required`, `cookies`, `unsupported_url`, `geo_blocked`,
`extractor_error`, `unavailable`, `network`, `timeout`, `tool_missing`,
`no_output`, `no_video_stream`, `bad_json`, `unsupported_link`, `bad_format`,
`bad_photo_index`, `blocked_media_host`, `no_temp_space`, `unknown`.

When the failure looks like authentication (`bot_check`, `login_required`,
`http_401/403`, `cookies`) **and no jar is loaded**, the message says so. That
is the one thing the tool cannot tell you, because it doesn't know, and it's
the first thing to check.

yt-dlp warnings are no longer suppressed. *"You have requested merging of
multiple formats but ffmpeg is not installed"* is a warning, not an error —
suppressing it while asking why a download failed is self-defeating. Warnings
go to stderr, which is only read on failure, so nothing else changes.

**Paths and query strings are redacted** from responses. `/etc/secrets/cookies.txt`
tells a stranger both that a session exists and where it lives, and signed CDN
URLs carry credentials in the query string; neither helps you debug, since the
signal is the status code and the sentence. Paths collapse to `…/basename` and
query strings become `?<redacted>`. Set **`RAW_ERRORS=1`** for verbatim output.

The unredacted text is always written to the server log regardless, with the
platform and exit code — so on Render, the log is the full picture and the
response is the safe subset.

### How a download spends its time

Two costs dominate, and neither is bandwidth: a yt-dlp *extraction* is a real
round-trip to the platform (measured 3.4–3.9s against YouTube), and the yt-dlp
binary itself takes ~1.5s to start because the standalone build unpacks on
every run.

The route is built to pay each of those as few times as possible:

- **The extraction is cached** for 5 minutes, keyed by URL + selector. The
  frontend always calls `/api/info` before showing the button, and that call
  now runs with `-f`/`-S` applied, so its dump already contains the exact
  download plan. The click that follows costs no extraction of its own.
- **A single already-muxed stream is piped straight to the browser.** No temp
  file, no ffmpeg, no ffprobe — headers go out first and bytes flow as they
  arrive. This is the normal case for TikTok, Instagram and Facebook, which
  publish one progressive MP4.
- **Merging only happens when there are two streams to merge.** That path
  still stages to disk, because MP4 has to seek back and write its header once
  the length is known and a pipe cannot seek — piping a merge produces MPEG-TS
  wearing an `.mp4` name, which phones refuse to save.

Measured on a 615 KB progressive file, laptop to YouTube:

| | before | after |
|---|---|---|
| download after `/api/info` (the real flow) | 10.0s to first byte | **3.3s** |
| cold download, nothing cached | ~10s | 6.7s |
| total wall clock | 10.0s | 3.8s |

Before, `ttfb` equalled `total` — the browser got nothing until the entire file
had been downloaded and re-read from disk. Now the two diverge, which is the
whole point.

Two further optimisations were measured and **rejected**:

- `--load-info-json` would skip the download run's own extraction, worth ~1.7s
  (2.24s vs 3.9s). It means downloading from signed CDN URLs cached for up to
  five minutes; if they go stale the request fails after headers are already
  out. Not worth it on three platforms that can't be regression-tested here.
- Replacing the standalone yt-dlp binary with a pip install in a venv would cut
  the ~1.5s startup, since the onefile build unpacks itself on every spawn.
  That is a real win and a deployment change, so it is left as a follow-up
  rather than folded into a latency fix.

### If a download plays sound but shows no picture

The file almost certainly *has* a video track — it's just in a codec the player
can't decode. YouTube serves AV1 and VP9 above 1080p, and both are legal inside
an MP4, so the download succeeds and then Windows Media Player, stock Android
players, older Safari and most TVs render audio over a blank frame.

Selection is therefore split in two: **what** to fetch is `bv*+ba/b` (best video
+ best audio, merged; else the best single stream carrying both — no branch can
resolve to audio-only), and **how to rank** candidates is `-S vcodec:h264`.
The sort is a *preference*, not a filter: H.264 wins wherever it exists at any
resolution, and AV1/VP9 remains available when it's all a site has. Because the
codec term is prepended it outranks resolution, which is the trade this site
wants — a 1080p file that plays beats a 4K file that doesn't.

Audio is pinned the same way, for the same reason. `ba[acodec^=mp4a]` comes
before plain `ba`, because the alternative YouTube offers is Opus, and Opus in
an MP4 is the audio mirror of the AV1 problem — picture with no sound on the
same players. It sits in the selector rather than in `-S` because `acodec:aac`
in the sort also ranks the *video* candidate's audio field: measured, it pulled
a 4K source down from 1080p avc1 to 360p itag 18. Measured in the selector
instead, it changed `137+251` (opus) to `137+140` (aac) with identical 1080p
H.264 video.

If you hit this, check `MAX_QUALITY` first. It removes the codec preference,
which is exactly how you get a 4K AV1 file that plays as sound only.

Two notes for anyone tempted to tune the sort:

- **Don't add `acodec:aac`.** It ranks the audio field of the *video* candidate
  too, pushing `bv*` toward low-res muxed streams — measured on a 4K source,
  adding it dropped the pick from 1080p avc1 to 360p itag 18.
- **Don't express codec preference as filtered `-f` alternatives.** That was the
  original bug: only the first link pinned a codec, and the next one was
  `bv*[ext=mp4]+ba[ext=m4a]` — on YouTube, AV1 formats *are* `ext=mp4`.

As a backstop the finished file is probed before it's sent. If it has no video
stream at all the request fails with a clear error instead of streaming audio
under `video/mp4`, because that is the one failure a visitor can't diagnose.

## Maintenance — the part people skip

**The platforms change their pages, and yt-dlp chases them.** When downloads
suddenly start failing across the board, yt-dlp is almost always the cause, and
the fix is to bump the pinned version in the `Dockerfile`:

```dockerfile
ARG YTDLP_VERSION=2026.07.04    # <- raise this, then redeploy
```

Latest tags: <https://github.com/yt-dlp/yt-dlp/releases>

It's pinned rather than tracking `latest` on purpose — otherwise your image
changes silently between deploys and a bad upstream release becomes a mystery
outage you can't correlate to anything you did.

## Security notes

- **SSRF is the real risk here** and `classify()` in `server.js` is the control.
  `url` is user input handed to a tool that will fetch nearly any address, so
  the hostname is matched against an exact-suffix allowlist and only `http(s)`
  is permitted. Without it, someone passes a cloud-metadata or internal address
  and this server fetches it for them. **Don't loosen that function.**
- yt-dlp is spawned with an argument array and no shell, so a URL can never be
  interpreted as a command.
- Rate limited to 20 requests/minute per IP, in memory. That's per-process — if
  you ever run more than one instance, move it to Redis or each instance will
  hand out its own budget.
- The container runs as the non-root `node` user.

## Legal

This fetches content you don't own. Downloading is fine for content that's
yours, that's licensed for it, or that falls under local fair-use/private-copy
rules — and redistributing someone else's video generally isn't. Automated
downloading also breaches the terms of service of all three platforms, and
that's on the operator of the deployment, not the code. If you put this on a
public URL, you're the operator.
