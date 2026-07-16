# mister-retroarch-save-sync — GPL-3.0-or-later
# Conversion logic from save-file-converter (GPL-3.0):
# https://github.com/euan-forrester/save-file-converter

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY vendor ./vendor
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends inotify-tools tzdata \
    && rm -rf /var/lib/apt/lists/*

# The runtime needs no node_modules: the daemon uses only Node built-ins plus
# dist/converter.cjs, which esbuild bundles with all its dependencies baked in.

LABEL org.opencontainers.image.source="https://github.com/juaniwck/mister-retroarch-save-sync" \
      org.opencontainers.image.description="Keeps game saves converted between a MiSTer saves tree and a RetroArch saves tree" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY src ./src
COPY LICENSE ./LICENSE
COPY vendor/save-file-converter/LICENSE ./LICENSE.save-file-converter

# TZ selects the timezone used for log timestamps (tzdata is installed above).
# Override with any TZ database name, e.g. TZ=America/New_York or Europe/London.
ENV TZ=UTC \
    RETROARCH_ROOT=/retroarch \
    MISTER_SAVES=/mister/saves \
    SYNC_ON_START=true \
    WRITE_MANIFEST=true \
    CREATE_MISSING_DIRS=true \
    SETTLE_MS=1500 \
    MANIFEST_DEBOUNCE_MS=3000

CMD ["node", "src/daemon.js"]
