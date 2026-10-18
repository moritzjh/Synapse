#!/usr/bin/env bash
# Downloads ONNX Runtime (shared library + C/C++ headers) into
# backend/third_party/onnxruntime. The library is taken from the
# onnxruntime-node npm package, which ships prebuilt binaries for
# Linux and macOS (x64 + arm64).
set -euo pipefail

VERSION="${ORT_VERSION:-1.22.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/backend/third_party/onnxruntime"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  SRC="linux/x64/libonnxruntime.so.1";             LIB="libonnxruntime.so" ;;
  Linux-aarch64) SRC="linux/arm64/libonnxruntime.so.1";           LIB="libonnxruntime.so" ;;
  Darwin-arm64)  SRC="darwin/arm64/libonnxruntime.$VERSION.dylib"; LIB="libonnxruntime.dylib" ;;
  Darwin-x86_64) SRC="darwin/x64/libonnxruntime.$VERSION.dylib";   LIB="libonnxruntime.dylib" ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

echo "→ onnxruntime $VERSION"
(cd "$TMP" && npm pack --silent "onnxruntime-node@$VERSION" >/dev/null && tar xzf onnxruntime-node-*.tgz)
mkdir -p "$DEST/lib" "$DEST/include"
cp "$TMP/package/bin/napi-v6/$SRC" "$DEST/lib/$LIB"
[ "$LIB" = libonnxruntime.so ] && ln -sf "$LIB" "$DEST/lib/libonnxruntime.so.1"

BASE="https://raw.githubusercontent.com/microsoft/onnxruntime/v$VERSION/include/onnxruntime/core/session"
for h in onnxruntime_c_api.h onnxruntime_cxx_api.h onnxruntime_cxx_inline.h onnxruntime_float16.h; do
  curl -sSfL -o "$DEST/include/$h" "$BASE/$h"
done
echo "✓ installed to $DEST"
