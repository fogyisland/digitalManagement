# syntax=docker/dockerfile:1

# Two stages: build the frontend, then run the Node backend that serves both
# the API and the built frontend from a single port.

# --- Stage 1: build the frontend -------------------------------------------
FROM node:22-slim AS frontend

WORKDIR /build/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# --- Stage 2: the application ----------------------------------------------
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=8000 \
    HOST=0.0.0.0 \
    DB_PATH=/app/backend/data/dam.db \
    STORAGE_DIR=/app/backend/storage

WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY backend/ ./

# The server looks for the frontend build two levels above `backend/`, which
# is `/app/frontend/dist`.
COPY --from=frontend /build/frontend/dist /app/frontend/dist

RUN mkdir -p /app/backend/data /app/backend/storage

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8000/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
