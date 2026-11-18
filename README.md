# Prism Cam

**TH** — สตูดิโอกล้องสไตล์แก้วสำหรับ Windows 11: จัดกล้องเว็บแคม จับภาพหน้าจอ รูป วิดีโอ ข้อความ และสติกเกอร์ได้อิสระบนผืนผ้าใบ
ใส่เอฟเฟกต์ ลบ/เบลอพื้นหลังด้วย AI จับท่ามือ และทำแอนิเมชัน แล้วส่งภาพออกเป็นกล้องชื่อ **Prism Cam** ให้ Discord, Zoom, OBS หรือโปรแกรมไหนก็ได้

**EN** — A glass camera studio for Windows 11: arrange webcams, screen captures, images, videos, text and stickers freely on a canvas,
add effects, AI background removal / blur, hand tracking and animation, then send the result to Discord, Zoom, OBS or any app
as a camera named **Prism Cam**. Thai / English UI, light / dark mode.

## ดาวน์โหลด / Download

ไปที่หน้า **[Releases](../../releases/latest)** แล้วเลือกไฟล์ใดไฟล์หนึ่ง (Windows 11, 64-bit) /
Go to the **[Releases page](../../releases/latest)** and pick one:

| ไฟล์ / File | ใช้เมื่อ / For |
| --- | --- |
| `Prism-Cam-x.y.z-Setup.exe` | **แนะนำ** — ตัวติดตั้ง ดับเบิลคลิกแล้วกดถัดไป มีไอคอนบนเดสก์ท็อปและเมนู Start · **Recommended** — installer with desktop & Start-menu shortcuts |
| `Prism-Cam-x.y.z-Portable.zip` | ไม่ต้องติดตั้ง — แตกไฟล์ zip แล้วดับเบิลคลิก `prism-cam.exe` (เช่นใส่ USB) · No install — unzip and run `prism-cam.exe` |

> **Windows เตือน "ไม่ทราบผู้เผยแพร่" / SmartScreen warning** — โปรแกรมยังไม่ได้ลงลายเซ็นดิจิทัล กด **ข้อมูลเพิ่มเติม → เรียกใช้อยู่ดี**
> The app is not code-signed. Click **More info → Run anyway**.

**ครั้งแรกที่กด "เริ่มกล้องเสมือน"** Windows จะขอสิทธิ์ผู้ดูแลระบบหนึ่งครั้งเพื่อติดตั้งกล้อง Prism Cam จากนั้นเลือกกล้อง **Prism Cam** ใน Discord ได้เลย
**The first time you press "Start virtual camera"**, Windows asks for administrator permission once to register the camera.
Then pick the **Prism Cam** camera in Discord (or any app).

---

## ✋ ถ้าโปรแกรมทายท่ามือไม่ตรง — สอนมันด้วย F9 / If a hand pose is read wrong — teach it with F9

โปรแกรมมาพร้อม **ท่ามือพื้นฐานที่สอนไว้ให้แล้ว** (แบมือ กำมือ ชี้นิ้ว ชูสอง/สาม/สี่นิ้ว ยก/คว่ำนิ้วโป้ง โอเค จีบนิ้ว ร็อก รักเธอ โทรศัพท์ ตัว L
และท่าสองมือ 🫶 หัวใจ 🙏 พนมมือ) แต่มือแต่ละคนไม่เหมือนกัน ถ้าท่าไหนทายผิด ทำแบบนี้:

1. **เปิดชื่อท่ามือ** — ในแท็บ **มือ** เปิด **"โครงมือในพรีวิว"** (หรือกด **H** / ปุ่มรูปมือบนเวที) จะเห็นโครงมือ และ **ชื่อท่าที่โปรแกรมเห็น** ใต้มือ พร้อม % ความมั่นใจ
2. **ทำท่าที่ถูกต้องค้างไว้** หน้ากล้อง แล้วดูว่าชื่อที่ขึ้นตรงไหม
3. ถ้าไม่ตรง **กด `F9`** (หรือ `Ctrl+Shift+F9` ถ้ากำลังใช้โปรแกรมอื่นอยู่ เช่น Discord) แล้ว **เลือกท่าที่ถูก** — โปรแกรมจะจำมือคุณทันที
4. ทำซ้ำได้เรื่อยๆ ยิ่งกด F9 แก้บ่อย ยิ่งแม่น · อยากสอนใหม่ทั้งชุด: แท็บ **มือ → ปรับให้เข้ากับมือคุณ (ทีละขั้น)**

> 💡 ทำท่าค้างไว้ **ก่อน** กด F9 และขยับมือนิดหน่อย (ใกล้-ไกลกล้อง เอียงเล็กน้อย) ระหว่างที่โปรแกรมเก็บตัวอย่าง
> ต้องการกลับไปใช้ชุดเริ่มต้น: แท็บ **มือ → ปุ่มเมนูข้างชื่อโปรไฟล์ → ใช้ท่าพื้นฐานเริ่มต้น**

The app ships with **basic poses already taught**, but everyone's hands differ. If a pose is read wrong:

1. **Turn on pose names** — in the **Hand** tab switch on **"Hand skeleton in preview"** (or press **H** / the hand button on the stage).
   The name of the pose the app sees appears under your hand, with a % confidence.
2. **Hold the correct pose** in front of the camera.
3. If the name is wrong, **press `F9`** (or `Ctrl+Shift+F9` while another app such as Discord is in front) and **pick the right pose** — it learns your hand right away.
4. Repeat as often as you like; every fix makes it more accurate. To re-teach everything: **Hand → Fit to your hands (step by step)**.
   To go back to the shipped set: **Hand → menu button next to the profile name → Use the default basic poses**.

---

## ความสามารถ / Features
- แหล่งภาพ: เว็บแคม หน้าจอ/หน้าต่าง รูป (ไฟล์ ลากวาง Ctrl+V) วิดีโอ ข้อความ สติกเกอร์ รูปทรง กรอบ · Sources: webcams, screen/window capture, images, videos, text, stickers, shapes, frames
- จัดวางอิสระ: ลาก ย่อขยาย หมุน ครอป แม่เหล็กจัดแนว ลำดับเลเยอร์ ล็อก/ซ่อน · Free transform, snapping, layer order, lock / hide
- ฟิลเตอร์สี มุมโค้ง ขอบ เงา โหมดผสม · Colour filters, corner radius, border, shadow, blend modes
- ฉากเขียว และ AI ลบ/เบลอพื้นหลัง (MediaPipe ทำงานในเครื่อง ไม่ต้องต่อเน็ต) · Chroma key and offline AI background removal / blur
- จับมือ: เอฟเฟกต์นีออน วาดกลางอากาศ ของติดมือ ท่ามือ → คีย์ลัด/มาโคร/เปิดโปรแกรม/สลับซีน ท่าของคุณเอง และเมาส์ด้วยมือ (`Ctrl+Shift+F12` หยุดควบคุมเครื่องทันที)
  · Hand tracking: neon effects, air drawing, layers that ride the hand, gesture → hotkey / macro / program / scene, your own poses, hand-driven mouse
- แอนิเมชัน: คีย์เฟรม ไทม์ไลน์ กราฟ easing 30+ แบบ เริ่มด้วยท่ามือ คีย์ลัด หรือตามมือแบบสด · Animation: keyframes, timeline, graph editor, 30+ easings, gesture / hotkey triggers, live hand-follow
- ซีน ย้อนกลับ/ทำซ้ำ ถ่ายภาพ (PNG) อัดวิดีโอ (WebM) · Scenes, undo / redo, snapshot, recording
- กล้องเสมือนผ่าน Windows 11 virtual camera API (ไม่ต้องลงไดรเวอร์) · Virtual camera via the Windows 11 API (no kernel driver)

## อัปเดต / Updating
กดปุ่ม **ⓘ** บนแถบหัวหน้าต่าง → **ตรวจหาอัปเดต** → **อัปเดตเลย** → **เริ่มโปรแกรมใหม่**
(ตัวติดตั้งจะดาวน์โหลด Setup ใหม่แล้วติดตั้งให้เอง · แบบพกพาจะแทนไฟล์ในโฟลเดอร์เดิม) ท่ามือและงานที่บันทึกไว้ยังอยู่ครบ
Click **ⓘ** in the title bar → **Check for updates** → **Update now** → **Restart**. Your poses and projects are kept.

## ข้อมูลของคุณ / Your data
งาน ท่ามือ และวิดีโอที่นำเข้าเก็บไว้ที่ `%APPDATA%\com.prism.cam` (ไม่ถูกลบตอนถอนการติดตั้ง)
Projects, hand profiles and imported videos live in `%APPDATA%\com.prism.cam` (kept when you uninstall).

## สร้างจากซอร์สโค้ด / Build from source
ต้องมี Rust (GNU toolchain) + WinLibs MinGW และ NSIS 3 · Requires Rust (GNU toolchain) + WinLibs MinGW, and NSIS 3.

```bash
cargo build --release --workspace --manifest-path app/src-tauri/Cargo.toml   # → prism-cam.exe + prism_vcam.dll
tools/release.sh                                                            # → Prism-Cam-<ver>-Setup.exe + -Portable.zip
npm run web                                                                 # preview the UI in a browser (no virtual camera)
```

Layout: `app/renderer` — studio UI (HTML / CSS / JS, no bundler) · `app/src-tauri` — Tauri 2 shell in Rust (window, files,
updater, virtual-camera host) · `app/src-tauri/vcam` — `prism_vcam.dll`, the Media Foundation camera source loaded by Windows.

## เครดิต / Credits & licences
- [MediaPipe](https://github.com/google-ai-edge/mediapipe) hand landmarker & selfie segmenter — Apache License 2.0
- Fonts: Anuphan, IBM Plex Sans Thai, Kanit, Noto Sans Thai, Prompt — SIL Open Font License 1.1
- [Tauri](https://tauri.app) — MIT / Apache 2.0 · WebView2Loader.dll — Microsoft, redistributable

Prism Cam is released under the [MIT License](LICENSE).
