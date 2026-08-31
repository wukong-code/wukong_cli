#!/bin/sh
set -eu

REPO_OWNER="mutnpc"
REPO_NAME="wukong-code"
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
  TARGET="win32-${ARCH}"
  BINARY_NAME="wukong.exe"
else
  TARGET="${PLATFORM}-${ARCH}"
fi

ARTIFACT="wukong-${TARGET}.zip"

# Prefer an explicitly pinned release. The default path uses GitHub's stable
# latest-download redirect so installs do not depend on the rate-limited API.
if [ -n "${WUKONG_VERSION:-}" ]; then
  VERSION="$WUKONG_VERSION"
  RELEASE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${VERSION}/${ARTIFACT}"
else
  VERSION="latest"
  RELEASE_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest/download/${ARTIFACT}"
fi

CHECKSUM_URL="${RELEASE_URL}.sha256"

for REQUIRED_COMMAND in curl unzip; do
  if ! command -v "$REQUIRED_COMMAND" >/dev/null 2>&1; then
    echo "Cannot install Wukong Code: ${REQUIRED_COMMAND} is required."
    exit 1
  fi
done

echo "Installing Wukong Code ${VERSION} for ${TARGET}..."
echo "Download URL: ${RELEASE_URL}"

TMP_DIR="$(mktemp -d)"
STAGED_BINARY=""
cleanup() {
  rm -rf "$TMP_DIR"
  if [ -n "$STAGED_BINARY" ]; then
    rm -f "$STAGED_BINARY"
  fi
}
trap cleanup EXIT

curl -fsSL "$RELEASE_URL" -o "${TMP_DIR}/${ARTIFACT}"
curl -fsSL "$CHECKSUM_URL" -o "${TMP_DIR}/${ARTIFACT}.sha256"

EXPECTED_SHA256="$(sed -n 's/^\([0-9a-fA-F]\{64\}\).*/\1/p' "${TMP_DIR}/${ARTIFACT}.sha256")"
if [ -z "$EXPECTED_SHA256" ]; then
  echo "Release checksum is missing or invalid."
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(sha256sum "${TMP_DIR}/${ARTIFACT}" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(shasum -a 256 "${TMP_DIR}/${ARTIFACT}" | awk '{print $1}')"
else
  echo "Cannot verify release: sha256sum or shasum is required."
  exit 1
fi

if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo "Release checksum verification failed."
  exit 1
fi

echo "Verified SHA-256: ${ACTUAL_SHA256}"

EXTRACT_DIR="${TMP_DIR}/extracted"
mkdir -p "$EXTRACT_DIR"
unzip -q "${TMP_DIR}/${ARTIFACT}" -d "$EXTRACT_DIR"
if [ ! -f "${EXTRACT_DIR}/${BINARY_NAME}" ]; then
  echo "Release archive does not contain ${BINARY_NAME}."
  exit 1
fi

# Copy beside the current binary and then rename it into place. The final
# rename is atomic on macOS/Linux, so an interrupted upgrade keeps the old
# executable intact.
mkdir -p "$INSTALL_DIR"
STAGED_BINARY="${INSTALL_DIR}/.${BINARY_NAME}.update.$$"
cp "${EXTRACT_DIR}/${BINARY_NAME}" "$STAGED_BINARY"
chmod +x "$STAGED_BINARY"
if ! "$STAGED_BINARY" --version >/dev/null 2>&1; then
  echo "The downloaded Wukong binary failed its self-check; the existing installation was not changed."
  exit 1
fi
mv -f "$STAGED_BINARY" "${INSTALL_DIR}/${BINARY_NAME}"
STAGED_BINARY=""

echo ""
echo "Wukong Code installed to: ${INSTALL_DIR}/${BINARY_NAME}"

# POSIX-compatible PATH check
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) VERIFY_COMMAND="wukong --version" ;;
  *)
    VERIFY_COMMAND="${INSTALL_DIR}/${BINARY_NAME} --version"
    echo ""
    echo "Add the following to your shell profile to add wukong to your PATH:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac

echo ""
echo "Run '${VERIFY_COMMAND}' to verify the installation."
echo ""
echo "Then start Wukong in a project:"
echo "  cd YOUR_PROJECT"
echo "  wukong"
echo ""
echo "Inside Wukong, run /provider to configure a model, then /loop <goal>."
