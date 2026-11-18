// App side of the virtual camera: registers the camera with Windows 11 (MFCreateVirtualCamera) and feeds it frames
// through a memory-mapped file that prism_vcam.dll reads inside the Windows camera service.
use serde_json::{json, Value};
use std::ffi::c_void;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use windows::core::{w, Interface, GUID, HRESULT, HSTRING, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Media::MediaFoundation::{IMFVirtualCamera, MFStartup, MFSTARTUP_FULL};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::System::Memory::{CreateFileMappingW, MapViewOfFile, UnmapViewOfFile, FILE_MAP_WRITE, MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE};
use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};

include!("shared.rs");
const NO_WINDOW: u32 = 0x0800_0000;
const DLL: &str = "prism_vcam.dll";

struct Host { cam: Option<IMFVirtualCamera>, file: Option<std::fs::File>, hmap: HANDLE, view: *mut u8, seq: u32 }
unsafe impl Send for Host {}
static HOST: Mutex<Host> = Mutex::new(Host { cam: None, file: None, hmap: HANDLE(std::ptr::null_mut()), view: std::ptr::null_mut(), seq: 0 });

fn exe_dir() -> PathBuf { std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())).unwrap_or_default() }
fn bundled_dll() -> PathBuf { exe_dir().join(DLL) }
fn install_dir() -> PathBuf {
    PathBuf::from(std::env::var_os("ProgramW6432").or_else(|| std::env::var_os("ProgramFiles")).unwrap_or_else(|| "C:\\Program Files".into())).join("Prism Cam")
}
fn installed_dll() -> PathBuf { install_dir().join(DLL) }
fn same_file(a: &PathBuf, b: &PathBuf) -> bool {
    match (std::fs::read(a), std::fs::read(b)) { (Ok(x), Ok(y)) => x == y, _ => false }
}
pub fn is_installed() -> bool { same_file(&bundled_dll(), &installed_dll()) && frame_dir().is_dir() }

/* ------------------------------------------------------------------ install (runs elevated: `prism-cam.exe --install-vcam`) */
pub fn install_elevated() -> i32 {
    let run = |exe: &str, args: &[&str]| Command::new(exe).args(args).creation_flags(NO_WINDOW).status().map(|s| s.success()).unwrap_or(false);
    let (src, dir, dst) = (bundled_dll(), install_dir(), installed_dll());
    if !src.exists() { return 2; }
    if std::fs::create_dir_all(&dir).is_err() { return 3; }
    if !same_file(&src, &dst) {
        if dst.exists() { // the camera service may still hold the old copy open → move it aside
            let aside = dir.join(format!("prism_vcam.{}.old", std::process::id()));
            if std::fs::rename(&dst, &aside).is_err() { return 4; }
        }
        if std::fs::copy(&src, &dst).is_err() { return 5; }
    }
    for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() { // best effort clean-up of older copies
        if e.path().extension().map_or(false, |x| x == "old") { let _ = std::fs::remove_file(e.path()); }
    }
    let key = format!("HKLM\\SOFTWARE\\Classes\\CLSID\\{VCAM_CLSID_STR}");
    let inproc = format!("{key}\\InprocServer32");
    let path = dst.to_string_lossy().to_string();
    if !run("reg", &["add", &key, "/ve", "/d", "Prism Cam virtual camera", "/f"])
        || !run("reg", &["add", &inproc, "/ve", "/d", &path, "/f"])
        || !run("reg", &["add", &inproc, "/v", "ThreadingModel", "/d", "Both", "/f"]) { return 6; }
    // frame folder: the signed-in user writes, the camera service (LocalService) reads
    let fd = frame_dir();
    if std::fs::create_dir_all(&fd).is_err() { return 7; }
    let fds = fd.to_string_lossy().to_string();
    if !run("icacls", &[&fds, "/grant", "*S-1-5-32-545:(OI)(CI)M", "/grant", "*S-1-5-19:(OI)(CI)RX"]) { return 8; }
    0
}
pub fn install() -> Value {
    if !bundled_dll().exists() { return json!({ "ok": false, "reason": "nodll" }); }
    let exe = HSTRING::from(std::env::current_exe().unwrap_or_default().as_os_str());
    let mut info = SHELLEXECUTEINFOW { cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32, fMask: SEE_MASK_NOCLOSEPROCESS, lpVerb: w!("runas"), lpFile: PCWSTR(exe.as_ptr()), lpParameters: w!("--install-vcam"), nShow: 0, ..Default::default() };
    unsafe {
        if ShellExecuteExW(&mut info).is_err() || info.hProcess.is_invalid() { return json!({ "ok": false, "reason": "denied" }); }
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code = 1u32;
        let _ = GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);
        if code != 0 || !is_installed() { return json!({ "ok": false, "reason": "install", "detail": format!("code {code}") }); }
    }
    json!({ "ok": true })
}

/* -------------------------------------------------------------------- start / stop */
type CreateFn = unsafe extern "system" fn(i32, i32, i32, PCWSTR, PCWSTR, *const GUID, u32, *mut *mut c_void) -> HRESULT;
pub fn start() -> Value {
    let no = |reason: &str, detail: String| json!({ "ok": false, "reason": reason, "detail": detail });
    if !bundled_dll().exists() { return no("nodll", String::new()); }
    // Windows 10 has no MFCreateVirtualCamera → look it up at run time instead of importing it
    let create: CreateFn = unsafe {
        let lib = match LoadLibraryW(w!("mfsensorgroup.dll")) { Ok(l) => l, Err(_) => return no("oldwin", String::new()) };
        match GetProcAddress(lib, windows::core::s!("MFCreateVirtualCamera")) { Some(f) => std::mem::transmute(f), None => return no("oldwin", String::new()) }
    };
    if !is_installed() { return no("setup", String::new()); }
    let mut h = HOST.lock().unwrap();
    if h.cam.is_some() { return json!({ "ok": true }); }
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        if let Err(e) = MFStartup(0x0002_0070, MFSTARTUP_FULL) { return no("mf", e.message()); }
        if h.view.is_null() {
            let file = match std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(frame_path()) { Ok(f) => f, Err(e) => return no("frame", e.to_string()) };
            if file.set_len(FRAME_FILE_SIZE as u64).is_err() { return no("frame", "size".into()); }
            let hmap = match CreateFileMappingW(HANDLE(file.as_raw_handle()), None, PAGE_READWRITE, 0, FRAME_FILE_SIZE as u32, PCWSTR::null()) { Ok(m) => m, Err(e) => return no("frame", e.message()) };
            let view = MapViewOfFile(hmap, FILE_MAP_WRITE, 0, 0, FRAME_FILE_SIZE);
            if view.Value.is_null() { let _ = CloseHandle(hmap); return no("frame", "map".into()); }
            h.file = Some(file); h.hmap = hmap; h.view = view.Value as *mut u8;
            std::ptr::write_bytes(h.view, 0, FRAME_HEADER);
        }
        let (name, clsid) = (HSTRING::from(VCAM_NAME), HSTRING::from(VCAM_CLSID_STR));
        let mut raw: *mut c_void = std::ptr::null_mut();
        // software camera · lives while this app holds it · visible to the current user only
        let hr = create(0, 0, 0, PCWSTR(name.as_ptr()), PCWSTR(clsid.as_ptr()), std::ptr::null(), 0, &mut raw);
        if hr.is_err() || raw.is_null() { return no("create", format!("{:#010x} {}", hr.0, hr.message())); }
        let cam = IMFVirtualCamera::from_raw(raw);
        if let Err(e) = cam.Start(None) { let _ = cam.Remove(); return no("startcam", format!("{:#010x} {}", e.code().0, e.message())); }
        h.cam = Some(cam);
    }
    json!({ "ok": true })
}
pub fn stop() {
    let mut h = HOST.lock().unwrap();
    unsafe {
        if let Some(cam) = h.cam.take() { let _ = cam.Remove(); let _ = cam.Shutdown(); }
        if !h.view.is_null() {
            std::ptr::write_bytes(h.view, 0, FRAME_HEADER); // tells the DLL there is no picture
            let _ = UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: h.view as *mut c_void });
            let _ = CloseHandle(h.hmap);
            h.view = std::ptr::null_mut(); h.file = None;
        }
    }
}

/* ------------------------------------------------------------------------- frames */
/// RGBA (w×h) → NV12 (BT.709, video range) into the shared frame file.
pub fn push(rgba: &[u8], w: usize, h: usize) -> bool {
    let (w2, h2) = (w & !1, h & !1);
    if w2 < 2 || h2 < 2 || w2 * h2 > FRAME_MAX_PIXELS || rgba.len() < w * h * 4 { return false; }
    let mut host = HOST.lock().unwrap();
    if host.view.is_null() { return false; }
    unsafe {
        let dst = std::slice::from_raw_parts_mut(host.view.add(FRAME_HEADER), w2 * h2 * 3 / 2);
        let (ys, uvs) = dst.split_at_mut(w2 * h2);
        for y in 0..h2 {
            let row = &rgba[y * w * 4..];
            let out = &mut ys[y * w2..(y + 1) * w2];
            for x in 0..w2 {
                let (r, g, b) = (row[x * 4] as i32, row[x * 4 + 1] as i32, row[x * 4 + 2] as i32);
                out[x] = (16 + ((47 * r + 157 * g + 16 * b + 128) >> 8)) as u8;
            }
        }
        for y in 0..h2 / 2 {
            let (r0, r1) = (&rgba[(y * 2) * w * 4..], &rgba[(y * 2 + 1) * w * 4..]);
            let out = &mut uvs[y * w2..(y + 1) * w2];
            for x in 0..w2 / 2 {
                let i = x * 8;
                let r = (r0[i] as i32 + r0[i + 4] as i32 + r1[i] as i32 + r1[i + 4] as i32) >> 2;
                let g = (r0[i + 1] as i32 + r0[i + 5] as i32 + r1[i + 1] as i32 + r1[i + 5] as i32) >> 2;
                let b = (r0[i + 2] as i32 + r0[i + 6] as i32 + r1[i + 2] as i32 + r1[i + 6] as i32) >> 2;
                out[x * 2] = (128 + ((-26 * r - 87 * g + 112 * b + 128) >> 8)).clamp(0, 255) as u8;
                out[x * 2 + 1] = (128 + ((112 * r - 102 * g - 10 * b + 128) >> 8)).clamp(0, 255) as u8;
            }
        }
        host.seq = host.seq.wrapping_add(1).max(1);
        let head = host.view as *mut u32;
        head.add(1).write_volatile(w2 as u32);
        head.add(2).write_volatile(h2 as u32);
        head.add(3).write_volatile(host.seq);
        head.write_volatile(FRAME_MAGIC);
    }
    true
}
