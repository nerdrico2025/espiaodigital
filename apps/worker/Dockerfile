# Worker (Node/TypeScript via tsx) — contexto de build = raiz do monorepo.
# Precisa de yt-dlp e ffmpeg para baixar vídeos e extrair áudio.
FROM node:22-bookworm-slim AS base
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
  && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Dependências do workspace (cacheável).
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN npm ci

# Código.
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker

ENV NODE_ENV=production
CMD ["npm", "run", "start", "-w", "@espiao/worker"]
