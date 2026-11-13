#!/usr/bin/env bash
# Сборка LibRaw -> WebAssembly (нужен активированный emsdk: source emsdk_env.sh)
set -euo pipefail
cd "$(dirname "$0")"
LIBRAW_VERSION=0.22.1
if [ ! -d LibRaw ]; then
  git clone --branch "$LIBRAW_VERSION" --depth 1 https://github.com/LibRaw/LibRaw.git LibRaw
fi
FLAGS="-O3 -fwasm-exceptions -DLIBRAW_NOTHREADS -w"
if [ ! -f LibRaw/lib/libraw.a ]; then
  (cd LibRaw && emmake make -f Makefile.dist -j"$(nproc)" library \
     CC=emcc CXX=em++ AR=emar CFLAGS="$FLAGS -I.")
fi
mkdir -p ../public/wasm
em++ $FLAGS -ILibRaw plenka_raw.cpp LibRaw/lib/libraw.a \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=PlenkaRaw \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=4GB \
  -sENVIRONMENT=web,worker,node -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS=_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU16,HEAP32,UTF8ToString \
  -o ../public/wasm/plenka_raw.mjs
ls -la ../public/wasm
