# --- Build stage ---
FROM node:20-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY drizzle ./drizzle
RUN pnpm build
# tsc only emits .js/.d.ts — copy .md pack assets into dist so agents can readdir() them at runtime
RUN find src -type d -name 'packs' | while read d; do \
      dest="dist/${d#src/}"; \
      mkdir -p "$dest"; \
      cp "$d"/*.md "$dest/"; \
    done

# --- Runtime stage ---
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle

USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
