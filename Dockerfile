FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# Local stand-in for the `ip` package, referenced by "overrides" in package.json.
COPY vendor ./vendor
# Install scripts must run: node-datachannel (WebRTC) downloads a prebuilt binary that
# WebTorrent requires. utp-native is optional; if it has no prebuild for the CPU, it is skipped.
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts

ENV PORT=7000 \
    HOST=0.0.0.0 \
    TORRENT_PORT=6881 \
    DOWNLOAD_PATH=/data \
    STATE_FILE=/app/state/state.json

RUN mkdir -p /data /app/state && chown node:node /data /app/state
USER node
VOLUME /data /app/state

# 7000: addon HTTP. 6881: incoming BitTorrent peers (TCP and uTP over UDP). 6882: DHT (UDP).
EXPOSE 7000 6881/tcp 6881/udp 6882/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 7000) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node", "src/index.js"]
