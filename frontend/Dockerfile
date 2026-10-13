# syntax=docker/dockerfile:1.7
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--max-old-space-size=4096
ARG NEXT_PUBLIC_PRIVY_APP_ID
ARG NEXT_PUBLIC_API_ORIGIN
ARG NEXT_PUBLIC_CHAIN_ID
ARG NEXT_PUBLIC_AURORA_INTENTS_API_KEY
ARG NEXT_PUBLIC_RPC_URL
ENV NEXT_PUBLIC_PRIVY_APP_ID=$NEXT_PUBLIC_PRIVY_APP_ID
ENV NEXT_PUBLIC_API_ORIGIN=$NEXT_PUBLIC_API_ORIGIN
ENV NEXT_PUBLIC_CHAIN_ID=$NEXT_PUBLIC_CHAIN_ID
ENV NEXT_PUBLIC_AURORA_INTENTS_API_KEY=$NEXT_PUBLIC_AURORA_INTENTS_API_KEY
ENV NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=tea-frontend-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --store-dir=/pnpm/store
COPY . .
RUN --mount=type=cache,target=/app/.next/cache \
  pnpm build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["pnpm", "start"]
