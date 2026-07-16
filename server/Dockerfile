# Video-Hub API. Docker rather than a plain Node buildpack because yt-dlp needs
# Python and the MP3 route needs ffmpeg -- neither ships with a Node image.

FROM node:20-bookworm-slim

# ca-certificates: yt-dlp talks HTTPS to the platforms.
# ffmpeg: only used by the /api/download?format=mp3 path.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
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
