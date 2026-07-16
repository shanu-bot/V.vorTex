# 🎬 Video-Hub

A video downloader for TikTok, Instagram and Facebook. Paste a link, pick a
quality, save the file.

The frontend is hand-written HTML/CSS/JS — no frameworks, no build step, no
dependencies. Glassmorphism cards, 3D tilt, animated gradients, particle
background, scroll reveals.

## Structure

```
index.html      markup
style.css       all styling (~1400 lines, 14 sections)
script.js       all behaviour (12 modules)
server/         the resolver API — see server/README.md
```

The three root files are the whole website. `server/` is a separate service; the
site runs without it in demo mode.

## Running the site

Open `index.html`. That's it — there's nothing to build or install.

Out of the box it runs in **demo mode**: the flow works end to end, but the
download buttons only show a toast. That's because a static site *cannot*
download these videos — see below.

## Making the downloads real

A browser can't fetch a TikTok/Instagram/Facebook video directly:

- **CORS** — those sites send no `Access-Control-Allow-Origin`, so JavaScript on
  your domain is blocked from reading their pages.
- **Signed URLs** — the real MP4 sits behind a tokenized, expiring link you
  can't derive from the page URL.

So the resolving happens server-side. Deploy the API in [`server/`](server/)
(free, ~5 minutes — instructions in [server/README.md](server/README.md)), then
point the site at it by editing one line near the top of `script.js`:

```js
const API_BASE = "https://your-api.onrender.com";   // no trailing slash
```

Leave it `""` to stay in demo mode.

## Deploying the site to GitHub Pages

Settings → Pages → Source: **Deploy from a branch** → `main` / `/ (root)`.

Your site lands at `https://<username>.github.io/<repo>/`. Pages serves static
files only, which is exactly why the API is hosted separately.

## Browser support

Modern evergreen browsers. Uses `backdrop-filter`, `color-mix()`, `@property`,
and `IntersectionObserver`. Respects `prefers-reduced-motion`; the cursor,
tilt and mouse-lighting effects are disabled on touch devices by design.

## Legal

This fetches content you don't own. Downloading is generally fine for content
that's yours, that's licensed for it, or that falls under local fair-use /
private-copy rules — redistributing someone else's video generally isn't.
Automated downloading also breaches the terms of service of all three
platforms. If you deploy this to a public URL, you are the operator and that's
your responsibility, not the code's.

Provided as-is, for learning and personal use.
