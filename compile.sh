#!/bin/bash

set -e

PROJECT_DIR="$PWD"
IMAGE_NAME="tauri-builder"
TARGET=$1

if [ -z "$TARGET" ]; then
    echo "Diagnostic Error: You forgot to tell me what to build, sir."
    echo "Usage: ./compile.sh [android|pc]"
    exit 1
fi

echo "Initializing Stark Manufacturing Protocol for: $TARGET..."

if [ "$TARGET" == "android" ]; then
    echo "Targeting Android (aarch64, debug, split ABI). Don't blame me if your UI looks terrible on a phone."
    docker run -it --rm \
      -v "$PROJECT_DIR":/app \
      -v tauri-cargo-registry:/root/.cargo/registry \
      -v tauri-cargo-git:/root/.cargo/git \
      "$IMAGE_NAME" \
      bash -c "npm install && npm run tauri android build -- --debug --target aarch64 --split-per-abi"

elif [ "$TARGET" == "pc" ]; then
    echo "Targeting PC (Linux native). Compiling..."
    docker run -it --rm \
      -v "$PROJECT_DIR":/app \
      -v tauri-cargo-registry:/root/.cargo/registry \
      -v tauri-cargo-git:/root/.cargo/git \
      "$IMAGE_NAME" \
      bash -c "npm install && npm run tauri build"

else
    echo "System Failure: '$TARGET' is not a recognized platform. Did the shrapnel finally reach your brain?"
    exit 1
fi

echo "Compilation sequence terminated. If it failed, it's your code, not my environment."