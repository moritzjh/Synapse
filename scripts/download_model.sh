#!/usr/bin/env bash
# Downloads a sentence-embedding model (ONNX + tokenizer.json) into models/<name>.
#
#   ./scripts/download_model.sh            # multilingual-e5-small (default, DE/EN/…)
#   ./scripts/download_model.sh minilm     # all-MiniLM-L6-v2 (English only, smaller)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="${1:-e5}"

case "$MODEL" in
  e5)
    DEST="$ROOT/models/multilingual-e5-small"
    HF="https://huggingface.co/intfloat/multilingual-e5-small/resolve/main"
    mkdir -p "$DEST"
    curl -fL -o "$DEST/model.onnx" "$HF/onnx/model.onnx"
    curl -fL -o "$DEST/tokenizer.json" "$HF/tokenizer.json"
    # e5 expects "query: " / "passage: " prefixes; we embed notes as passages.
    echo '{"prefix": "passage: ", "query_prefix": "query: ", "max_tokens": 512, "link_threshold": 0.84}' > "$DEST/synapse.json"
    ;;
  minilm)
    DEST="$ROOT/models/all-MiniLM-L6-v2"
    mkdir -p "$DEST"
    TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
    curl -fL -o "$TMP/onnx.tar.gz" https://chroma-onnx-models.s3.amazonaws.com/all-MiniLM-L6-v2/onnx.tar.gz
    tar xzf "$TMP/onnx.tar.gz" -C "$TMP"
    cp "$TMP/onnx/model.onnx" "$TMP/onnx/tokenizer.json" "$DEST/"
    echo '{"prefix": "", "max_tokens": 256, "link_threshold": 0.45}' > "$DEST/synapse.json"
    ;;
  *) echo "unknown model: $MODEL (use e5 or minilm)" >&2; exit 1 ;;
esac
echo "✓ model in $DEST"
echo "  start backend with: SYNAPSE_MODEL=$DEST ./backend/build/synapse"
