#!/usr/bin/env bash
set -euo pipefail

REPO_OWNER="mutnpc"
REPO_NAME="wukong-code"
INSTALL_DIR="${WUKONG_INSTALL_DIR:-$HOME/.wukong/bin}"
BINARY_NAME="wukong"
VERSION="${WUKONG_VERSION:-}"
ARTIFACT_BASE_URL="${WUKONG_ARTIFACT_BASE_URL:-}"
INSTALL_TARGET="${WUKONG_INSTALL_TARGET:-}"

if [ -n "$VERSION" ] && [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid WUKONG_VERSION: expected vMAJOR.MINOR.PATCH"
  exit 1
fi

if [ -n "$INSTALL_TARGET" ]; then
  case "$INSTALL_TARGET" in
    linux-x64|linux-arm64|darwin-x64|darwin-arm64|win32-x64|win32-arm64)
      ;;
    *)
      echo "Invalid WUKONG_INSTALL_TARGET"
      exit 1
      ;;
  esac
fi

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
  TARGET="win32-${ARCH}"
  BINARY_NAME="wukong.exe"
else
  TARGET="${PLATFORM}-${ARCH}"
fi
if [ -n "$INSTALL_TARGET" ]; then
  TARGET="$INSTALL_TARGET"
  case "$TARGET" in
    win32-*) BINARY_NAME="wukong.exe" ;;
    *) BINARY_NAME="wukong" ;;
  esac
fi

ARTIFACT="wukong-${TARGET}.zip"
if [ -n "$ARTIFACT_BASE_URL" ]; then
  RELEASE_URL="${ARTIFACT_BASE_URL%/}/${ARTIFACT}"
elif [ -n "$VERSION" ]; then
  RELEASE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${VERSION}/${ARTIFACT}"
else
  RELEASE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest/download/${ARTIFACT}"
fi

if [ -n "$VERSION" ]; then
  echo "Installing Wukong CLI ${VERSION} for ${TARGET}..."
else
  echo "Installing Wukong CLI for ${TARGET}..."
fi
echo "Download URL: ${RELEASE_URL}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

curl -fsSL "$RELEASE_URL" -o "${TMP_DIR}/${ARTIFACT}"
curl -fsSL "${RELEASE_URL}.sha256" -o "${TMP_DIR}/${ARTIFACT}.sha256"

cd "$TMP_DIR"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c "${ARTIFACT}.sha256" \
    || { echo "Checksum verification failed"; exit 1; }
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 -c "${ARTIFACT}.sha256" \
    || { echo "Checksum verification failed"; exit 1; }
else
  echo "Checksum verification failed: install sha256sum or shasum"
  exit 1
fi

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
