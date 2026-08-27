FROM oven/bun:1.3.14 AS base
WORKDIR /app

FROM base AS install
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS release
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    coreutils \
    python3 \
    python3-aubio \
    python3-numpy \
    libsndfile1 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=install /app/node_modules ./node_modules
COPY package.json ./
COPY scripts ./scripts
COPY src ./src

RUN python3 -c "import aubio, numpy; print('radio audio analyzer ready')" \
  && bun run check

RUN mkdir -p /app/data && chown bun:bun /app/data

USER bun

EXPOSE 8787

CMD ["bun", "run", "src/index.ts"]
