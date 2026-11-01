# syntax=docker/dockerfile:1

# Two stages: build the frontend, then run the Node backend that serves both
# the API and the built frontend from a single port.

# --- Stage 1: build the frontend -------------------------------------------
FROM node:22-slim AS frontend

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.ts tsconfig.json tsconfig.node.json ./
COPY public/ ./public/
COPY src/client/ ./src/client/

RUN npm run build

# --- Stage 2: the application ----------------------------------------------
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8000 \
    HOST=0.0.0.0 \
    STORAGE_DIR=/app/storage

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/server/ ./src/server/

# The server looks for the frontend build in the repository root, which is
# `/app` in the container.
COPY --from=frontend /build/dist/ ./dist/

RUN mkdir -p /app/storage

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server/server.js"]
