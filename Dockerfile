# Annona — Telegram grocery-savings bot (Bun, long-polling, no exposed ports)
FROM oven/bun:1

WORKDIR /app

# Install only production deps first (better layer caching)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# App source (tests/fixtures/docs are excluded via .dockerignore — not needed at runtime)
COPY tsconfig.json ./
COPY src ./src

# SQLite DB lives in /app/data, mounted as a named volume at runtime
ENV NODE_ENV=production

# Secrets (TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, ALLOWED_USER_IDS) come from env_file at runtime
CMD ["bun", "run", "src/main.ts"]
