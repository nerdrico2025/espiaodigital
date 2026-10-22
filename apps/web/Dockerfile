# Web (Next.js) — contexto de build = raiz do monorepo.
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Instala dependências do workspace (cacheável).
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN npm ci

# Código.
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web

# NEXT_PUBLIC_* são embutidas no build do client.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY

RUN npm run build -w @espiao/web

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@espiao/web"]
