# ---------- build stage ----------
FROM node:20-slim AS build
# Toolchain in case better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------- runtime stage ----------
FROM node:20-slim
ENV NODE_ENV=production \
    PORT=8080 \
    SONGS_DIR=/data/songs \
    BEATMAPS_DIR=/data/osu \
    DB_PATH=/data/app/osuguessr.db
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
EXPOSE 8080
CMD ["node", "server.js"]