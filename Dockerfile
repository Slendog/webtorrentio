# ---- Build stage: installs dependencies with a compiler toolchain available, so native add-ons
# without a prebuilt binary for this CPU (utp-native on arm64) are compiled from source.
FROM node:22 AS build

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# Local stand-in for the `ip` package, referenced by "overrides" in package.json.
COPY vendor ./vendor
# Install scripts must run: node-datachannel (WebRTC) downloads a prebuilt binary, utp-native
# (uTP, BitTorrent over UDP) uses a prebuild or compiles here.
RUN npm ci --omit=dev && npm cache clean --force

# ---- Runtime stage: slim image without compilers; only the installed modules are copied.
FROM node:22-slim

# ffmpeg for the optional audio conversion (AUDIO_CONVERSIONS): video is copied, only the audio
# is re-encoded, so no GPU is needed.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    WEBTORRENTIO_DOCKER=1 \
    PORT=7000 \
    HOST=0.0.0.0 \
    TORRENT_PORT=6881 \
    DOWNLOAD_PATH=/data \
    STATE_FILE=/app/state/state.json

COPY --from=build /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY vendor ./vendor
COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /data /app/state && chown node:node /data /app/state
USER node
VOLUME /data /app/state

# 7000: addon HTTP. 6881: incoming BitTorrent peers (TCP and uTP over UDP). 6882: DHT (UDP).
EXPOSE 7000 6881/tcp 6881/udp 6882/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 7000) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "src/index.js"]
