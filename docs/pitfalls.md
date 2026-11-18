# Prism Cam — pitfalls (symptom → cause → do this)

- **User says "still hangs / not fixed" while my build works** → the user is running a different (old) exe. 2026-11-14 I built into `%LOCALAPPDATA%\PrismCam\target`, which the MSIX Claude app redirects to a private store, so nothing reached the user for hours. → Build into `%USERPROFILE%\PrismCamBuild\target`, copy into `app\bin`, check the START log line from the user's own launch. Full story: `../../docs/LESSONS.md` #1.
- **Camera stuck on "Opening…" + AMD driver timeout (Event 4101)** → I treated this as a GPU-driver problem and added Chromium switches (`additionalBrowserArgs` in `tauri.conf.json`: no D3D11 video capture/decoder, no accelerated MJPEG/video decode, no GPU memory buffer frames). It was never confirmed that the driver was the cause, because the user was on the old exe the whole time. → Don't build more on that theory; if camera trouble returns, first confirm the user runs the current build, then test removing switches one by one.
- **UI change not visible to the user** → renderer is embedded in the exe → rebuild + copy to `app\bin`.
- **`windres`/`gcc` not found** → WinLibs isn't on PATH in a fresh shell → the `cygpath` PATH line in CLAUDE.md.
- **Copy into `app\bin` fails** → Prism Cam is running → `taskkill //F //IM prism-cam.exe` first.
- **Virtual camera missing in Discord after a DLL change** → installed DLL in `%ProgramFiles%\Prism Cam` is the old one → user presses Start virtual camera and accepts UAC again.
- **Test hook leaves app in English/dark** → `en`/`dark` persist → run `PRISM_ACT=th,light`.
- **Speed tests on a freshly built exe show 100 % CPU** → Windows scans the new exe for the first minute; auto quality then drops to 50 %. → Wait a minute after building before measuring; compare runs back to back.
- **GPU converter saved nothing (2026-11-18)** → with a CPU (`willReadFrequently`) scene canvas, uploading it to WebGL each frame costs as much as the conversion saves, and a plain `readPixels` blocks ~7 ms. → The scene canvas must be a GPU canvas when the converter is on, and read back asynchronously (PBO + fence). Both are in place; keep them together.
- **Hover flicker on cards that lift (`translateY` on :hover)** → the box slides off a pointer on its bottom edge. → Give it a hover strip (`::after` below it, see cam.css) or move only the inner content.
- **Ctrl+Z per zone under the mouse** confused the user (2026-11-18) → undo is global (newest change first). Don't bring zone-by-mouse back.
- **Native `<select>` look** → never ship a bare select: `select.js` styles all of them automatically; check new ones render as `.gs-btn`.
- **Recording at 60 fps came out ~50 fps** → `canvas.captureStream(fps)` samples on screen refresh, and the draw timer drifts against it. → `captureStream(0)` + `track.requestFrame()` after each draw. Not an encoder limit (VP9 / VP8 / H.264 all gave the same 50–52).
- **Virtual camera at 60 fps** → not done on purpose: Discord takes 30 from a camera, and changing the DLL forces every user to reinstall the camera (UAC). The app sends ≤ 30 to it.
- **AI "remove background" sends a black picture** → nobody is in front of the camera (the model finds no person). Not a bug; test with a person or with "blur".
- **MediaPipe worker fails to load** → hand worker must stay a CLASSIC worker (MediaPipe uses importScripts) and CSP needs `wasm-unsafe-eval` + `worker-src blob:`.


## Undo history keeps layers, not pictures (2026-11-16)
Images live in `project.assets` (data URLs inside project.json); undo snapshots skip them. `save()` used to delete every asset no current layer used → delete a layer, wait 0.7 s, Ctrl+Z = empty layer forever. `save()` now also keeps assets named in undo/redo snapshots. Don't add another asset clean-up without checking history. Videos are only kept if the layer has `media` (added 2026-11-16); older video layers have no file.

## Self-test of a drag in the real exe (2026-11-16)
`PRISM_ACT=dragtest` drags in a throw-away scene. If the real mouse cursor is over the window (e.g. after SetForegroundWindow for a screenshot) its own pointermove moves the drag to the cursor and the drop cancels → park the cursor off-window (`SetCursorPos`) before the test.

## Another session may edit the same files
2026-11-16 a parallel session changed `save()` in `studio.js` while I was patching it. Patch with fresh reads (exact-match replace scripts), never overwrite a whole file from an old copy.

## Killing the app during a self-test can hold the camera (2026-11-16)
Stopping `prism-cam.exe` while the camera is still opening leaves the `prismCamOpening` guard set → next start shows "ครั้งก่อนกล้องค้าง — ดับเบิลคลิกเพื่อลองเปิดใหม่" and does not open the camera. → After self-tests run `PRISM_ACT=unguard` once, then a normal start and wait for `camera OK` in the log before closing.

## Layout made in animation mode "resets" outside it (2026-11-16)
Moving things in Edit mode writes keyframes, not the layer's own x/y. If that clip doesn't play outside Edit mode (not auto, hand-driven with no hand yet), the layers show their own values (often the centre). Check `drive` first: a hand-driven clip used to apply only after a hand was seen. Single keys at 0 s are now baked into the layer (`bakeStatic` in anim.js) — skipped for hand-driven clips (their `lost: hide` must still let go).

## Reading the user's real save
`%APPDATA%\com.prism.cam\project.json` (Roaming). Copy it out with a schtasks `.cmd` (robocopy into `%USERPROFILE%\PrismCamBuild\realdata`), then load a shrunk copy (assets → 1×1 PNGs) into the browser preview via `localStorage['prismcam.project']`. Delete any copy put in `app/renderer` before building — it would be embedded in the exe.

## Argument order: create the row, then read the value (2026-11-16)
`A.setKey(c, A.ensureTrack(...), t, dispV(...))` creates the empty row first, so `dispV` read it and got `undefined` → NaN, picture at top-left. Read the value BEFORE `ensureTrack`, or keep `dispV` guarded for rows without keys.

## Ctrl+Z "does nothing" in the animation panels (2026-11-16)
The panels' number boxes are `type=text`. After a click they keep focus and Ctrl+Z went to the browser's own text undo. The global handler now only leaves Ctrl+Z to a text box that has been typed into since it got focus (`_typed`, set by `input`, cleared on `focusin`).

## Areas carry their contents (2026-11-18)
- An area's kids are stored in absolute stage coordinates. Any change of the area's box is carried to the kids by `syncAreas()` (runs every frame in `draw()` and in `commit()`), which compares against the non-saved `_f`. **Never move kids yourself after changing an area** (the old `shiftKids` is gone) — it would be applied twice. Code that already transforms kids itself (e.g. `resizeOut`) must call `setF(A)` afterwards.
- During an animation-mode edit the area is suspended at its animated values; `hooks.rest(A)` returns its box before the edit and `syncAreas` skips it — otherwise the kids would be baked while the area is only being keyframed.
- `groupItems` must call `hooks.begin` BEFORE reading w/h/rot, or animated layers warp on a group resize.

## Releases / translations (2026-11-18)
- **New Thai string → English entry in the same change.** The audit `node tools/i18n-audit.js app/renderer` found ~220 Thai strings with no English — the whole Hand area. Run it before every release, then open the UI with `?lang=en` (`npm run web`) and scan the DOM for Thai.
- **Release files come from `tools/release.sh`, not CI.** No GitHub Actions build: the local toolchain is GNU Rust + WinLibs and the DLL / WebView2Loader setup was only tested that way. Publish with `gh release create`. Asset names must contain `Setup`…`.exe` / `Portable`…`.zip` or the in-app updater finds nothing (`noasset`).
- **Installed vs portable is decided by `uninstall.exe` next to the exe.** Keep `installer.nsi` and `update::UNINSTALLER` in step.
- **Default hand poses are the author's data** — regenerate `default-hands.json` only from the user's real `hands.json` (schtasks copy), built-in pose ids only (skip `c:` / `pair:c:`), never the mouse calibration.
- Testing the installer from Claude's shell kills a running Prism Cam (`taskkill` inside the installer) — ask first. Install with `/S /D=<test dir>` via PowerShell `Start-Process` (Git Bash mangles `/S`).
