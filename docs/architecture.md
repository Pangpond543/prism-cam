# Prism Cam — code map

```
prism-cam/
  Start Prism Cam.bat     dev helper: build → copy into app\bin → run
  dev-server.js           browser preview of app/renderer (npm run web, port 5317)
  tools/make-icon.js      icon generator
  AMD-driver-timeout-report.md   draft support report from the 2026-11-14 camera hunt (see pitfalls — the real cause was the wrong exe)
  app/
    package.json          name "prism-cam-studio" (updater identity), version
    prism.config.json     GitHub repo for updates (empty)
    bin/                  ← what the user's shortcut runs: prism-cam.exe, prism_vcam.dll, WebView2Loader.dll
    renderer/             UI, embedded into the exe at build time (frontendDist)
      index.html, css/ (style, cam, anim, fonts), js/ (see features.md for module roles)
      vendor/mediapipe/   vision bundle, wasm, hand_landmarker.task, selfie_segmenter.tflite
    src-tauri/
      tauri.conf.json     window + additionalBrowserArgs (WebView2 switches) + CSP
      src/main.rs         commands (names mirror Prism Size IPC: win:min → win_min), START log, camera permission
      src/vcam_host.rs    register camera, install (elevated), write frames
      src/input.rs        hand control → SendInput, file picker, open program
      src/update.rs       GitHub updater
      src/shared.rs       app ↔ DLL contract (CLSID, frame file layout) — include!()'d by both crates
      vcam/src/lib.rs     prism_vcam.dll: COM class factory + Media Foundation media source (NV12)
      vcam/tests/selftest.rs
```

Data: Tauri `app_data_dir` (project, hand models), log in `%LOCALAPPDATA%\com.prism.cam\prism.log`, frames in `%ProgramData%\PrismCam`.
