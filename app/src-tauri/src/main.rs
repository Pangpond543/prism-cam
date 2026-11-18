// Prism Cam — Tauri shell. The renderer (app/renderer) is the studio; this side owns the window, files,
// the GitHub updater and the virtual camera. Command names mirror the Prism Size IPC channels ("win:min" → win_min).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(non_snake_case)]

mod input;
mod update;
mod vcam_host;

use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const PKG_NAME: &str = "prism-cam-studio"; // app/package.json "name" — the updater refuses anything else

/// Folder that holds prism.config.json / package.json (next to the exe when packaged, the source `app/` otherwise).
fn app_dir() -> PathBuf {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())).unwrap_or_default();
    if exe_dir.join("prism.config.json").exists() { return exe_dir; }
    if let Some(up) = exe_dir.parent() { if up.join("prism.config.json").exists() { return up.to_path_buf(); } } // app/bin/prism-cam.exe
    let src = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().map(|p| p.to_path_buf()).unwrap_or_default();
    if src.join("prism.config.json").exists() { src } else { exe_dir }
}
fn repo() -> String {
    let cfg: Value = std::fs::read_to_string(app_dir().join("prism.config.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    let r = cfg["repo"].as_str().unwrap_or("").trim();
    let r = r.trim_start_matches("https://github.com/").trim_end_matches(".git").trim_matches('/');
    if update::valid_repo(r) { r.to_string() } else { String::new() }
}

/* --------------------------------------------------------------- diagnostics */
fn log_path() -> PathBuf { PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join("com.prism.cam").join("prism.log") }
fn log_line(s: &str) {
    use std::io::Write;
    let p = log_path();
    if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
    if std::fs::metadata(&p).map(|m| m.len() > 200_000).unwrap_or(false) { let _ = std::fs::remove_file(&p); }
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) { let _ = writeln!(f, "[{t}] {s}"); }
}
#[tauri::command]
fn app_log(a: String) { log_line(&a.chars().take(400).collect::<String>()); }

/* ------------------------------------------------------------------ window */
#[tauri::command]
fn win_min(window: WebviewWindow) { let _ = window.minimize(); }
#[tauri::command]
fn win_max(window: WebviewWindow) { let _ = if window.is_maximized().unwrap_or(false) { window.unmaximize() } else { window.maximize() }; }
#[tauri::command]
fn win_close(app: AppHandle) { input::release_all(); vcam_host::stop(); app.exit(0); }
#[tauri::command]
fn app_ready(window: WebviewWindow) { let _ = window.show(); let _ = window.set_focus(); }
#[tauri::command]
fn app_relaunch(app: AppHandle) {
    vcam_host::stop();
    // installed copy after an update: hand over to the new installer (silent; it starts Prism Cam again when done)
    if let Some(setup) = PENDING_SETUP.lock().ok().and_then(|mut p| p.take()) {
        if setup.exists() && std::process::Command::new(&setup).arg("/S").arg("/RELAUNCH").spawn().is_ok() { input::release_all(); app.exit(0); return; }
    }
    app.restart();
}
static PENDING_SETUP: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);
fn exe_dir() -> PathBuf { std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())).unwrap_or_default() }

/* ------------------------------------------------------------ about/update */
#[tauri::command]
fn about_info() -> Value { json!({ "version": env!("CARGO_PKG_VERSION"), "repo": repo(), "tauri": tauri::VERSION, "vcam": vcam_host::is_installed(), "test": std::env::var("PRISM_ACT").unwrap_or_default() }) }
#[tauri::command]
fn about_openRepo() {
    let r = repo();
    if !r.is_empty() { let _ = std::process::Command::new("explorer").arg(format!("https://github.com/{r}")).spawn(); }
}
#[tauri::command(async)]
fn update_check() -> Value { update::check(&repo(), env!("CARGO_PKG_VERSION")) }
#[tauri::command(async)]
fn update_apply(app: AppHandle) -> Value {
    let c = update::check(&repo(), env!("CARGO_PKG_VERSION"));
    if c["ok"] != true { return c; }
    if c["hasUpdate"] != true { return json!({ "ok": false, "reason": "uptodate" }); }
    vcam_host::stop();
    if !app_dir().join("src-tauri").exists() { // packaged (installer / portable): use the files on the GitHub release
        let (r, setup) = update::apply_release(&c, &exe_dir(), &|step| { let _ = app.emit("update:step", json!({ "step": step, "f": 0 })); });
        if let (Some(s), Ok(mut p)) = (setup, PENDING_SETUP.lock()) { *p = Some(s); }
        log_line(&format!("UPDATE kind={} result={}", update::packaged_kind(&exe_dir()), r));
        return r;
    }
    update::apply(c["zip"].as_str().unwrap_or(""), &app_dir(), PKG_NAME, &|step| { let _ = app.emit("update:step", json!({ "step": step, "f": 0 })); })
}

/* ------------------------------------------------------------------ project */
fn data_dir(app: &AppHandle) -> PathBuf { app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("PrismCam")) }
#[tauri::command(async)]
fn project_load(app: AppHandle) -> Value {
    match std::fs::read_to_string(data_dir(&app).join("project.json")) { Ok(data) => json!({ "ok": true, "data": data }), Err(_) => json!({ "ok": false }) }
}
#[tauri::command(async)]
fn project_save(app: AppHandle, a: String) -> Value {
    let dir = data_dir(&app);
    let tmp = dir.join("project.json.tmp");
    let ok = std::fs::create_dir_all(&dir).is_ok() && std::fs::write(&tmp, a).is_ok() && std::fs::rename(&tmp, dir.join("project.json")).is_ok();
    json!({ "ok": ok })
}

/* ------------------------------------------------------------- hand profiles */
// the user's taught gestures live next to the project but apart from it: they belong to the person, not the scene
#[tauri::command(async)]
fn hand_load(app: AppHandle) -> Value {
    match std::fs::read_to_string(data_dir(&app).join("hands.json")) { Ok(data) => json!({ "ok": true, "data": data }), Err(_) => json!({ "ok": false }) }
}
#[tauri::command(async)]
fn hand_save(app: AppHandle, a: String) -> Value {
    let dir = data_dir(&app);
    let tmp = dir.join("hands.json.tmp");
    let ok = std::fs::create_dir_all(&dir).is_ok() && std::fs::write(&tmp, a).is_ok() && std::fs::rename(&tmp, dir.join("hands.json")).is_ok();
    json!({ "ok": ok })
}
#[tauri::command(async)]
fn hand_export(app: AppHandle, a: Value) -> Value {
    let name: String = a["name"].as_str().unwrap_or("").chars().filter(|c| c.is_alphanumeric() || " -_".contains(*c)).take(40).collect();
    let name = if name.trim().is_empty() { "hand-profile".to_string() } else { name.trim().to_string() };
    let dir = app.path().document_dir().unwrap_or_else(|_| data_dir(&app)).join("Prism Cam");
    let path = dir.join(format!("{name}.prismhand.json"));
    let ok = std::fs::create_dir_all(&dir).is_ok() && std::fs::write(&path, a["data"].as_str().unwrap_or("")).is_ok();
    json!({ "ok": ok, "path": path.to_string_lossy() })
}

/* -------------------------------------------------------------------- media */
fn header<'a>(req: &'a Request<'_>, name: &str) -> &'a str { req.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("") }
#[tauri::command(async)]
fn media_save(app: AppHandle, request: Request<'_>) -> Value {
    let InvokeBody::Raw(bytes) = request.body() else { return json!({ "ok": false }) };
    let name: String = header(&request, "x-name").chars().filter(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c)).collect();
    if name.is_empty() || name.starts_with('.') { return json!({ "ok": false }); }
    let base = if name.ends_with(".png") { app.path().picture_dir() } else { app.path().video_dir() };
    let dir = base.unwrap_or_else(|_| data_dir(&app)).join("Prism Cam");
    let path = dir.join(&name);
    let ok = std::fs::create_dir_all(&dir).is_ok() && std::fs::write(&path, bytes).is_ok();
    json!({ "ok": ok, "path": path.to_string_lossy() })
}
#[tauri::command]
fn media_reveal(a: String) {
    let p = PathBuf::from(&a);
    if p.is_file() { let _ = std::process::Command::new("explorer").arg("/select,").arg(p).creation_flags(0).spawn(); }
}

/* ------------------------------------------------------------ saved videos */
// imported video files are copied into <data>/media so they come back after a restart (images live inside project.json)
fn media_dir(app: &AppHandle) -> PathBuf { data_dir(app).join("media") }
fn media_name(s: &str) -> String { s.chars().filter(|c| c.is_ascii_alphanumeric() || "-_.".contains(*c)).take(64).collect() }
#[tauri::command(async)]
fn media_put(app: AppHandle, request: Request<'_>) -> Value {
    let InvokeBody::Raw(bytes) = request.body() else { return json!({ "ok": false }) };
    let name = media_name(header(&request, "x-name"));
    if name.is_empty() || name.starts_with('.') { return json!({ "ok": false }); }
    let off: u64 = header(&request, "x-off").parse().unwrap_or(0);
    let dir = media_dir(&app);
    if std::fs::create_dir_all(&dir).is_err() { return json!({ "ok": false }); }
    use std::io::Write;
    let f = if off == 0 { std::fs::File::create(dir.join(&name)) } else { std::fs::OpenOptions::new().append(true).open(dir.join(&name)) };
    let ok = f.and_then(|mut f| f.write_all(bytes)).is_ok();
    json!({ "ok": ok })
}
#[tauri::command(async)]
fn media_has(app: AppHandle, a: String) -> Value { json!({ "ok": media_dir(&app).join(media_name(&a)).is_file() }) }
// keep only the files the project still uses
#[tauri::command(async)]
fn media_gc(app: AppHandle, a: Vec<String>) -> Value {
    let keep: std::collections::HashSet<String> = a.iter().map(|s| media_name(s)).collect();
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(media_dir(&app)) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if e.path().is_file() && !keep.contains(&name) && std::fs::remove_file(e.path()).is_ok() { n += 1; }
        }
    }
    json!({ "ok": true, "removed": n })
}
// http://pmedia.localhost/<name>: streams a saved video with byte ranges, so seeking and looping never load the whole file
fn serve_media(app: &AppHandle, req: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    use tauri::http::{Response, StatusCode};
    let fail = |c: StatusCode| Response::builder().status(c).header("Access-Control-Allow-Origin", "*").body(Vec::new()).unwrap();
    let name = media_name(req.uri().path().trim_start_matches('/'));
    if name.is_empty() { return fail(StatusCode::NOT_FOUND); }
    let Ok(mut f) = std::fs::File::open(media_dir(app).join(&name)) else { return fail(StatusCode::NOT_FOUND) };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let mime = match ext.as_str() { "webm" => "video/webm", "mov" => "video/quicktime", "mkv" => "video/x-matroska", "ogv" | "ogg" => "video/ogg", "gif" => "image/gif", _ => "video/mp4" };
    const CHUNK: u64 = 4 << 20;
    let range = req.headers().get("range").and_then(|v| v.to_str().ok()).and_then(|r| r.strip_prefix("bytes=")).map(|r| {
        let mut it = r.splitn(2, '-');
        (it.next().unwrap_or("").trim().parse::<u64>().ok(), it.next().unwrap_or("").trim().parse::<u64>().ok())
    });
    let (start, end, partial) = match range {
        Some((Some(s), e)) => (s, e.unwrap_or(u64::MAX).min(s.saturating_add(CHUNK - 1)).min(len.saturating_sub(1)), true),
        Some((None, Some(n))) => (len.saturating_sub(n), len.saturating_sub(1), true),
        _ => (0, len.saturating_sub(1).min(CHUNK - 1), len > CHUNK),
    };
    if len == 0 || start >= len { return Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE).header("Content-Range", format!("bytes */{len}")).header("Access-Control-Allow-Origin", "*").body(Vec::new()).unwrap(); }
    let mut buf = vec![0u8; (end - start + 1) as usize];
    if f.seek(SeekFrom::Start(start)).is_err() || f.read_exact(&mut buf).is_err() { return fail(StatusCode::INTERNAL_SERVER_ERROR); }
    let b = Response::builder()
        .header("Content-Type", mime).header("Accept-Ranges", "bytes").header("Content-Length", buf.len().to_string())
        .header("Access-Control-Allow-Origin", "*").header("Cache-Control", "no-cache");
    if partial { b.status(StatusCode::PARTIAL_CONTENT).header("Content-Range", format!("bytes {start}-{end}/{len}")).body(buf).unwrap() } else { b.status(StatusCode::OK).body(buf).unwrap() }
}

/* ----------------------------------------------------------- virtual camera */
#[tauri::command(async)]
fn vcam_start(_a: Value) -> Value { vcam_host::start() }
#[tauri::command(async)]
fn vcam_stop() -> Value { vcam_host::stop(); json!({ "ok": true }) }
#[tauri::command(async)]
fn vcam_install() -> Value { vcam_host::install() }
#[tauri::command(async)]
fn vcam_frame(request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err("body".into()) };
    let (w, h) = (header(&request, "x-w").parse().unwrap_or(0usize), header(&request, "x-h").parse().unwrap_or(0usize));
    let ok = if header(&request, "x-fmt") == "nv12" { vcam_host::push_nv12(bytes, w, h) } else { vcam_host::push(bytes, w, h) };
    if ok { Ok(()) } else { Err("frame".into()) }
}
/// whole-PC CPU use in % since the previous call (the speed panel and auto quality ask once a second)
#[tauri::command]
fn perf_cpu() -> i32 {
    use std::sync::Mutex;
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::GetSystemTimes;
    static LAST: Mutex<(u64, u64)> = Mutex::new((0, 0));
    let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    if unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }.is_err() { return -1; }
    let v = |f: FILETIME| ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64;
    let (idle, total) = (v(idle), v(kernel) + v(user)); // kernel time includes idle time
    let mut last = LAST.lock().unwrap();
    let (di, dt) = (idle.wrapping_sub(last.0), total.wrapping_sub(last.1));
    let first = last.1 == 0;
    *last = (idle, total);
    if first || dt == 0 { return -1; }
    (100.0 * (dt.saturating_sub(di)) as f64 / dt as f64).round().clamp(0.0, 100.0) as i32
}

fn main() {
    if std::env::args().any(|a| a == "--install-vcam") { std::process::exit(vcam_host::install_elevated()); }
    {
        let exe = std::env::current_exe().unwrap_or_default();
        let mt = std::fs::metadata(&exe).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
        update::clean_old(&exe_dir());
        log_line(&format!("START exe={} exe_mtime={} env_args={:?} act={:?}", exe.display(), mt, std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").ok(), std::env::var("PRISM_ACT").ok()));
    }
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            win_min, win_max, app_log, win_close, app_ready, app_relaunch, about_info, about_openRepo, update_check, update_apply,
            project_load, project_save, media_save, media_reveal, media_put, media_has, media_gc, vcam_start, vcam_stop, vcam_install, vcam_frame, perf_cpu,
            input::input_arm, input::input_pointer, input::input_run, input::input_pick, hand_load, hand_save, hand_export
        ])
        .register_asynchronous_uri_scheme_protocol("pmedia", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || responder.respond(serve_media(&app, &req)));
        })
        .setup(|app| {
            input::init(app.handle());
            // Prism Cam is a camera app: grant its own page camera / microphone access instead of showing the WebView2 prompt
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.with_webview(|wv| unsafe {
                    use webview2_com::Microsoft::Web::WebView2::Win32::*;
                    if let Ok(core) = wv.controller().CoreWebView2() {
                        let mut token = Default::default();
                        let handler = webview2_com::PermissionRequestedEventHandler::create(Box::new(|_, args| {
                            let Some(args) = args else { return Ok(()) };
                            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                            args.PermissionKind(&mut kind)?;
                            if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA || kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                            }
                            Ok(())
                        }));
                        let _ = core.add_PermissionRequested(&handler, &mut token);
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|_w, e| { if let tauri::WindowEvent::Destroyed = e { input::release_all(); vcam_host::stop(); } })
        .run(tauri::generate_context!())
        .expect("error while running Prism Cam");
}
