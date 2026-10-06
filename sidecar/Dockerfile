# mc-convert HTTP sidecar: builds the fork library, then serves sidecar/server.mjs
# (arm64 native build on the deploy host)
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsup.config.ts ./
COPY src ./src
COPY test ./test
RUN npm ci --no-audit --no-fund && npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /app/dist ./dist
RUN npm ci --no-audit --no-fund --omit=dev --ignore-scripts && rm -rf node_modules/.cache
COPY sidecar ./sidecar
EXPOSE 8200
CMD ["node", "sidecar/server.mjs"]