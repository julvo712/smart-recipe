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
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
ENTRYPOINT ["node", "/app/dist/cli/main.js"]