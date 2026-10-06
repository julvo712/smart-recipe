# sidecar image for the mc-convert HTTP service (arm64 native build)
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY dist ./dist
RUN npm ci --no-audit --no-fund --omit=dev && rm -rf node_modules/.cache
COPY sidecar ./sidecar
EXPOSE 8200
CMD ["node", "sidecar/server.mjs"]