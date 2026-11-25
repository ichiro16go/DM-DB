# One image, two entrypoints:
#   service: node dist/server/index.js   (web UI + API + MCP)
#   job:     node dist/jobs/update.js     (crawl → build → quality gate → publish)
#   job:     node dist/jobs/meta-update.js (環境: weekly ranking + CS results, seeds bundled deck lists)
# The DB is not baked in: the server downloads the published dm.sqlite from DM_DATA_STORE.

# mirror.gcr.io = Google's Docker Hub mirror (avoids Docker Hub pull rate limits, also on Cloud Build)
FROM mirror.gcr.io/library/node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 normally installs a prebuilt binary; install a compiler toolchain only if that fails
# (build stage only; nothing from it but node_modules and dist reaches the final image).
RUN npm ci || (apt-get update && apt-get install -y --no-install-recommends python3 make g++ && npm ci)
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
RUN npx tsc -p tsconfig.build.json && npx vite build --config web/vite.config.ts && npm prune --omit=dev

FROM mirror.gcr.io/library/node:22-bookworm-slim
ENV NODE_ENV=production \
    DM_DATA_DIR=/tmp/dm-data \
    DM_DB_PATH=/tmp/dm-data/dm.sqlite
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY --from=build /app/web/dist ./web/dist
COPY meta/decklists ./meta/decklists
RUN mkdir -p /tmp/dm-data && chown node:node /tmp/dm-data
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/server/index.js"]
