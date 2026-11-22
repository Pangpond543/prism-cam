# Prism Cam — features (behaviour to keep)

## Sources (dock)
Webcams (USB auto-picked by test hook), screen / window capture, images (file, drag & drop, Ctrl+V), video files, text, stickers, shapes, frames.

## Studio (`studio.js`)
- Scenes → layers → 2D compositor. Free transform: drag, resize, rotate, crop (Alt + drag edge, or double-click), snapping, layer order, lock / hide.
- Quick layouts: fill, fit, picture-in-picture corners, half screen, circle bubble.
- Look: colour filters + presets, corner radius, border, shadow, blend modes.
- Undo / redo per zone under the mouse (stage & layers · animation · hand settings; elsewhere = latest), Ctrl+Z / Ctrl+Y everywhere except text boxes. Snapshot (PNG), recording (WebM).
- Several layers selected: the properties panel changes all of them (only fields each one has; X/Y/W/H stay per layer); align / distribute / same size bar; show all / hide all / solo.
- Visibility: eye on a selected row toggles the whole selection, Alt+eye = solo, Ctrl+H / Ctrl+Shift+H, "N hidden — show all" bar in the list.
- Animation areas (`type: 'area'`): box with its own `kids` list (absolute coordinates), clipped optional background. Behaves as ONE object like a video: move / resize / turn its box and everything inside (and its keyframes) goes along (`syncAreas` → `carryKids`; Alt on a handle = box only; "fit box to contents"). Double-click to edit inside (rest of the stage dimmed in the preview only); click outside the box or Esc to leave (`leaveAreaAt`). Ctrl+G groups the selection. Kids move/turn/scale with the area's animation incl. animated w/h (`areaMap` / `areaUnmap`, `areaKx/areaKy`, `restOf`).
- Output size change (`resizeOut`): positions × kx/ky, sizes × √(kx·ky), full-canvas layers refit (media re-cropped), keyframes + area contents follow, Undo in the toast.
- Drag layers like files (`dragLayers`): from the layer list or the timeline; drop into an area, between rows, on the "back" button (move out), or on an area on the stage; Esc cancels. Stage move + Ctrl over an area = put inside.
- Layer clipboard: Ctrl+C / X / V (system clipboard gets a `prism-cam:layers:` marker so a copied image still pastes as an image), Ctrl+Shift+V into the selected area; tracks are copied with the layers.
- Hover a layer row → preview card (live picture, size / length, which clips animate it, what an area holds).
- Library tab (`renderLib`): every imported picture / video (`project.lib`, backfilled from layers on start), thumbnails, search + filter, click = add, drag onto stage / area / area row, files dropped on the tab go to the library only; re-importing the same file reuses the stored copy (`sig` = name|size|mtime). Assets / media used by the library or templates are never cleaned up.
- Templates (`project.tpl`): save an area or a selection (`bundleOf`), insert from the library (`insertBundle`): fresh ids, keyframes, clip settings; an area's own clip is recreated for the copy.
- Area timeline: clips with `c.area` play by themselves (auto) while the area is visible, stop when hidden, restart when shown (`anim-core frame`). Created / edited from the area panel (`openAreaTimeline` → `anim:open`).
- Slideshow areas (`A.slides`): visible layers inside, top first, one at a time; auto every N s or on command (`slide-next:<id>` / `slide-prev:<id>`, swipe quick-bind); fade / slide / zoom / flip; page dots; all layers shown while editing inside.
- Gesture commands per area: `layer:` toggle, `layer-show:`, `layer-hide:`, play the area clip; area panel opens the bind editor (`hand:edit-bind`).
- Imported videos are copied to `<app data>/media/<id>.<ext>` (`media_put`) and reopened from `http://pmedia.localhost/` with byte ranges; unused files are removed on the next start (`media_gc`).

## Face (`face.js`, `facedefs.js`, `facepack.js`, `facepaint.js`, `avatar.js`; picker `openFacePicker` in studio.js)
- MediaPipe face landmarker in the shared AI worker (up to 4 faces, `project.face` = { faces, smooth, predict, sens }). Runs only while something in the scene uses the face (`faceUsed`: face-attached layer, face paint, avatar, face drive, `f:` binding / pose filter, picker open). Source = the same layer the hands use (`handSource`, hidden layers still work).
- `sceneFaces` (per frame, stage pixels): `p` 478 points, `z`, `w`/`h`, `roll` (eye line), `yaw` (> 0 = nose to the stage's right) / `pitch` (> 0 = up) from mesh depth, `eyeL`/`eyeR` closedness of the stage-left / right eye (MediaPipe's eye blendshape sides are decided from the eyelid gap, `tr.corr`), `mouth`, `smile`, `brow`, `kiss`, `puff`, gaze `gx`/`gy`, `nx`/`ny` (−1…1 position).
- **Tracking tab** (`handui.js` `renderFace`): face status, 1 / several faces, GPU / CPU, smoothing, lag compensation, expression sensitivity (`project.face`), preview face mesh (`project.face.mesh`, `studio.drawFaceMesh`), swap eyes + "fit to your face" (`facePerson` in `face.js`, localStorage `prismcam.face`). Folded sections: localStorage `prismcam.trackFold`.
- Fit to your face (`calibrateFace`): one face, 3 s; averages 10 blendshapes + raw yaw / pitch. `bsv(tr, name)` = (v − rest) / (1 − rest), rest capped at 0.6. `F.yaw/pitch` = from the resting pose (expressions, avatars, drives); `F.ryaw/rpitch` = real angle (sticker squash).
- Face gestures `f:smile f:mouth f:brow f:kiss f:puff f:eyes f:winkL f:winkR f:turnL f:turnR f:up f:down f:tiltL f:tiltR f:cover f:hush` (hysteresis 100 % on / 75 % off, sensitivity slider; eyes 400 ms, winks 130 ms). Winks = the person's own eye. Usable in bindings (hold / repeat / hold-mode), layer hand "only with pose", animation drive gate.
- Layer `face` = { on, pt, who ('0'..'3' | 'all'), rot, scale, turn, ref, dx, dy, lost, expr, smooth, fit, ratio, dyK, cycle } (`LFACE_DEF`). `facePose` (like `handPose`): first sight or "fit to face" sets the width from `FACE_PTS` share × face width and `ref`; `turn` squashes x by cos(yaw), y by cos(pitch) (`hs.sx/sy`). Hand-follow and face-follow are exclusive. `who: 'all'` draws the layer once per face.
- Face paint layer (`facepaint`, full stage like `handfx` — `FULLFX` set): `paint` (built-in id | 'custom' + `asset`), `color`, `who`, `op`, `blend`. Texture layout = `data/face-mesh.js` (canonical face UV + 898 triangles).
- Avatar layer (`avatar`, a normal box): `av` = { kind cat|bot|ghost|png, color, color2, who, follow, motion, parts{slot → asset} }.
- Bindings: `hand: 'both'` = two tracks making the same one-hand pose; `near: eyes|mouth|ears|top|cheeks|chin|face` = the pose must be made at that spot (`handsNearFace(list, zone, now)`; radii in face widths: eyes 0.5, ears 0.45, cheeks 0.38, mouth 0.45, chin 0.45, top 0.65, face 0.75; hand points = palm + thumb / index / middle tips). 1.2 s cooldown after such a binding fired. Hold ring at the face (`hands.faceHold`, `ZONE_RING`).
- "Put on / take off with a gesture" (`wearBind`): one binding per face layer (`layer:<id>` + `near`), zone from the sticker's spot (`zoneOfPt`). Face layers toggled by `layer:` commands appear / disappear instantly (the slide-in was removed on request, 2026-11-21).
- Commands `face-next` / `face-prev` cycle visible face layers with `cycle: true`.
- Animation drives `fyaw fpitch froll fmouth fsmile fblink fbrow fx fy fsize` (anim-core `driveRaw` → `faceDrive`).

## AI workers (`ai-worker.js`, `ai.js`)
Two workers run `ai-worker.js` (classic): `hand` = the hand model alone; `main` = face + segmentation models (lazy, GPU → CPU fallback, closed when unused). Lanes: `hand` and `face` (each its own picture, ≤ 640 px) and `seg:<layer>` (256 px). One picture in flight per lane; the hand lane waits only `handGap` (32 ms, 66 in light mode / level ≥ 2); other lanes wait max(wanted × 1.3 when behind, 1.3 × worker time). Background masks arrive asynchronously (`segFeed` / `segTake`), the newest one is used.
- Face tracking on / off: Tracking tab tick (`project.face.off`); off = `faceUsed()` false, model closed, face layers pause.

## Effects (`fx.js`)
Chroma key (green screen); AI background removal / blur (MediaPipe selfie segmenter, bundled, offline).

## Hands (`hands.js`, model in `ai-worker.js`, `handfx.js`, `handctl.js`, `handml.js`, `handtrain.js`, `handui.js`)
- MediaPipe hand landmarker in the shared AI worker (GPU), One-Euro smoothing + forward prediction.
- Neon hand effects, air drawing, layers that ride the hand.
- Gesture → hotkey / macro / open program / scene. Custom poses taught by the user (kNN), teaching mode (F9).
- Hand-driven mouse / "control this PC" — only when armed; Ctrl+Shift+F12 disarms.

- Default poses: `app/renderer/data/default-hands.json` (author-taught built-in poses only) fills a profile on first start or when the only profile is empty; profile menu → “use the default basic poses” replaces the built-in pose samples, custom poses stay.

## Animation mode (`anim.js`, `anim-core.js`)
Clips per scene with keyframes (position, scale, stretch, rotation, opacity, colours, filters, crop, typewriter); auto-key; timeline + graph editor with bezier handles; 30+ easings incl. spring/elastic/bounce; presets; copy/paste/stretch/stagger; motion path. Many selected keys: one row per property (`50`, `+10`, `-=10`, `*1.5`, drag = same offset), time tools (to playhead, same time, space evenly). Several selected layers: property rows and presets (optional stagger) apply to all. Timeline layer rows drag into areas like the layer list. Graph view (`graphAll` / `drawGraph`): all selected layers' curves, colour per layer, dash per property, legend chips `L:<id>` / `P:<prop>` in `ed.gHide`, shared range per property, handle drag = same `cp` on all selected keys. Hand-driven clips: `drive.gest` (pose filter, `env.pair` for two-hand poses), `drive.grab` (relative scrub, `eng.grab`). Rows auto-open only with one layer selected. Triggers tab lists all hand-driven clips (`handClipsOverview`). Value tools `valueTool('same'|'avg'|'ramp'|'flip')` group selected keys by property, ordered by time then layer. Onion skin (`ed.onion`, saved) drawn on `#anim-ov` before the motion path. Triggers: hand gestures (incl. hold-to-play), hotkeys, scene start, other clips, timeline events, or follow the hand live.

## Dropdowns (`select.js`)
Every `<select>` gets a glass button + list; the hidden native select keeps the value (`select.value = …` is patched to refresh the button). Opt out with a `.gs-off` ancestor.

## Speed (`perf.js`, `perfui.js`)
- Click the fps number in the status bar → speed panel: light mode, automatic quality, "convert on the graphics chip" (takes effect on next start; off = old CPU canvas + RGBA path), live numbers (fps drawn / sent, drawing resolution, whole-PC CPU, ms for drawing / AI / hands / converting, GPU name), "copy details". `LITE` tag next to fps while light mode is on.
- Render scale: the scene canvas is `out × renderScale()` pixels (1 / 0.75 / 0.5); `draw()` sets the base transform `rs`, shadows and blur filters are multiplied by `rs`; code that reads the scene canvas (template thumbnails, layer peek) scales its source rect by `rs`. Snapshot / recording take the canvas as drawn (smaller in light mode).
- Settings in localStorage `prismcam.perf` {lite, auto, gpu}. First start + integrated GPU (WebGL renderer name) → light mode on with a toast.
- Frame rate (`#out-fps`, `setFps`, `out.fps` 30 | 60): tick worker gets `liveFps(out.fps)`; the draw clock (`tick` in `startStudio`) keeps a fixed schedule `due`; cameras via `camRate()` + `applySourceFps()` (also after undo / project load — `applyOut` compares `appliedFps`); `checkCamFps` warns once per camera when it gives < 50 fps; screen capture asks for `out.fps`; recording = one `requestFrame()` per draw, 12 Mbit/s at 60. Virtual camera always ≤ 30 (`vcam.last` gate in app.js).
- Test hooks: `stalltest` (fences never ready), `sentlog:<s>` (logs drawn / sent / busy / stall each second), `min`, `fps60` / `fps30`, `rec:<seconds>`, `codecs` (logs MediaRecorder support), `mime:<type>` (`+` for `,`), `lite` / `nolite`, `gpu` / `nogpu` (reloads), `perf` (opens the panel, logs `perf: …` after 8 s).

## Virtual camera (`vcam_host.rs` + `vcam/` DLL)
Windows 11 `MFCreateVirtualCamera`, no kernel driver. App writes NV12 frames to the memory-mapped file `%ProgramData%\PrismCam\frame.bin`; the DLL inside the Windows camera service reads it (1280×720 / 1920×1080 / 640×360 @ 30 fps). Idle frame when the app isn't sending. `tick.js` keeps frames flowing while minimised.

## Shell
Same as Prism Size: frameless glass window, TH/EN, appearance menu on the moon/sun button (Light/Dark + Glass/Classic; Classic = flat, still, no refraction), ⓘ About + GitHub updater (repo `Pangpond543/prism-cam`; packaged copies update from the release Setup.exe / Portable.zip, source checkouts rebuild with cargo). The app grants its own page camera/mic permission (no WebView2 prompt).

## Safety nets (2026-11-20)
- Saved files (`project.json`, `hands.json`): a file that can't be parsed is moved to `<name>.broken-<time>.json` (never deleted); the previous save `<name>.bak` is loaded and a toast says so. Every save keeps the previous one as `.bak` (`json_load` / `json_save`, main.rs).
- Camera unplugged → layer shows "Camera disconnected", `devicechange` reopens lost cameras by itself (`reopenCams`).
- Alt+F4 / taskbar close = same path as the ✕ button (save, release cameras, stop virtual camera); forced after 4 s.
- Changing the output size never restarts the virtual camera.
- K in animation mode keys every selected layer.
