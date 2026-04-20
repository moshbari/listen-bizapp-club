# Dockerfile — Node 20 + ffmpeg + curl.
#
# Trap from the playbook (GHL_MEDIA_UPLOAD.md): Nixpacks doesn't install curl.
# We use curl for GHL uploads (Node's FormData fails on GHL's multipart parser).
# ffmpeg is used for transcoding and splitting.
#
# Build-time vars: declare ARG and ENV together when `npm install` needs a secret.
# We don't need any build-time secrets here — all GHL/auth vars are runtime only.

FROM node:20-slim

# System deps: curl for GHL uploads, ffmpeg for transcoding,
# ca-certificates so curl can hit HTTPS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# App code
COPY server.js ./
COPY lib ./lib

# Persistent volume for SQLite — mounted by Coolify
RUN mkdir -p /app/data
VOLUME ["/app/data"]
ENV DATA_DIR=/app/data

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
