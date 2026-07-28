FROM node:26.5.0-trixie-slim AS toolchain

RUN npm install --global pnpm@11

FROM toolchain AS build

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY queries ./queries
COPY scripts/build-server.ts ./scripts/build-server.ts
COPY src ./src
RUN pnpm build

FROM toolchain AS production-dependencies

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM node:26.5.0-trixie-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/queries ./queries
COPY web ./web
COPY package.json ./
USER node
CMD ["node", "dist/cli/index.js", "worker"]
