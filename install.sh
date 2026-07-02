#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="mutnpc"
REPO_NAME="wukong-cli"
INSTALL_DIR="${WUKONG_INSTALL_DIR:-$HOME/.wukong/bin}"
BINARY_NAME="wukong"

# Determine platform and architecture
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$PLATFORM" in
  darwin)
    PLATFORM="darwin"
    ;;
  linux)
    PLATFORM="linux"
    ;;
  mingw*|msys*|cygwin*)
    PLATFORM="win"
    ;;
  *)
    echo "Unsupported platform: $PLATFORM"
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64|amd64)
    ARCH="x64"
    ;;
  arm64|aarch64)
    ARCH="arm64"
    ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

if [ "$PLATFORM" = "win" ]; then
  TARGET="win-${ARCH}"
  BINARY_NAME="wukong.exe"
else
  TARGET="${PLATFORM}-${ARCH}"
fi

ARTIFACT="wukong-${TARGET}.zip"
RELEASE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest/download/${ARTIFACT}"

echo "Installing Wukong CLI for ${TARGET}..."
echo "Download URL: ${RELEASE_URL}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

curl -fsSL "$RELEASE_URL" -o "${TMP_DIR}/${ARTIFACT}"
curl -fsSL "${RELEASE_URL}.sha256" -o "${TMP_DIR}/${ARTIFACT}.sha256"

cd "$TMP_DIR"
shasum -a 256 -c "${ARTIFACT}.sha256" || { echo "Checksum verification failed"; exit 1; }

mkdir -p "$INSTALL_DIR"
unzip -o "$ARTIFACT" -d "$INSTALL_DIR"
chmod +x "${INSTALL_DIR}/${BINARY_NAME}"

echo ""
echo "Wukong CLI installed to: ${INSTALL_DIR}/${BINARY_NAME}"

if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
  echo ""
  echo "Add the following to your shell profile to add wukong to your PATH:"
  echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
fi

echo ""
echo "Run 'wukong --version' to verify the installation."
