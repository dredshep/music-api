FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS install
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

FROM base AS release
COPY --from=install /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

RUN mkdir -p /app/data

EXPOSE 8787

CMD ["bun", "run", "src/index.ts"]
