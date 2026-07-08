#!/usr/bin/env bats

setup() {
    TEST_DIR="$(mktemp -d)"
    export TEST_DIR
    export HOME="$TEST_DIR/home"
    mkdir -p "$HOME"

    # Put mock commands ahead of system PATH
    MOCK_BIN="$TEST_DIR/bin"
    mkdir -p "$MOCK_BIN"
    export PATH="$MOCK_BIN:$PATH"

    # Default mock uname reports macOS x86_64
    cat > "$MOCK_BIN/uname" <<'EOF'
#!/bin/sh
case "$1" in
    -s) echo "Darwin" ;;
    -m) echo "x86_64" ;;
    *) echo "unknown" ;;
esac
EOF
    chmod +x "$MOCK_BIN/uname"

    # Build a fake release artifact and its SHA-256 checksum once.
    # The archive contains both Unix and Windows binary names so the
    # same mock release can be reused across platform tests.
    FAKE_RELEASE_DIR="$TEST_DIR/fake_release"
    mkdir -p "$FAKE_RELEASE_DIR"

    python3 - "$FAKE_RELEASE_DIR" <<'PY'
import hashlib, os, zipfile, sys
out_dir = sys.argv[1]
zip_path = os.path.join(out_dir, "artifact.zip")
with zipfile.ZipFile(zip_path, "w") as z:
    for name, content in (
        ("wukong", "#!/bin/sh\necho \"wukong stub\"\n"),
        ("wukong.exe", "@echo off\necho wukong stub\n"),
    ):
        info = zipfile.ZipInfo(filename=name)
        info.external_attr = (0o755 << 16)
        z.writestr(info, content)
with open(zip_path, "rb") as f:
    digest = hashlib.sha256(f.read()).hexdigest()
with open(os.path.join(out_dir, "artifact.zip.sha256"), "w") as f:
    f.write(f"{digest}  artifact.zip\n")
PY

    # Mock curl copies the fake artifact or checksum to the requested path.
    cat > "$MOCK_BIN/curl" <<EOF
#!/bin/sh
OUTPUT=""
URL=""
while [ \$# -gt 0 ]; do
    case "\$1" in
        -o) shift; OUTPUT="\$1" ;;
        -*) ;;
        *) URL="\$1" ;;
    esac
    shift
done

if echo "\$URL" | grep -q "\.sha256\$"; then
    SHA_BASENAME="\${OUTPUT%.sha256}"
    SHA_BASENAME="\${SHA_BASENAME##*/}"
    sed "s#artifact\.zip#\$SHA_BASENAME#" "$FAKE_RELEASE_DIR/artifact.zip.sha256" > "\$OUTPUT"
    exit 0
fi

if echo "\$URL" | grep -q "/download/"; then
    cp "$FAKE_RELEASE_DIR/artifact.zip" "\$OUTPUT"
    exit 0
fi

exit 1
EOF
    chmod +x "$MOCK_BIN/curl"
}

teardown() {
    rm -rf "$TEST_DIR"
}

@test "installs the latest release by default" {
    run ./install.sh
    [ "$status" -eq 0 ]
    [ -x "$HOME/.wukong/bin/wukong" ]
    [[ "$output" == *"Installing Wukong CLI for darwin-x64"* ]]
    [[ "$output" == *"wukong-cli/releases/latest/download"* ]]
    [[ "$output" == *"Wukong CLI installed to:"* ]]
}

@test "respects WUKONG_INSTALL_DIR override" {
    CUSTOM_DIR="$TEST_DIR/custom/bin"
    export WUKONG_INSTALL_DIR="$CUSTOM_DIR"
    run ./install.sh
    [ "$status" -eq 0 ]
    [ -x "$CUSTOM_DIR/wukong" ]
}

@test "fails on unsupported platform" {
    cat > "$MOCK_BIN/uname" <<'EOF'
#!/bin/sh
case "$1" in
    -s) echo "FreeBSD" ;;
    -m) echo "x86_64" ;;
esac
EOF
    chmod +x "$MOCK_BIN/uname"

    run ./install.sh
    [ "$status" -eq 1 ]
    [[ "$output" == *"Unsupported platform"* ]]
}

@test "fails on unsupported architecture" {
    cat > "$MOCK_BIN/uname" <<'EOF'
#!/bin/sh
case "$1" in
    -s) echo "Darwin" ;;
    -m) echo "riscv64" ;;
esac
EOF
    chmod +x "$MOCK_BIN/uname"

    run ./install.sh
    [ "$status" -eq 1 ]
    [[ "$output" == *"Unsupported architecture"* ]]
}

@test "fails when checksum verification fails" {
    # Override the curl mock to serve a bad checksum file.
    cat > "$MOCK_BIN/curl" <<EOF
#!/bin/sh
OUTPUT=""
URL=""
while [ \$# -gt 0 ]; do
    case "\$1" in
        -o) shift; OUTPUT="\$1" ;;
        -*) ;;
        *) URL="\$1" ;;
    esac
    shift
done

if echo "\$URL" | grep -q "\\.sha256\$"; then
    SHA_BASENAME="\${OUTPUT%.sha256}"
    SHA_BASENAME="\${SHA_BASENAME##*/}"
    echo "0000000000000000000000000000000000000000000000000000000000000000  \$SHA_BASENAME" > "\$OUTPUT"
    exit 0
fi

if echo "\$URL" | grep -q "/download/"; then
    cp "$FAKE_RELEASE_DIR/artifact.zip" "\$OUTPUT"
    exit 0
fi

exit 1
EOF
    chmod +x "$MOCK_BIN/curl"

    run ./install.sh
    [ "$status" -eq 1 ]
    [[ "$output" == *"Checksum verification failed"* ]]
}

@test "prints PATH hint when install dir is not on PATH" {
    export PATH="/usr/bin:/bin"
    run ./install.sh
    [ "$status" -eq 0 ]
    [[ "$output" == *"Add the following to your shell profile"* ]]
}

@test "does not print PATH hint when install dir is already on PATH" {
    export PATH="$HOME/.wukong/bin:/usr/bin:/bin"
    run ./install.sh
    [ "$status" -eq 0 ]
    [[ "$output" != *"Add the following to your shell profile"* ]]
}

@test "selects windows target on mingw" {
    cat > "$MOCK_BIN/uname" <<'EOF'
#!/bin/sh
case "$1" in
    -s) echo "MINGW64_NT-10.0" ;;
    -m) echo "x86_64" ;;
esac
EOF
    chmod +x "$MOCK_BIN/uname"

    run ./install.sh
    [ "$status" -eq 0 ]
    [[ "$output" == *"Installing Wukong CLI for win-x64"* ]]
    [ -x "$HOME/.wukong/bin/wukong.exe" ]
}
