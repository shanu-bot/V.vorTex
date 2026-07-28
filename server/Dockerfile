# Vid VorTex API. Docker rather than a plain Node buildpack because yt-dlp needs
# Python and the MP3 route needs ffmpeg -- neither ships with a Node image.

FROM node:20-bookworm-slim

# ca-certificates: yt-dlp talks HTTPS to the platforms.
# ffmpeg: required, not optional -- every video download merges a separate
#   video and audio stream into the MP4, and the MP3 route transcodes with it.
# python3-venv: gallery-dl is installed into a venv, see below.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-venv \
      ffmpeg \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

# Pull the yt-dlp standalone build. Pinned on purpose: "latest" means your
# image silently changes between deploys, so a broken release becomes a mystery
# outage. Bump this tag deliberately when a platform breaks (see README).
ARG YTDLP_VERSION=2026.07.04
RUN curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" \
      -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && yt-dlp --version

# gallery-dl handles photo posts. yt-dlp is video-only: an Instagram /p/ photo
# makes it exit with "There is no video in this post", and no format selector
# changes that -- there is no video track to select.
#
# Installed into a venv because Debian 12 marks the system Python
# externally-managed (PEP 668), so a plain `pip install` refuses to run.
ARG GALLERYDL_VERSION=1.32.6
RUN python3 -m venv /opt/gallery-dl \
    && /opt/gallery-dl/bin/pip install --no-cache-dir --quiet \
         "gallery-dl==${GALLERYDL_VERSION}" \
    && /opt/gallery-dl/bin/gallery-dl --version
ENV GALLERYDL_PATH=/opt/gallery-dl/bin/gallery-dl

WORKDIR /app

# Copy manifests first so `docker build` reuses the npm layer when only
# server.js changes. `npm ci` (not `install`) installs the exact versions in
# package-lock.json, so a deploy months from now builds what was tested today.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./

# Don't run as root: yt-dlp is executing against untrusted remote content.
USER node

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
