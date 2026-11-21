# Prism Cam — notes for Claude

Glass camera studio: arrange webcams, screen capture, images, video, text, stickers on a canvas, add effects / AI background / hand tracking / animation, and send the result to Discord etc. as a Windows 11 virtual camera named **Prism Cam**.
Tauri 2 (chosen by the user over Electron, 2026-11-13). Shares the Prism suite shell with Prism Size.

Read first: `../CLAUDE.md` (suite rules) and `../docs/LESSONS.md` — lesson #1 happened in THIS app.
More detail: `docs/features.md`, `docs/architecture.md`, `docs/pitfalls.md`, `docs/changelog.md`.

## What the user opens
Desktop `Prism Cam.lnk` → `prism-cam\app\bin\prism-cam.exe` (next to it: `prism_vcam.dll`, `WebView2Loader.dll`).
The UI (`app/renderer`) is **embedded in the exe** — editing HTML/JS changes nothing for the user until you rebuild AND copy the exe into `app\bin`.

## Build (Git Bash, from `prism-cam/`)
```bash
W=$(cygpath -u "$(ls -d "$LOCALAPPDATA/Microsoft/WinGet/Packages/"*WinLibs*/mingw64/bin | head -1)")
export PATH="$W:$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$USERPROFILE/PrismCamBuild/target"      # NEVER under AppData
cargo build --release --workspace --manifest-path app/src-tauri/Cargo.toml
taskkill //F //IM prism-cam.exe 2>/dev/null
cp "$CARGO_TARGET_DIR/release/prism-cam.exe" "$CARGO_TARGET_DIR/release/prism_vcam.dll" app/bin/
```
- GNU Rust toolchain + WinLibs MinGW (no MSVC on this machine). `cygpath` is required or `C:` breaks PATH. Linker warning "multiple non-default manifests" is harmless.
- `cargo test --release -p prism-vcam --manifest-path app/src-tauri/Cargo.toml --test selftest` — tests the camera media source in-process.
- `npm run web` (`dev-server.js`, port 5317) previews the UI in a browser — no virtual camera, no native commands.
- `Start Prism Cam.bat` = dev helper (build + copy into app\bin). Not for the user.

## Verify the user gets the new build
1. `ls -l app/bin/prism-cam.exe` timestamp = the build you just made.
2. Each start writes `START exe=<path> exe_mtime=<secs> env_args=… act=…` to `%LOCALAPPDATA%\com.prism.cam\prism.log` (`app/src-tauri/src/main.rs`). When the **user** launches it, that is the REAL AppData — read it with the schtasks trick (`../docs/LESSONS.md` #1), not with `cat` from my shell.

## Test hook
`PRISM_ACT` = comma list run on start: `clear`, dock adds (`camera` auto-picks the USB camera, `shape`, `text`, `frame`, `sticker`…), `props`, `dark`/`light`, `en`/`th`, `info`, `vcam`, `vcamtest`, `chip:<Thai chip label>`, `tab:<layers|props|hand|lib>` (`hand` = the Tracking tab), `mediatest` (saved-video round trip), `dragtest` (drag into an area in a throw-away scene), `unguard` (clear the camera-hang guard), face: `img:<url>` / `imgb64:<base64 jpeg>` (add a picture), `place:<cover|contain|…>` (selected layer), `unsel`, `face:pack:<id>` / `face:paint:<id>` / `face:av:<id>`, `facepick`, `facelog:<s>` (logs the tracker), `selai:<remove|blur>` (first picture), `hidesrc`, `facecal` (fit to the face in view, 3 s), `facecalclear`, `faceswap`, `faceset:<key>=<value>` (project.face, e.g. `mesh=true`, `gpu=false`), `wearbind` (one-click put on / take off on the first face layer), `weartoggle[:ms]`, `nearsim` (logs the hand-at-face zone check with synthetic hands), `unbindnear` (removes those bindings, hands off). Browser preview runs the same hooks with `?act=…`. `en`/`dark` persist → finish with `th,light`. Don't kill the app while the camera is opening (see pitfalls).
Screenshot: PowerShell `CopyFromScreen` on the process's main-window rect.

## Rules specific to this app
- Installing the virtual camera needs UAC once (`prism-cam.exe --install-vcam`: copies the DLL to `%ProgramFiles%\Prism Cam`, registers CLSID in HKLM). Leave that click to the user. If `prism_vcam.dll` changes, the installed copy no longer matches (`is_installed` compares files) → the user must install again.
- Hand control can send real mouse/keys to the PC — only while the user armed it; Ctrl+Shift+F12 always disarms. Never loosen that.
- Thai strings in `` T`…` ``, English in `app/renderer/js/lang-en.js` (shell strings shared with Prism Size).
- `PKG_NAME` in `main.rs` must equal `app/package.json` "name" (`prism-cam-studio`) or the updater refuses the update.

## Release
GitHub: `Pangpond543/prism-cam` (public; `app/prism.config.json` → repo). New version: bump `app/package.json` + `app/src-tauri/Cargo.toml` version, run the i18n audit (see pitfalls), `bash tools/release.sh` → `%USERPROFILE%\PrismCamBuild\dist\Prism-Cam-<ver>-Setup.exe` + `-Portable.zip`, commit + push, `gh release create v<ver> <both files>`. No CI build (see pitfalls).
