#!/usr/bin/env bash
# Build the files people download from GitHub Releases (Git Bash, from prism-cam/):
#   tools/release.sh            → $USERPROFILE/PrismCamBuild/dist/Prism-Cam-<ver>-Setup.exe and -Portable.zip
# Needs: GNU Rust + WinLibs MinGW (see CLAUDE.md) and NSIS 3 (NSIS env var, or $USERPROFILE/PrismCamBuild/nsis-dl/nsis-3.08).
# Then publish:  gh release create v<ver> dist/*-Setup.exe dist/*-Portable.zip --title "Prism Cam <ver>" --notes-file …
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p "require('./app/package.json').version")
grep -q "^version = \"$VER\"" app/src-tauri/Cargo.toml || { echo "app/package.json $VER != app/src-tauri/Cargo.toml version"; exit 1; }

W=$(cygpath -u "$(ls -d "$LOCALAPPDATA/Microsoft/WinGet/Packages/"*WinLibs*/mingw64/bin | head -1)")
export PATH="$W:$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$USERPROFILE/PrismCamBuild/target"   # never under AppData (see ../docs/LESSONS.md #1)
cargo build --release --workspace --manifest-path app/src-tauri/Cargo.toml

DIST="$USERPROFILE/PrismCamBuild/dist"
STAGE="$DIST/stage/Prism Cam"
mkdir -p "$STAGE"
R="$CARGO_TARGET_DIR/release"   # webview2-com-sys puts WebView2Loader.dll here during the build
cp "$R/prism-cam.exe" "$R/prism_vcam.dll" "$R/WebView2Loader.dll" app/prism.config.json "$STAGE/"

ZIP="$DIST/Prism-Cam-$VER-Portable.zip"
SETUP="$DIST/Prism-Cam-$VER-Setup.exe"
rm -f "$ZIP" "$SETUP"
/c/Windows/System32/tar.exe -a -c -f "$(cygpath -w "$ZIP")" -C "$(cygpath -w "$DIST/stage")" "Prism Cam"

NSIS="${NSIS:-$USERPROFILE/PrismCamBuild/nsis-dl/nsis-3.08}"
"$NSIS/makensis.exe" -V2 -DVERSION="$VER" -DSRC="$(cygpath -w "$STAGE")" -DOUT="$(cygpath -w "$SETUP")" \
  -DICON="$(cygpath -w "$PWD/app/src-tauri/icons/icon.ico")" "$(cygpath -w "$PWD/tools/installer.nsi")"
ls -l "$ZIP" "$SETUP"
