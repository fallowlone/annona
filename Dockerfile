# Annona — Telegram grocery-savings bot (Bun, long-polling, no exposed ports)
# Pinned to a patch version so "deployed <sha>" maps to a reproducible runtime.
FROM oven/bun:1.3.11

WORKDIR /app

# Install only production deps first (better layer caching)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# App source (tests/fixtures/docs are excluded via .dockerignore — not needed at runtime)
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# SQLite DB lives in /app/data, mounted as a named volume at runtime
ENV NODE_ENV=production

# Liveness: the bot writes a heartbeat on a timer; fail if it stops ticking so a
# wedged-but-not-crashed process gets restarted instead of showing as healthy.
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD ["bun", "run", "scripts/healthcheck.ts"]

# Secrets (TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, ALLOWED_USER_IDS) come from env_file at runtime
CMD ["bun", "run", "src/main.ts"]
