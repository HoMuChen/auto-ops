# --- Build stage ---
FROM node:20-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile=false

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY drizzle ./drizzle
RUN pnpm build

# --- Runtime stage ---
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile=false

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/drizzle ./drizzle

EXPOSE 8080
CMD ["node", "dist/index.js"]
