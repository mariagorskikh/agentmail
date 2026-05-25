# syntax=docker/dockerfile:1.7

# ---------- deps stage ----------
# Install production dependencies in an isolated layer so the final image
# stays small and reproducible. `tsx` is in `dependencies` (not devDeps), so
# `npm ci --omit=dev` keeps the runtime ability to execute TypeScript directly.
FROM node:22-slim AS deps

WORKDIR /app

# Copy only manifests first to maximize layer caching.
COPY package.json package-lock.json ./

RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# ---------- runtime stage ----------
FROM node:22-slim AS runtime

LABEL org.opencontainers.image.source="https://github.com/mariagorskikh/agentmail"
LABEL org.opencontainers.image.description="AgentMail — agent-native mailbox"
LABEL org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=3000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# `wget` is needed for the HEALTHCHECK below. node:22-slim ships with it
# absent, so install it (very small) and clean up apt caches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends wget \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pull in the prepared node_modules from the deps stage.
COPY --from=deps /app/node_modules ./node_modules

# Application source. We DON'T run `tsc` — `tsx` executes TS at runtime.
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY config ./config
COPY sdk ./sdk
COPY web ./web
COPY SKILL.md ./SKILL.md

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3000/healthz || exit 1

# ENTRYPOINT pins the runtime; CMD is the script path so the same image can
# run either the server or the worker:
#   docker run agentmail                   # → tsx src/server.ts
#   docker run agentmail src/worker.ts     # → tsx src/worker.ts
#   docker run agentmail scripts/migrate.ts# → tsx scripts/migrate.ts
ENTRYPOINT ["npx", "tsx"]
CMD ["src/server.ts"]
