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
    && apt-get install -y --no-install-recommends inotify-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY src ./src
COPY LICENSE ./LICENSE
COPY vendor/save-file-converter/LICENSE ./LICENSE.save-file-converter

ENV RETROARCH_ROOT=/retroarch \
    MISTER_SAVES=/mister/saves \
    SYNC_ON_START=true \
    WRITE_MANIFEST=true \
    CREATE_MISSING_DIRS=true \
    SETTLE_MS=1500 \
    MANIFEST_DEBOUNCE_MS=3000

CMD ["node", "src/daemon.js"]
