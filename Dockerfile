# Synapse – Backend (C++), Frontend (React) und Embedding-Modell in einem Image.
#
#   docker compose up -d            → http://localhost:8080
#   docker build --build-arg MODEL=minilm .   # kleineres, nur englisches Modell

# ---- Frontend ----
FROM node:22-bookworm-slim AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- Backend ----
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

# ---- Embedding-Modell ----
FROM ubuntu:24.04 AS model
ARG MODEL=e5
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY scripts/download_model.sh scripts/
RUN ./scripts/download_model.sh "$MODEL"

# ---- Laufzeit ----
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends libsqlite3-0 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=backend /src/backend/third_party/onnxruntime/lib/ /usr/local/lib/
RUN ldconfig
COPY --from=backend /src/backend/build/synapse /usr/local/bin/synapse
COPY --from=frontend /src/frontend/dist /app/public
COPY --from=model /src/models/ /app/models/
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

ENV PORT=8080 \
    SYNAPSE_HOST=0.0.0.0 \
    SYNAPSE_DB=/data/synapse.db \
    SYNAPSE_VAULT=/data/vault \
    SYNAPSE_STATIC=/app/public \
    PUID=1000 \
    PGID=1000
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD curl -fsS "http://127.0.0.1:$PORT/api/status" >/dev/null || exit 1
ENTRYPOINT ["entrypoint.sh"]
CMD ["synapse"]
