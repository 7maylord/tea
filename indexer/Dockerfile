FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY config.yaml schema.graphql tsconfig.json ./
COPY src ./src
RUN pnpm codegen && pnpm check
EXPOSE 8080
CMD ["pnpm", "start"]
