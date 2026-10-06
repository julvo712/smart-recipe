# multi-stage build, targets arm64 natively (build on the M4)
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsup.config.ts ./
COPY src ./src
COPY test ./test
RUN npm ci --no-audit --no-fund && npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# Chromium deps for the one-time Lidl browser login (login-browser)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libasound2 libpango-1.0-0 libcairo2 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
# Playwright's bundled Chromium lives outside node_modules; install it once here.
RUN npx playwright install chromium && chmod -R o+rwx /root/.cache/ms-playwright || true
ENTRYPOINT ["node", "/app/dist/cli/main.js"]