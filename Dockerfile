# Synapse – C++ backend, React frontend and a local embedding model in one image.
#
#   docker compose up -d                        → http://localhost:8080
#   docker build --build-arg MODEL=minilm .     # smaller, English-only model
#
# Frontend and model are platform independent and always built natively
# (BUILDPLATFORM); only the C++ backend is compiled for the target platform.

# ---- frontend ----
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- backend ----
FROM ubuntu:24.04 AS backend
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build libsqlite3-dev curl ca-certificates nodejs npm \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY scripts/setup_onnxruntime.sh scripts/
RUN ./scripts/setup_onnxruntime.sh
COPY backend/ backend/
RUN cmake -S backend -B backend/build -G Ninja -DSYNAPSE_ARCH_FLAGS= \
    && cmake --build backend/build \
    && ./backend/build/synapse_tests

# ---- embedding model ----
FROM --platform=$BUILDPLATFORM ubuntu:24.04 AS model
ARG MODEL=e5
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY scripts/download_model.sh scripts/
RUN ./scripts/download_model.sh "$MODEL"

# ---- runtime ----
FROM ubuntu:24.04
LABEL org.opencontainers.image.title="Synapse" \
      org.opencontainers.image.description="Notes + flashcards + knowledge graph. Local-first, Markdown vault, local AI links, MCP server." \
      org.opencontainers.image.source="https://github.com/moritzjh/Synapse" \
      org.opencontainers.image.licenses="MIT"
RUN apt-get update && apt-get install -y --no-install-recommends libsqlite3-0 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=backend /src/backend/third_party/onnxruntime/lib/ /usr/local/lib/
RUN ldconfig
COPY --from=backend /src/backend/build/synapse /usr/local/bin/synapse
COPY --from=frontend /src/frontend/dist /app/public
COPY --from=model /src/models/ /app/models/
COPY demo/vault /app/demo/vault
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

ENV PORT=8080 \
    SYNAPSE_HOST=0.0.0.0 \
    SYNAPSE_DB=/data/synapse.db \
    SYNAPSE_VAULT=/data/vault \
    SYNAPSE_STATIC=/app/public \
    SYNAPSE_DEMO=1 \
    PUID=1000 \
    PGID=1000
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD curl -fsS "http://127.0.0.1:$PORT/api/status" >/dev/null || exit 1
ENTRYPOINT ["entrypoint.sh"]
CMD ["synapse"]
