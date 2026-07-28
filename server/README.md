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
| `YTDLP_COOKIES` | *(unset)* | A Netscape `cookies.txt`, pasted whole, for **any** site yt-dlp touches. This is what gets past a platform's bot check — see below. Escaped `\n` accepted, since host env fields are single-line. |
| `IG_COOKIES` | *(unset)* | The same thing, kept under its old name because it predates `YTDLP_COOKIES` and is already set on deployed services. Both are merged into one jar; which var you paste into makes no difference to routing. |

### Cookies, and why downloads fail without them

Every platform here treats a datacenter IP as an automation signal. From a
laptop these links resolve anonymously; from Render they get a bot check
instead. YouTube's is the one you'll hit first — *"Sign in to confirm you're
not a bot"* — which the API reports as **"That video is private or needs a
login."** on a video that is plainly public. A logged-in session is what gets
past it, and both env vars above are how you supply one.

Export a `cookies.txt` from a logged-in browser session and paste the whole
file in. A jar is domain-scoped and yt-dlp only offers each site its own
entries, so one jar can safely carry YouTube, Instagram and Facebook at once —
an Instagram session is never sent to YouTube.

Two things to expect:

- **Use burner accounts.** Requests come from a datacenter IP and accounts do
  get banned for it.
- **Sessions expire**, typically in weeks, and faster for YouTube from cloud
  IPs. When downloads start failing with the login message again, re-export
  and re-paste. There is no way around this from inside the server.

Cookies are never read from the master jar directly: yt-dlp and gallery-dl both
*rewrite* the file they're handed, so every run gets a disposable copy and the
configured session can't be clobbered by a concurrent download.
| `MAX_QUALITY` | *(off)* | Set to `1` for pure `bv*+ba/b` — highest resolution wins, codec be damned. Off by default, which prefers H.264+AAC so the file opens on anything; the trade is that YouTube publishes no H.264 above 1080p, so a 4K upload arrives as 1080p. |

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
