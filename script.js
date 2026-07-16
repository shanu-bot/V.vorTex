/* ==========================================================================
   VIDEO-HUB — script.js
   Vanilla JS. No frameworks, no dependencies.

   Modules
   01. Helpers                 07. Download flow
   02. Page loader             08. Result panel
   03. Custom cursor           09. FAQ accordion
   04. Particles               10. Scroll reveal (AOS-style)
   05. Navbar                  11. 3D tilt + parallax
   06. Typing headline         12. Toasts + misc
   ========================================================================== */

(function () {
  "use strict";

  /* ========================================================================
     00. CONFIG  <-- the only thing you need to edit
     ========================================================================

     The API is found automatically. On boot we ask whatever server handed us
     this page whether it also answers /api/health:

       yes -> use it (same origin). Covers `npm start`, your phone on the LAN,
              and a Cloudflare tunnel, with nothing to configure. The tunnel is
              the reason this is a probe rather than a hostname check: a quick
              tunnel's subdomain is random and changes on every restart, so it
              could never have been hardcoded.
       no  -> fall back to PROD_API. Covers GitHub Pages, where the site is
              static and the API lives on a different host entirely.

     PROD_API: your separately-deployed API, no trailing slash. Left "", a
     statically-hosted site stays in DEMO MODE -- the flow works end to end, but
     the buttons only toast instead of downloading.
     ======================================================================== */

  const PROD_API = "";   // e.g. "https://video-hub-api.onrender.com"

  // Resolved by probeApi() before any download runs. Never read this directly
  // without awaiting apiReady first.
  let API_BASE = PROD_API;

  /**
   * Ask the current origin whether it is also our API.
   * Short timeout on purpose: on a static host this request is *expected* to
   * fail, and the page must never stall waiting for it.
   */
  async function probeApi() {
    // file:// has no real origin, so there is nothing to probe.
    if (location.protocol === "file:") return (API_BASE = PROD_API);

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(location.origin + "/api/health", {
        signal: ctrl.signal,
        cache: "no-store"
      });
      clearTimeout(timer);

      // A 200 alone isn't proof: a static host may serve a 200 index page for
      // unknown paths. Require the actual health payload.
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data && data.ok === true) return (API_BASE = location.origin);
      }
    } catch {
      // Not same-origin, or nothing listening. Fall through to PROD_API.
    }
    return (API_BASE = PROD_API);
  }

  // Start the probe immediately; startDownload awaits it before deciding.
  const apiReady = probeApi();


  /* ========================================================================
     01. HELPERS
     ======================================================================== */

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isTouch = window.matchMedia("(hover: none)").matches;

  /** rAF-throttle: collapse bursts of events into one frame. */
  function rafThrottle(fn) {
    let queued = false;
    let lastArgs;
    return function (...args) {
      lastArgs = args;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        fn.apply(this, lastArgs);
      });
    };
  }

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
  const randBetween = (min, max) => Math.random() * (max - min) + min;

  /* ========================================================================
     02. PAGE LOADER
     ======================================================================== */

  window.addEventListener("load", () => {
    const loader = $("#pageLoader");
    if (!loader) return;
    // Brief hold so the spinner doesn't flash on fast connections.
    setTimeout(() => loader.classList.add("done"), 500);
    setTimeout(() => loader.remove(), 1200);
  });

  /* ========================================================================
     03. CUSTOM CURSOR + MOUSE-FOLLOW LIGHT
     ======================================================================== */

  function initCursor() {
    if (isTouch || prefersReduced) return;

    const dot = $("#cursorDot");
    const ring = $("#cursorRing");
    const light = $("#mouseLight");
    if (!dot || !ring || !light) return;

    let mx = window.innerWidth / 2;
    let my = window.innerHeight / 2;
    let rx = mx, ry = my;   // ring position (trails)
    let lx = mx, ly = my;   // light position (trails slower)
    let visible = false;

    window.addEventListener("mousemove", (e) => {
      mx = e.clientX;
      my = e.clientY;
      if (!visible) {
        visible = true;
        dot.classList.add("on");
        ring.classList.add("on");
        light.classList.add("on");
      }
    }, { passive: true });

    document.addEventListener("mouseleave", () => {
      visible = false;
      dot.classList.remove("on");
      ring.classList.remove("on");
      light.classList.remove("on");
    });

    // Single rAF loop drives all three layers.
    (function loop() {
      rx = lerp(rx, mx, 0.18);
      ry = lerp(ry, my, 0.18);
      lx = lerp(lx, mx, 0.06);
      ly = lerp(ly, my, 0.06);

      dot.style.transform = `translate3d(${mx}px, ${my}px, 0) translate(-50%, -50%)`;
      ring.style.transform = `translate3d(${rx}px, ${ry}px, 0) translate(-50%, -50%)`;
      light.style.transform = `translate3d(${lx}px, ${ly}px, 0) translate(-50%, -50%)`;

      requestAnimationFrame(loop);
    })();

    // Grow the ring over anything clickable.
    const hotSelector = "a, button, input, .tilt, .chip, .faq-q";
    document.addEventListener("mouseover", (e) => {
      if (e.target.closest(hotSelector)) {
        ring.classList.add("hot");
        dot.classList.add("hot");
      }
    });
    document.addEventListener("mouseout", (e) => {
      if (e.target.closest(hotSelector)) {
        ring.classList.remove("hot");
        dot.classList.remove("hot");
      }
    });
  }

  /* ========================================================================
     04. PARTICLE BACKGROUND
     ======================================================================== */

  function initParticles() {
    const canvas = $("#particles");
    if (!canvas || prefersReduced) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const COLORS = ["#2563EB", "#10B981", "#FACC15"];
    let particles = [];
    let w = 0, h = 0, dpr = 1;
    let running = true;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    }

    function seed() {
      // Scale count to viewport; keep it light on phones.
      const density = window.innerWidth < 700 ? 14000 : 9000;
      const count = clamp(Math.round((w * h) / density), 18, 90);

      particles = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: randBetween(0.8, 2.4),
        vx: randBetween(-0.22, 0.22),
        vy: randBetween(-0.3, -0.05),
        alpha: randBetween(0.18, 0.6),
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        twinkle: randBetween(0.004, 0.014),
        phase: Math.random() * Math.PI * 2
      }));
    }

    function draw() {
      if (!running) return;
      ctx.clearRect(0, 0, w, h);

      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.phase += p.twinkle;

        // Wrap around the edges.
        if (p.y < -10) { p.y = h + 10; p.x = Math.random() * w; }
        if (p.x < -10) p.x = w + 10;
        if (p.x > w + 10) p.x = -10;

        const a = p.alpha * (0.6 + 0.4 * Math.sin(p.phase));
        ctx.globalAlpha = a;
        ctx.fillStyle = p.color;
        ctx.shadowBlur = 8;
        ctx.shadowColor = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      requestAnimationFrame(draw);
    }

    resize();
    draw();
    window.addEventListener("resize", rafThrottle(resize), { passive: true });

    // Pause the loop when the tab is hidden — saves battery.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        running = false;
      } else if (!running) {
        running = true;
        draw();
      }
    });
  }

  /* ========================================================================
     05. NAVBAR — sticky state, active link, mobile menu, progress
     ======================================================================== */

  function initNavbar() {
    const navbar = $("#navbar");
    const toggle = $("#navToggle");
    const menu = $("#navMenu");
    const progress = $("#navProgress");
    const toTop = $("#toTop");
    const links = $$(".nav-link");

    // Mobile menu
    if (toggle && menu) {
      toggle.addEventListener("click", () => {
        const open = menu.classList.toggle("open");
        toggle.classList.toggle("open", open);
        toggle.setAttribute("aria-expanded", String(open));
      });

      // Close after tapping a link.
      menu.addEventListener("click", (e) => {
        if (e.target.closest(".nav-link")) {
          menu.classList.remove("open");
          toggle.classList.remove("open");
          toggle.setAttribute("aria-expanded", "false");
        }
      });
    }

    const sections = links
      .map((l) => $(l.getAttribute("href")))
      .filter(Boolean);

    const onScroll = rafThrottle(() => {
      const y = window.scrollY;

      if (navbar) navbar.classList.toggle("scrolled", y > 12);
      if (toTop) toTop.classList.toggle("show", y > 600);

      // Reading progress
      if (progress) {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        progress.style.width = (max > 0 ? (y / max) * 100 : 0) + "%";
      }

      // Active section — the one occupying the upper third of the viewport.
      const line = y + window.innerHeight * 0.32;
      let current = sections[0];
      for (const s of sections) {
        if (s.offsetTop <= line) current = s;
      }
      if (current) {
        links.forEach((l) =>
          l.classList.toggle("active", l.getAttribute("href") === "#" + current.id)
        );
      }
    });

    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    if (toTop) {
      toTop.addEventListener("click", () =>
        window.scrollTo({ top: 0, behavior: prefersReduced ? "auto" : "smooth" })
      );
    }
  }

  /* ========================================================================
     06. TYPING HEADLINE
     ======================================================================== */

  function initTyping() {
    const target = $("#typeTarget");
    if (!target) return;

    const words = ["TikTok", "Instagram", "Facebook"];

    if (prefersReduced) {
      target.textContent = "TikTok, Instagram & Facebook";
      return;
    }

    let wordIdx = 0;
    let charIdx = 0;
    let deleting = false;

    function tick() {
      const word = words[wordIdx];
      charIdx += deleting ? -1 : 1;
      target.textContent = word.slice(0, charIdx);

      let delay = deleting ? 45 : 95;

      if (!deleting && charIdx === word.length) {
        delay = 1500;          // hold the finished word
        deleting = true;
      } else if (deleting && charIdx === 0) {
        deleting = false;
        wordIdx = (wordIdx + 1) % words.length;
        delay = 350;
      }

      setTimeout(tick, delay);
    }

    tick();
  }

  /* ========================================================================
     07. DOWNLOAD FLOW — validation, platform detection, loading
     ======================================================================== */

  /* Platform registry: pattern + presentation data in one place. */
  const PLATFORMS = {
    tiktok: {
      name: "TikTok",
      // tiktok.com, vm./vt./m. short links
      pattern: /^(https?:\/\/)?((www|vm|vt|m)\.)?tiktok\.com\/.+/i,
      icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.6 5.82A4.28 4.28 0 0 1 15.54 3h-3.09v12.4a2.59 2.59 0 0 1-2.59 2.5 2.59 2.59 0 1 1 .6-5.1V9.66a5.66 5.66 0 0 0-.6-.03A5.63 5.63 0 1 0 15.5 15.3V8.99a7.3 7.3 0 0 0 4.27 1.37V7.27a4.25 4.25 0 0 1-3.17-1.45Z"/></svg>',
      quality: "1080p • HD",
      duration: "00:32",
      size: "12.4 MB",
      title: "TikTok video — no watermark, original quality"
    },
    instagram: {
      name: "Instagram",
      // /p/, /reel/, /reels/, /tv/, /stories/
      pattern: /^(https?:\/\/)?((www|m)\.)?instagram\.com\/(p|reel|reels|tv|stories)\/.+/i,
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1.2" fill="currentColor" stroke="none"/></svg>',
      quality: "1080p • HD",
      duration: "00:47",
      size: "18.9 MB",
      title: "Instagram Reel — ready to save"
    },
    facebook: {
      name: "Facebook",
      // facebook.com/... , fb.watch/... , fb.com/...
      pattern: /^(https?:\/\/)?((www|web|m)\.)?(facebook\.com\/.+|fb\.watch\/.+|fb\.com\/.+)/i,
      icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5 3.66 9.15 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.52 1.49-3.91 3.77-3.91 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.78-1.63 1.57v1.89h2.78l-.45 2.91h-2.33V22c4.78-.79 8.44-4.94 8.44-9.94Z"/></svg>',
      quality: "720p • HD",
      duration: "01:14",
      size: "24.1 MB",
      title: "Facebook video — HD ready"
    }
  };

  /** Returns the platform key for a URL, or null when unsupported. */
  function detectPlatform(url) {
    const clean = url.trim();
    for (const [key, p] of Object.entries(PLATFORMS)) {
      if (p.pattern.test(clean)) return key;
    }
    return null;
  }

  /** Loose check that the string is even URL-shaped. */
  function looksLikeUrl(str) {
    return /^(https?:\/\/)?[\w-]+(\.[\w-]+)+([/?#].*)?$/i.test(str.trim());
  }

  function initDownloadFlow() {
    const form = $("#downloadForm");
    const input = $("#videoUrl");
    const wrap = $("#inputWrap");
    const btn = $("#downloadBtn");
    const badge = $("#inputPlatform");
    const pasteBtn = $("#pasteBtn");
    if (!form || !input || !btn) return;

    // ---- Focus ring state ----
    input.addEventListener("focus", () => wrap.classList.add("focused"));
    input.addEventListener("blur", () => wrap.classList.remove("focused"));

    // ---- Live platform detection while typing ----
    input.addEventListener("input", () => {
      wrap.classList.remove("invalid");
      const key = detectPlatform(input.value);

      wrap.classList.toggle("valid", Boolean(key));
      if (key && badge) {
        badge.innerHTML = PLATFORMS[key].icon;
        badge.classList.add("show");
      } else if (badge) {
        badge.classList.remove("show");
      }
    });

    // ---- Paste from clipboard ----
    if (pasteBtn) {
      pasteBtn.addEventListener("click", async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (!text) {
            toast("warn", "Your clipboard is empty.");
            return;
          }
          input.value = text.trim();
          input.dispatchEvent(new Event("input"));
          input.focus();
          toast("info", "Link pasted from clipboard.");
        } catch {
          // Clipboard API needs permission / HTTPS — fall back to a nudge.
          input.focus();
          toast("warn", "Clipboard blocked — paste manually with Ctrl+V.");
        }
      });
    }

    // ---- Submit ----
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const value = input.value.trim();

      // Empty
      if (!value) {
        wrap.classList.add("invalid");
        input.focus();
        toast("warn", "Please paste a video link first.");
        setTimeout(() => wrap.classList.remove("invalid"), 700);
        return;
      }

      // Not URL-shaped at all
      if (!looksLikeUrl(value)) {
        wrap.classList.add("invalid");
        toast("warn", "That doesn't look like a link. Check and try again.");
        setTimeout(() => wrap.classList.remove("invalid"), 700);
        return;
      }

      // URL-shaped but not a supported platform
      const key = detectPlatform(value);
      if (!key) {
        wrap.classList.add("invalid");
        toast("warn", "Unsupported link. Use TikTok, Instagram or Facebook.");
        setTimeout(() => wrap.classList.remove("invalid"), 700);
        return;
      }

      startDownload(key, value, btn);
    });
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Ask the API to resolve the link, then reveal the result panel. */
  async function startDownload(key, url, btn) {
    btn.classList.add("loading");
    btn.setAttribute("aria-busy", "true");

    try {
      // The probe starts at boot and is almost always settled by the time
      // anyone clicks, but await it so a fast click can't read API_BASE early
      // and wrongly fall into demo mode.
      await apiReady;

      // ---- Demo mode: no backend reachable ----
      if (!API_BASE) {
        await wait(1200);
        showResult(key, url, null);
        toast("ok", `${PLATFORMS[key].name} video ready — demo mode.`);
        return;
      }

      // ---- Real mode ----
      // Resolving can genuinely take a while, so give it a generous ceiling
      // rather than letting the spinner hang forever on a dead server.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);

      let res, data;
      try {
        res = await fetch(`${API_BASE}/api/info?url=${encodeURIComponent(url)}`, {
          signal: ctrl.signal
        });
        data = await res.json();
      } finally {
        clearTimeout(timer);
      }

      // The server sends a readable `error` for the cases it can explain
      // (private video, removed, rate limited). Surface that, not a status code.
      if (!res.ok) throw new Error(data && data.error ? data.error : "Couldn't fetch that video.");

      showResult(key, url, data);
      toast("ok", `${data.platformName || PLATFORMS[key].name} video ready to download.`);
    } catch (err) {
      if (err.name === "AbortError") {
        toast("warn", "The server took too long. Try again.");
      } else if (err instanceof TypeError) {
        // fetch() only throws TypeError when the request never completed:
        // server asleep, DNS gone, or CORS refused it.
        toast("warn", "Can't reach the server. It may be waking up — retry in a moment.");
      } else {
        toast("warn", err.message);
      }
    } finally {
      btn.classList.remove("loading");
      btn.removeAttribute("aria-busy");
    }
  }

  /* ========================================================================
     08. RESULT PANEL
     ======================================================================== */

  /**
   * @param {string} key    platform key
   * @param {string} url    the source link
   * @param {object|null} info  API payload, or null in demo mode
   */
  function showResult(key, url, info) {
    const section = $("#resultSection");
    const card = $("#resultCard");
    if (!section || !card) return;

    const p = PLATFORMS[key];
    // Demo mode falls back to the canned figures in PLATFORMS; real mode uses
    // the API payload but still falls back per-field, since yt-dlp doesn't
    // report duration/filesize for every video on every platform.
    const d = info || {};

    // ---- Fill in the details ----
    const tag = $("#resultPlatformTag");
    if (tag) tag.dataset.p = key;
    setHtml("#resultPlatformIcon", p.icon);
    setText("#resultPlatformName", d.platformName || p.name);
    setText("#resultTitle", d.title || p.title);
    setText("#metaPlatform", d.platformName || p.name);
    setText("#metaQuality", d.quality || p.quality);
    setText("#metaSize", d.size || (info ? "Unknown" : p.size));
    setText("#previewDuration", d.duration || p.duration);
    setThumbnail(d.thumbnail);

    if (API_BASE) {
      // Real download endpoints — the server streams the file back with a
      // Content-Disposition header, so the browser saves rather than plays it.
      const q = encodeURIComponent(url);
      setAttr("#dlHd", "href", `${API_BASE}/api/download?url=${q}&format=hd`);
      setAttr("#dlSd", "href", `${API_BASE}/api/download?url=${q}&format=sd`);
      setAttr("#dlMp3", "href", `${API_BASE}/api/download?url=${q}&format=mp3`);
    } else {
      const slug = key + "-video";
      setAttr("#dlHd", "href", `#download-${slug}-1080p`);
      setAttr("#dlSd", "href", `#download-${slug}-480p`);
      setAttr("#dlMp3", "href", `#download-${slug}-audio`);
    }

    // Remember the source link for the Copy button.
    card.dataset.sourceUrl = url;

    // ---- Reveal with the 3D entrance ----
    section.hidden = false;
    card.classList.remove("out", "settled");
    // Restart the animation even if the panel was already open.
    card.classList.remove("in");
    void card.offsetWidth; // force reflow so the animation replays
    card.classList.add("in");

    // Hand transform back to the tilt handler once the entrance settles —
    // the animation's forwards fill would otherwise keep overriding it.
    card.addEventListener("animationend", function done(e) {
      if (e.animationName !== "cardIn3d") return;
      card.removeEventListener("animationend", done);
      card.classList.remove("in");
      card.classList.add("settled");
    });

    // Scroll it into view once it has started animating in.
    setTimeout(() => {
      section.scrollIntoView({
        behavior: prefersReduced ? "auto" : "smooth",
        block: "center"
      });
    }, 180);
  }

  function initResultPanel() {
    const section = $("#resultSection");
    const card = $("#resultCard");
    const close = $("#resultClose");
    const copy = $("#dlCopy");

    if (close && section && card) {
      close.addEventListener("click", () => {
        card.classList.remove("in", "settled");
        card.classList.add("out");
        setTimeout(() => {
          section.hidden = true;
          card.classList.remove("out");
        }, 400);
      });
    }

    // Copy the source link.
    if (copy && card) {
      copy.addEventListener("click", async () => {
        const url = card.dataset.sourceUrl || "";
        const label = $("span", copy);
        const original = label ? label.textContent : "";

        try {
          await navigator.clipboard.writeText(url);
        } catch {
          // Fallback for browsers without the async clipboard API.
          const tmp = document.createElement("textarea");
          tmp.value = url;
          tmp.setAttribute("readonly", "");
          tmp.style.position = "absolute";
          tmp.style.left = "-9999px";
          document.body.appendChild(tmp);
          tmp.select();
          try { document.execCommand("copy"); } catch { /* nothing else to try */ }
          document.body.removeChild(tmp);
        }

        copy.classList.add("copied");
        if (label) label.textContent = "Copied!";
        toast("ok", "Link copied to clipboard.");

        setTimeout(() => {
          copy.classList.remove("copied");
          if (label) label.textContent = original;
        }, 1800);
      });
    }

    $$(".dl-btn[download]").forEach((a) => {
      a.addEventListener("click", (e) => {
        const kind = a.querySelector("span")?.textContent || "File";

        // Demo mode: the placeholder hrefs go nowhere, so say so rather than
        // letting the click look like it silently failed.
        if (!API_BASE) {
          e.preventDefault();
          // Name the constant that actually exists -- API_BASE is derived by the
          // probe and isn't something you can set by hand.
          toast("info", `${kind} — demo mode. Set PROD_API in script.js to your API URL.`);
          return;
        }

        // Real mode: let the browser handle it natively. The `download`
        // attribute is ignored cross-origin, which is fine — the server's
        // Content-Disposition header is what actually forces the save.
        toast("info", `${kind} started — check your downloads.`);
      });
    });
  }

  /**
   * Drop the real thumbnail into the preview card.
   * Loaded straight from the platform CDN — if it's hotlink-blocked or the
   * link rots, onerror removes it and the gradient placeholder shows through,
   * so a missing image can never leave a broken-image icon on the card.
   */
  function setThumbnail(src) {
    const host = $("#previewThumb");
    if (!host) return;

    const old = $(".preview-img", host);
    if (old) old.remove();
    if (!src) return;

    const img = new Image();
    img.className = "preview-img";
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer"; // some CDNs 403 on a foreign Referer
    img.onerror = () => img.remove();
    img.src = src;
    host.prepend(img);
  }

  const setText = (sel, val) => { const el = $(sel); if (el) el.textContent = val; };
  const setHtml = (sel, val) => { const el = $(sel); if (el) el.innerHTML = val; };
  const setAttr = (sel, attr, val) => { const el = $(sel); if (el) el.setAttribute(attr, val); };

  /* ========================================================================
     09. FAQ ACCORDION
     ======================================================================== */

  function initFaq() {
    const items = $$(".faq-item");

    items.forEach((item) => {
      const q = $(".faq-q", item);
      const a = $(".faq-a", item);
      if (!q || !a) return;

      q.addEventListener("click", () => {
        const isOpen = item.classList.contains("open");

        // Accordion: only one open at a time.
        items.forEach((other) => {
          other.classList.remove("open");
          const oa = $(".faq-a", other);
          const oq = $(".faq-q", other);
          if (oa) oa.style.maxHeight = null;
          if (oq) oq.setAttribute("aria-expanded", "false");
        });

        if (!isOpen) {
          item.classList.add("open");
          a.style.maxHeight = a.scrollHeight + "px";
          q.setAttribute("aria-expanded", "true");
        }
      });
    });

    // Keep the open panel sized correctly when the text reflows.
    window.addEventListener("resize", rafThrottle(() => {
      const open = $(".faq-item.open");
      if (!open) return;
      const a = $(".faq-a", open);
      if (a) a.style.maxHeight = a.scrollHeight + "px";
    }), { passive: true });
  }

  /* ========================================================================
     10. SCROLL REVEAL (AOS-style, IntersectionObserver)
     ======================================================================== */

  function initReveal() {
    const els = $$(".reveal");
    if (!els.length) return;

    if (prefersReduced || !("IntersectionObserver" in window)) {
      els.forEach((el) => el.classList.add("shown"));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const el = entry.target;
          el.style.setProperty("--reveal-delay", (el.dataset.delay || 0) + "ms");
          el.classList.add("shown");
          io.unobserve(el); // reveal once, then stop watching
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );

    els.forEach((el) => io.observe(el));
  }

  /* ========================================================================
     11. 3D TILT, PARALLAX, RIPPLE
     ======================================================================== */

  function initTilt() {
    if (isTouch || prefersReduced) return;

    const MAX = 8; // degrees

    $$(".tilt").forEach((card) => {
      let raf = null;

      const move = (e) => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = null;
          const r = card.getBoundingClientRect();
          const px = (e.clientX - r.left) / r.width;   // 0 → 1
          const py = (e.clientY - r.top) / r.height;   // 0 → 1
          card.style.setProperty("--ry", ((px - 0.5) * MAX * 2).toFixed(2) + "deg");
          card.style.setProperty("--rx", ((0.5 - py) * MAX * 2).toFixed(2) + "deg");
        });
      };

      card.addEventListener("mouseenter", () => card.classList.add("tilting"));
      card.addEventListener("mousemove", move, { passive: true });
      card.addEventListener("mouseleave", () => {
        card.classList.remove("tilting");
        card.style.setProperty("--rx", "0deg");
        card.style.setProperty("--ry", "0deg");
      });
    });
  }

  /** Parallax for hero floating icons — depth from the data-depth attribute. */
  function initParallax() {
    const icons = $$(".float-icon");
    if (!icons.length || prefersReduced) return;

    const onScroll = rafThrottle(() => {
      const y = window.scrollY;
      if (y > window.innerHeight * 1.2) return; // offscreen — skip the work
      icons.forEach((icon) => {
        const depth = parseFloat(icon.dataset.depth || "1");
        icon.style.setProperty("translate", `0 ${(-y * depth * 0.06).toFixed(1)}px`);
      });
    });

    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /** Material-style ripple on any .ripple element. */
  function initRipple() {
    document.addEventListener("click", (e) => {
      const host = e.target.closest(".ripple");
      if (!host || prefersReduced) return;

      const r = host.getBoundingClientRect();
      const size = Math.max(r.width, r.height);
      const wave = document.createElement("span");

      wave.className = "ripple-wave";
      wave.style.width = wave.style.height = size + "px";
      wave.style.left = e.clientX - r.left - size / 2 + "px";
      wave.style.top = e.clientY - r.top - size / 2 + "px";

      host.appendChild(wave);
      wave.addEventListener("animationend", () => wave.remove());
    });
  }

  /* ========================================================================
     12. TOASTS + MISC
     ======================================================================== */

  const TOAST_ICONS = {
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 8v5"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>'
  };

  /**
   * Show a toast.
   * @param {"warn"|"ok"|"info"} type
   * @param {string} message
   */
  function toast(type, message) {
    const stack = $("#toastStack");
    if (!stack) return;

    const life = 3600;
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;
    el.style.setProperty("--toast-life", life + "ms");
    el.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type] || TOAST_ICONS.info}</span><span>${message}</span>`;

    stack.appendChild(el);

    // Cap the stack so it can't run off the screen.
    while (stack.children.length > 3) stack.removeChild(stack.firstChild);

    setTimeout(() => {
      el.classList.add("hide");
      el.addEventListener("animationend", () => el.remove(), { once: true });
    }, life);
  }

  /** Smooth scroll for in-page anchors (also covers browsers without CSS support). */
  function initSmoothScroll() {
    document.addEventListener("click", (e) => {
      const link = e.target.closest('a[href^="#"]');
      if (!link) return;

      const id = link.getAttribute("href");
      if (!id || id === "#" || id.startsWith("#download-")) return;

      const target = $(id);
      if (!target) return;

      e.preventDefault();
      target.scrollIntoView({
        behavior: prefersReduced ? "auto" : "smooth",
        block: "start"
      });
    });
  }

  /** Footer year. */
  function initYear() {
    const el = $("#year");
    if (el) el.textContent = String(new Date().getFullYear());
  }

  /* ========================================================================
     BOOT
     ======================================================================== */

  function init() {
    initCursor();
    initParticles();
    initNavbar();
    initTyping();
    initDownloadFlow();
    initResultPanel();
    initFaq();
    initReveal();
    initTilt();
    initParallax();
    initRipple();
    initSmoothScroll();
    initYear();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
