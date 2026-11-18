// Hand control: turns gestures recognised in the studio into real mouse / keyboard input (SendInput).
// Nothing here runs unless the user armed "control this PC" in the Hand tab. Ctrl+Shift+F12 disarms from anywhere,
// and moving the real mouse always wins over the hand pointer.
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use windows::core::{w, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Controls::Dialogs::{GetOpenFileNameW, OFN_EXPLORER, OFN_FILEMUSTEXIST, OFN_NOCHANGEDIR, OPENFILENAMEW};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{CallNextHookEx, DispatchMessageW, GetCursorPos, GetMessageW, GetSystemMetrics, SetWindowsHookExW, TranslateMessage, MSG, MSLLHOOKSTRUCT, SM_CXSCREEN, SM_CYSCREEN, SW_SHOWNORMAL, WH_MOUSE_LL, WM_MOUSEMOVE};

static ARMED: AtomicBool = AtomicBool::new(false);
static APP: OnceLock<AppHandle> = OnceLock::new();
static HELD: Mutex<Vec<u16>> = Mutex::new(Vec::new()); // keys held down by a "hold" binding
static BUTTONS: Mutex<[bool; 3]> = Mutex::new([false; 3]); // left, right, middle held down
struct Ptr { on: bool, tx: f64, ty: f64, cx: f64, cy: f64, primed: bool, glide: f64, upd: Option<Instant>, yielding: bool, seen_real: u64, anchor: (f64, f64) }
static PTR: Mutex<Ptr> = Mutex::new(Ptr { on: false, tx: 0.5, ty: 0.5, cx: 0.5, cy: 0.5, primed: false, glide: 28.0, upd: None, yielding: false, seen_real: 0, anchor: (0.5, 0.5) });
static START: OnceLock<Instant> = OnceLock::new();
static REAL_MS: AtomicU64 = AtomicU64::new(0); // last time the REAL mouse moved (ms since START)
static HOOKED: AtomicBool = AtomicBool::new(false);
static FIX_KEY: AtomicBool = AtomicBool::new(false);
fn now_ms() -> u64 { START.get_or_init(Instant::now).elapsed().as_millis() as u64 }


/* -------------------------------------------------------------- key names */
pub fn vk_of(name: &str) -> Option<(u16, bool)> { // → (virtual key, needs Shift)
    let n = name.trim().to_lowercase();
    let vk = match n.as_str() {
        "ctrl" | "control" => 0x11, "shift" => 0x10, "alt" => 0x12, "win" | "meta" | "super" | "cmd" => 0x5B,
        "enter" | "return" => 0x0D, "esc" | "escape" => 0x1B, "space" | "spacebar" => 0x20, "tab" => 0x09, "backspace" => 0x08,
        "delete" | "del" => 0x2E, "insert" | "ins" => 0x2D, "home" => 0x24, "end" => 0x23, "pageup" | "pgup" => 0x21, "pagedown" | "pgdn" => 0x22,
        "left" => 0x25, "up" => 0x26, "right" => 0x27, "down" => 0x28, "printscreen" | "prtsc" => 0x2C, "capslock" => 0x14, "pause" => 0x13,
        "plus" => 0xBB, "minus" => 0xBD, "comma" => 0xBC, "period" => 0xBE,
        "volumemute" | "mute" => 0xAD, "volumedown" | "voldown" => 0xAE, "volumeup" | "volup" => 0xAF,
        "medianext" | "next" => 0xB0, "mediaprev" | "prev" => 0xB1, "mediastop" => 0xB2, "mediaplaypause" | "playpause" => 0xB3,
        _ => 0,
    };
    if vk != 0 { return Some((vk, false)); }
    if let Some(d) = n.strip_prefix("numpad") { if let Ok(v) = d.parse::<u16>() { if v <= 9 { return Some((0x60 + v, false)); } } }
    if let Some(d) = n.strip_prefix('f') { if let Ok(v) = d.parse::<u16>() { if (1..=24).contains(&v) { return Some((0x6F + v, false)); } } }
    let mut it = n.chars();
    let (c, rest) = (it.next()?, it.next());
    if rest.is_some() { return None; }
    if c.is_ascii_alphanumeric() { return Some((c.to_ascii_uppercase() as u16, false)); }
    let mut buf = [0u16; 2];
    let r = unsafe { VkKeyScanW(c.encode_utf16(&mut buf)[0]) };
    if r == -1 { None } else { Some(((r & 0xFF) as u16, (r >> 8) & 1 == 1)) }
}
/// "ctrl+shift+a" → virtual keys in press order
pub fn combo(s: &str) -> Option<Vec<u16>> {
    let mut out = Vec::new();
    for part in s.split('+').map(|p| p.trim()).filter(|p| !p.is_empty()) {
        let (vk, shift) = vk_of(part)?;
        if shift && !out.contains(&0x10) { out.push(0x10); }
        if !out.contains(&vk) { out.push(vk); }
    }
    if out.is_empty() { None } else { Some(out) }
}

/* -------------------------------------------------------------- SendInput */
fn key(vk: u16, up: bool) {
    let ext = matches!(vk, 0x21..=0x28 | 0x2D | 0x2E | 0x5B | 0x5C);
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if up { flags |= KEYEVENTF_KEYUP; }
    if ext { flags |= KEYEVENTF_EXTENDEDKEY; }
    let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
    let inp = INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
    unsafe { SendInput(&[inp], std::mem::size_of::<INPUT>() as i32); }
}
fn unicode(unit: u16) {
    for up in [false, true] {
        let flags = if up { KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } else { KEYEVENTF_UNICODE };
        let inp = INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: unit, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
        unsafe { SendInput(&[inp], std::mem::size_of::<INPUT>() as i32); }
    }
}
fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) {
    let inp = INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
    unsafe { SendInput(&[inp], std::mem::size_of::<INPUT>() as i32); }
}
fn button(name: &str, down: bool) {
    let (i, d, u) = match name { "right" => (1, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP), "middle" => (2, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP), _ => (0, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP) };
    let mut b = BUTTONS.lock().unwrap();
    if b[i] == down { return; }
    b[i] = down;
    mouse(if down { d } else { u }, 0, 0, 0);
}
fn keys_down(vks: &[u16]) { let mut h = HELD.lock().unwrap(); for &v in vks { if !h.contains(&v) { h.push(v); key(v, false); } } }
fn keys_up(vks: &[u16]) { let mut h = HELD.lock().unwrap(); for &v in vks.iter().rev() { if let Some(i) = h.iter().position(|x| *x == v) { h.remove(i); key(v, true); } } }
/// let go of everything the hand is holding (called when disarmed and when the app closes)
pub fn release_all() {
    let held: Vec<u16> = std::mem::take(&mut *HELD.lock().unwrap());
    for v in held.into_iter().rev() { key(v, true); }
    for n in ["left", "right", "middle"] { button(n, false); }
    PTR.lock().unwrap().on = false;
}
fn disarm() { ARMED.store(false, Ordering::SeqCst); release_all(); }

/* ------------------------------------------------- real mouse detection */
// A low-level mouse hook sees every move with a flag telling injected (ours) from real (a person on the mouse),
// so the hand pointer can step aside the moment someone touches the real mouse — no guessing from the cursor position.
unsafe extern "system" fn ll_mouse(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code >= 0 && wp.0 as u32 == WM_MOUSEMOVE {
        let info = &*(lp.0 as *const MSLLHOOKSTRUCT);
        if info.flags & 1 == 0 { REAL_MS.store(now_ms().max(1), Ordering::Relaxed); } // LLMHF_INJECTED = 1
    }
    CallNextHookEx(None, code, wp, lp)
}
fn hook_thread() {
    unsafe {
        let hmod = GetModuleHandleW(None).ok().map(|m| HINSTANCE(m.0));
        if SetWindowsHookExW(WH_MOUSE_LL, Some(ll_mouse), hmod, 0).is_err() { HOOKED.store(false, Ordering::SeqCst); return; }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() { let _ = TranslateMessage(&msg); DispatchMessageW(&msg); }
    }
}

/* ---------------------------------------------------------------- pointer */
// The studio reports where the hand points ~30 times a second; this thread glides the real cursor towards that
// target every few milliseconds so it moves like a mouse instead of stepping.
// Safety rules: no report for 250 ms (hand gone, studio busy) → the hand lets go of the cursor and its buttons;
// the real mouse moved → the hand stays out of the way until it clearly moves again.
fn pointer_loop() {
    let mut t0 = Instant::now();
    loop {
        let armed = ARMED.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(if armed && PTR.lock().unwrap().on { 4 } else { 25 }));
        let dt = t0.elapsed().as_secs_f64(); t0 = Instant::now();
        let dn = |vk: u16| unsafe { GetAsyncKeyState(vk as i32) } as u16 & 0x8000 != 0;
        // Ctrl + Shift + F9 from any app: "the gesture I'm making was read wrong" → Prism Cam asks which one it is
        let fix = dn(0x11) && dn(0x10) && dn(0x78);
        if fix && !FIX_KEY.swap(true, Ordering::SeqCst) {
            if let Some(app) = APP.get() {
                if let Some(w) = app.get_webview_window("main") { let _ = w.unminimize(); let _ = w.set_focus(); }
                let _ = app.emit("hand:fix", json!({}));
            }
        } else if !fix { FIX_KEY.store(false, Ordering::SeqCst); }
        if !armed { continue; }
        if dn(0x11) && dn(0x10) && dn(0x7B) { // Ctrl + Shift + F12
            disarm();
            if let Some(app) = APP.get() { let _ = app.emit("input:panic", json!({})); }
            continue;
        }
        let mut p = PTR.lock().unwrap();
        if p.on && p.upd.map_or(true, |t| t.elapsed() > Duration::from_millis(250)) {
            p.on = false; p.primed = false; drop(p);
            for n in ["left", "right", "middle"] { button(n, false); }
            continue;
        }
        if !p.on { p.primed = false; continue; }
        let real = REAL_MS.load(Ordering::Relaxed);
        if real > p.seen_real { p.seen_real = real; p.yielding = true; p.anchor = (p.tx, p.ty); p.primed = false; }
        if p.yielding {
            let moved = ((p.tx - p.anchor.0).powi(2) + (p.ty - p.anchor.1).powi(2)).sqrt();
            if now_ms().saturating_sub(real) > 350 && moved > 0.05 { p.yielding = false; } else { continue; }
        }
        let (sw, sh) = unsafe { (GetSystemMetrics(SM_CXSCREEN).max(1) as f64, GetSystemMetrics(SM_CYSCREEN).max(1) as f64) };
        if !p.primed {
            let mut pt = POINT::default();
            if unsafe { GetCursorPos(&mut pt) }.is_err() { continue; }
            p.cx = pt.x as f64 / sw; p.cy = pt.y as f64 / sh; p.primed = true;
        }
        let k = 1.0 - (-dt / (p.glide.max(1.0) / 1000.0)).exp();
        let (ox, oy) = ((p.cx * sw).round(), (p.cy * sh).round());
        p.cx += (p.tx - p.cx) * k; p.cy += (p.ty - p.cy) * k;
        if (p.cx * sw).round() == ox && (p.cy * sh).round() == oy { continue; }
        mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, (p.cx * 65535.0) as i32, (p.cy * 65535.0) as i32, 0);
    }
}
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    START.get_or_init(Instant::now);
    std::thread::spawn(pointer_loop);
}

/* --------------------------------------------------------------- commands */
#[tauri::command]
pub fn input_arm(a: bool) -> Value {
    if a {
        if !HOOKED.swap(true, Ordering::SeqCst) { std::thread::spawn(hook_thread); }
        ARMED.store(true, Ordering::SeqCst);
    } else { disarm(); }
    json!({ "ok": true, "armed": a })
}
#[derive(Deserialize)]
pub struct PointerArgs { on: bool, #[serde(default)] x: f64, #[serde(default)] y: f64, #[serde(default)] glide: f64 }
#[tauri::command]
pub fn input_pointer(a: PointerArgs) {
    let mut p = PTR.lock().unwrap();
    let on = a.on && ARMED.load(Ordering::SeqCst);
    if on && !p.on { p.seen_real = REAL_MS.load(Ordering::Relaxed); p.yielding = false; p.primed = false; } // a fresh start never inherits an old "real mouse moved"
    if !on && p.on { drop(p); for n in ["left", "right", "middle"] { button(n, false); } p = PTR.lock().unwrap(); }
    p.on = on;
    if on { p.tx = a.x.clamp(0.0, 1.0); p.ty = a.y.clamp(0.0, 1.0); p.upd = Some(Instant::now()); if a.glide > 0.0 { p.glide = a.glide; } }
}
#[derive(Deserialize)]
pub struct Step { k: String, #[serde(default)] v: String, #[serde(default)] n: f64, #[serde(default)] a: String }
/// keys · down · up · text · wait · click · mdown · mup · scroll · hscroll · open
#[tauri::command(async)]
pub fn input_run(a: Vec<Step>) -> Value {
    let mut waited = 0.0;
    for s in a.iter().take(200) {
        if !ARMED.load(Ordering::SeqCst) { return json!({ "ok": false, "reason": "disarmed" }); }
        match s.k.as_str() {
            "keys" => { let Some(c) = combo(&s.v) else { return json!({ "ok": false, "reason": "key", "detail": s.v }) };
                for &v in &c { key(v, false); } std::thread::sleep(Duration::from_millis(18)); for &v in c.iter().rev() { key(v, true); } }
            "down" => { let Some(c) = combo(&s.v) else { return json!({ "ok": false, "reason": "key", "detail": s.v }) }; keys_down(&c); }
            "up" => { let Some(c) = combo(&s.v) else { return json!({ "ok": false, "reason": "key", "detail": s.v }) }; keys_up(&c); }
            "text" => for ch in s.v.chars().take(2000) {
                if ch == '\n' { key(0x0D, false); key(0x0D, true); } else { let mut b = [0u16; 2]; for u in ch.encode_utf16(&mut b) { unicode(*u); } }
                std::thread::sleep(Duration::from_millis(2));
            },
            "wait" => { let ms = s.n.clamp(0.0, 10_000.0); waited += ms; if waited > 30_000.0 { break; } std::thread::sleep(Duration::from_millis(ms as u64)); }
            "click" => { let n = if s.v == "double" { 2 } else { 1 }; let b = if s.v == "double" { "left" } else { s.v.as_str() };
                for i in 0..n { button(b, true); std::thread::sleep(Duration::from_millis(14)); button(b, false); if i + 1 < n { std::thread::sleep(Duration::from_millis(60)); } } }
            "mdown" => button(&s.v, true),
            "mup" => button(&s.v, false),
            "scroll" => mouse(MOUSEEVENTF_WHEEL, 0, 0, (s.n * 120.0) as i32),
            "hscroll" => mouse(MOUSEEVENTF_HWHEEL, 0, 0, (s.n * 120.0) as i32),
            "open" => {
                if s.v.trim().is_empty() { continue; }
                let (file, args) = (HSTRING::from(s.v.trim()), HSTRING::from(s.a.as_str()));
                let r = unsafe { ShellExecuteW(None, w!("open"), &file, if s.a.is_empty() { PCWSTR::null() } else { PCWSTR(args.as_ptr()) }, PCWSTR::null(), SW_SHOWNORMAL) };
                if r.0 as usize <= 32 { return json!({ "ok": false, "reason": "open", "detail": s.v }); }
            }
            _ => {}
        }
    }
    json!({ "ok": true })
}
/// native "choose a program / file" dialog for the "open program" action
#[tauri::command(async)]
pub fn input_pick() -> Value {
    let mut buf = [0u16; 1024];
    let mut o = OPENFILENAMEW { lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32, lpstrFile: PWSTR(buf.as_mut_ptr()), nMaxFile: buf.len() as u32, Flags: OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_NOCHANGEDIR, ..Default::default() };
    if unsafe { GetOpenFileNameW(&mut o) }.as_bool() {
        let len = buf.iter().position(|c| *c == 0).unwrap_or(0);
        json!({ "ok": true, "path": String::from_utf16_lossy(&buf[..len]) })
    } else { json!({ "ok": false }) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_combos() {
        assert_eq!(combo("ctrl+shift+a"), Some(vec![0x11, 0x10, 0x41]));
        assert_eq!(combo("Alt + F4"), Some(vec![0x12, 0x73]));
        assert_eq!(combo("win+d"), Some(vec![0x5B, 0x44]));
        assert_eq!(combo("volumeup"), Some(vec![0xAF]));
        assert_eq!(combo("ctrl+nope"), None);
        assert_eq!(combo(""), None);
    }
}
