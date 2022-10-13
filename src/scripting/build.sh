#!/bin/bash

QUICKJS_ROOT=include/quickjs
QUICKJS_CONFIG_VERSION=$(cat $QUICKJS_ROOT/VERSION)

emcc \
  -O3 \
  --no-entry \
  --emit-symbol-map \
  -s ALLOW_MEMORY_GROWTH=0 \
  -s INITIAL_MEMORY=16777216 \
  -s MALLOC=emmalloc \
  -o ./build/scripting-runtime.wasm \
  -D_GNU_SOURCE \
  -DCONFIG_VERSION=\"$QUICKJS_CONFIG_VERSION\" \
  -DCONFIG_STACK_CHECK \
  src/*.c \
  include/quickjs/{quickjs,cutils,libregexp,libunicode}.c
