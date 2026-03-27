#!/bin/bash

# Stop immediately if a command fails
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

# The Fix: Removed '-it'. Docker no longer expects you to be staring at it.
COMMON_DOCKER_FLAGS=(
  --rm
  -v "$PROJECT_DIR":/app
  -v tauri-cargo-registry:/root/.cargo/registry
  -v tauri-cargo-git:/root/.cargo/git
  -v tauri-target-cache:/app/src-tauri/target
  -v tauri-sccache:/root/.cache/sccache
  --env RUSTC_WRAPPER=sccache
  --memory="5.5g"
  --cpus="1"
)

if [ "$TARGET" == "android" ]; then
    echo "Targeting Android (aarch64). Deployed to the cloud (of je broekzak)."
    
    docker run "${COMMON_DOCKER_FLAGS[@]}" "$IMAGE_NAME" \
      bash -c "pnpm install && pnpm tauri android build --target aarch64 --debug"

elif [ "$TARGET" == "pc" ]; then
    echo "Targeting PC (Linux native). Probeer je weer een mainframe te hacken?"
    docker run "${COMMON_DOCKER_FLAGS[@]}" "$IMAGE_NAME" \
      bash -c "pnpm install && pnpm tauri build"

else
    echo "System Failure: '$TARGET' is not a recognized platform. Schrapnel in de hersenen?"
    exit 1
fi

echo "Compilation sequence terminated. De resultaten staan in src-tauri/gen/android of target/release."