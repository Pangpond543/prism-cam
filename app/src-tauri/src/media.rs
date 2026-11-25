// Prism Cam — "what is playing on this PC" + synced lyrics, for the lyrics layer.
// Now playing = Windows media controls (GSMTC): Spotify, browsers (YouTube…), Apple Music… — no login, nothing sent.
// Lyrics = LRCLIB (free, open, no key): only the song title / artist / album / length are sent, the answer is kept in
// <data>/lyrics so the same song never asks again. The user's own .lrc for a song wins over LRCLIB.
use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use winrt::core::Interface;
use winrt::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use winrt::Storage::Streams::{DataReader, IInputStream};

const NO_WINDOW: u32 = 0x0800_0000;
static MGR: Mutex<Option<Manager>> = Mutex::new(None);

fn com() { unsafe { let _ = winrt::Win32::System::Com::CoInitializeEx(None, winrt::Win32::System::Com::COINIT_MULTITHREADED); } }
fn mgr() -> Option<Manager> {
    com();
    let mut g = MGR.lock().ok()?;
    if g.is_none() { *g = Manager::RequestAsync().ok().and_then(|a| a.join().ok()); }
    g.clone()
}
fn aumid(s: &Session) -> String { s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default() }
fn playing(s: &Session) -> bool { s.GetPlaybackInfo().and_then(|p| p.PlaybackStatus()).map(|st| st == Status::Playing).unwrap_or(false) }
/// the session to follow: `want` ("spotify", "chrome"… part of the app id) if given, else playing beats paused, Spotify beats others
fn pick(m: &Manager, want: &str) -> Option<Session> {
    let want = want.to_lowercase();
    let mut best: Option<(i32, Session)> = None;
    for s in m.GetSessions().ok()? {
        let id = aumid(&s).to_lowercase();
        let sc = if !want.is_empty() && id.contains(&want) { 10 } else { 0 } + (playing(&s) as i32) * 4 + id.contains("spotify") as i32;
        if best.as_ref().map_or(true, |b| sc > b.0) { best = Some((sc, s)); }
    }
    best.map(|b| b.1).or_else(|| m.GetCurrentSession().ok())
}
/// Windows FILETIME now (100 ns since 1601)
fn ft_now() -> i64 {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    (d.as_nanos() / 100) as i64 + 116_444_736_000_000_000
}
fn app_name(id: &str) -> String {
    let l = id.to_lowercase();
    for (k, n) in [("spotify", "Spotify"), ("chrome", "Chrome"), ("msedge", "Edge"), ("firefox", "Firefox"), ("applemusic", "Apple Music"), ("zune", "Media Player"), ("vlc", "VLC"), ("tidal", "TIDAL"), ("deezer", "Deezer"), ("youtube", "YouTube Music")] {
        if l.contains(k) { return n.into(); }
    }
    id.rsplit(['\\', '!']).next().unwrap_or(id).trim_end_matches(".exe").to_string()
}

/// → { ok, none } | { ok, app, appId, title, artist, album, playing, posMs, durMs, apps:[{id,name,playing}] }
pub fn now(a: &Value) -> Value {
    let Some(m) = mgr() else { return json!({ "ok": false, "reason": "nomgr" }) };
    let apps: Vec<Value> = m.GetSessions().map(|l| l.into_iter().map(|s| { let id = aumid(&s); json!({ "id": id, "name": app_name(&id), "playing": playing(&s) }) }).collect()).unwrap_or_default();
    let Some(s) = pick(&m, a["app"].as_str().unwrap_or("")) else { return json!({ "ok": true, "none": true, "apps": apps }) };
    let id = aumid(&s);
    let (mut title, mut artist, mut album) = (String::new(), String::new(), String::new());
    if let Ok(p) = s.TryGetMediaPropertiesAsync().and_then(|op| op.join()) {
        title = p.Title().map(|h| h.to_string()).unwrap_or_default();
        artist = p.Artist().map(|h| h.to_string()).unwrap_or_default();
        album = p.AlbumTitle().map(|h| h.to_string()).unwrap_or_default();
        if artist.is_empty() { artist = p.AlbumArtist().map(|h| h.to_string()).unwrap_or_default(); }
    }
    let on = playing(&s);
    let (mut pos, mut dur) = (0i64, 0i64);
    if let Ok(t) = s.GetTimelineProperties() {
        let start = t.StartTime().map(|x| x.Duration).unwrap_or(0);
        pos = t.Position().map(|x| x.Duration).unwrap_or(0) - start;
        dur = t.EndTime().map(|x| x.Duration).unwrap_or(0) - start;
        // the app only reports its position when something changes (play, pause, seek): add the time since then
        let upd = t.LastUpdatedTime().map(|x| x.UniversalTime).unwrap_or(0);
        if on && upd > 0 { pos += (ft_now() - upd).max(0); }
        if dur > 0 { pos = pos.clamp(0, dur); }
    }
    json!({ "ok": true, "app": app_name(&id), "appId": id, "title": title, "artist": artist, "album": album, "playing": on,
            "posMs": pos / 10_000, "durMs": dur / 10_000, "apps": apps })
}

/// cover picture of what is playing → { ok, url: data:… }
pub fn art(a: &Value) -> Value {
    let get = || -> winrt::core::Result<(String, Vec<u8>)> {
        let m = mgr().ok_or_else(winrt::core::Error::empty)?;
        let s = pick(&m, a["app"].as_str().unwrap_or("")).ok_or_else(winrt::core::Error::empty)?;
        let p = s.TryGetMediaPropertiesAsync()?.join()?;
        let st = p.Thumbnail()?.OpenReadAsync()?.join()?;
        let size = st.Size()?.min(8 << 20) as u32;
        let mime = st.ContentType().map(|h| h.to_string()).unwrap_or_default();
        let r = DataReader::CreateDataReader(&st.cast::<IInputStream>()?)?;
        let n = r.LoadAsync(size)?.join()?;
        let mut buf = vec![0u8; n as usize];
        r.ReadBytes(&mut buf)?;
        Ok((if mime.starts_with("image/") { mime } else { "image/jpeg".into() }, buf))
    };
    match get() {
        Ok((mime, b)) if !b.is_empty() => json!({ "ok": true, "url": format!("data:{mime};base64,{}", b64(&b)) }),
        _ => json!({ "ok": false }),
    }
}
fn b64(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(b.len() * 4 / 3 + 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 { s.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' }); }
    }
    s
}

/* ------------------------------------------------------------------ lyrics */
fn enc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}
fn get(url: &str) -> (u32, String) {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let curl = PathBuf::from(root).join("System32").join("curl.exe");
    let o = Command::new(if curl.exists() { curl } else { "curl.exe".into() })
        .args(["-s", "--proto", "=https", "--max-time", "12", "-A", concat!("PrismCam/", env!("CARGO_PKG_VERSION"), " (https://github.com/Pangpond543/prism-cam)"), "-w", "\n%{http_code}", url])
        .creation_flags(NO_WINDOW).output();
    match o {
        Ok(o) => {
            let t = String::from_utf8_lossy(&o.stdout).to_string();
            let (body, code) = t.rsplit_once('\n').unwrap_or(("", t.as_str()));
            (code.trim().parse().unwrap_or(0), body.to_string())
        }
        Err(_) => (0, String::new()),
    }
}
/// "Song - Remastered 2011", "Song (feat. X)" → "Song"
fn clean(t: &str) -> String {
    let mut s = t.to_string();
    for sep in [" - ", " – ", " (", " [", " feat.", " ft."] { if let Some(i) = s.find(sep) { if i > 0 { s.truncate(i); } } }
    s.trim().to_string()
}
fn key(title: &str, artist: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in format!("{}\u{1}{}", artist.trim().to_lowercase(), title.trim().to_lowercase()).bytes() { h ^= b as u64; h = h.wrapping_mul(0x100000001b3); }
    format!("{h:016x}")
}
fn dir(data: &Path) -> PathBuf { data.join("lyrics") }
fn now_s() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }
fn pick_hit(list: &Value, dur: f64) -> Option<Value> {
    let arr = list.as_array()?;
    let score = |v: &Value| {
        let d = v["duration"].as_f64().unwrap_or(0.0);
        let off = if dur > 0.0 && d > 0.0 { (d - dur).abs() } else { 5.0 };
        (if v["syncedLyrics"].as_str().map_or(false, |s| !s.is_empty()) { 0.0 } else { 100.0 }) + off
    };
    arr.iter().filter(|v| v["syncedLyrics"].is_string() || v["plainLyrics"].is_string())
        .min_by(|a, b| score(a).partial_cmp(&score(b)).unwrap_or(std::cmp::Ordering::Equal))
        .filter(|v| dur <= 0.0 || v["duration"].as_f64().map_or(true, |d| (d - dur).abs() < 15.0))
        .cloned()
}
fn found(v: &Value) -> Value {
    json!({ "ok": true, "synced": v["syncedLyrics"].as_str().unwrap_or(""), "plain": v["plainLyrics"].as_str().unwrap_or(""),
            "source": "lrclib", "id": v["id"].clone(), "name": v["trackName"].clone(), "artist": v["artistName"].clone(), "t": now_s() })
}
/// a { title, artist, album, durMs, force } → { ok, synced, plain, source } | { ok, none } | { ok:false, reason:"net" }
pub fn lyrics(data: &Path, a: &Value) -> Value {
    let (title, artist) = (a["title"].as_str().unwrap_or("").trim(), a["artist"].as_str().unwrap_or("").trim());
    if title.is_empty() { return json!({ "ok": true, "none": true }); }
    let album = a["album"].as_str().unwrap_or("");
    let dur = a["durMs"].as_f64().unwrap_or(0.0) / 1000.0;
    let k = key(title, artist);
    let d = dir(data);
    if let Ok(lrc) = std::fs::read_to_string(d.join(format!("{k}.lrc"))) { return json!({ "ok": true, "synced": lrc, "plain": "", "source": "file" }); }
    let cache = d.join(format!("{k}.json"));
    let force = a["force"].as_bool().unwrap_or(false);
    if !force {
        if let Some(v) = std::fs::read_to_string(&cache).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()) {
            // "not found" is asked again after a day (LRCLIB grows every day)
            if !v["none"].as_bool().unwrap_or(false) || now_s().saturating_sub(v["t"].as_u64().unwrap_or(0)) < 86_400 { return v; }
        }
    }
    let save = |v: &Value| { let _ = std::fs::create_dir_all(&d); let _ = std::fs::write(&cache, v.to_string()); };
    let mut url = format!("https://lrclib.net/api/get?track_name={}&artist_name={}", enc(title), enc(artist));
    if !album.is_empty() { url += &format!("&album_name={}", enc(album)); }
    if dur > 0.0 { url += &format!("&duration={}", dur.round() as i64); }
    let (code, body) = get(&url);
    if code == 0 { return json!({ "ok": false, "reason": "net" }); }
    if code == 200 {
        if let Ok(v) = serde_json::from_str::<Value>(&body) { if v["syncedLyrics"].is_string() || v["plainLyrics"].is_string() { let r = found(&v); save(&r); return r; } }
    }
    // not an exact match: search (title cleaned of "- Remastered", "(feat. …)")
    let ct = clean(title);
    for q in [format!("track_name={}&artist_name={}", enc(&ct), enc(artist)), format!("q={}", enc(&format!("{ct} {artist}")))] {
        let (code, body) = get(&format!("https://lrclib.net/api/search?{q}"));
        if code == 0 { return json!({ "ok": false, "reason": "net" }); }
        if let Some(v) = serde_json::from_str::<Value>(&body).ok().and_then(|l| pick_hit(&l, dur)) { let r = found(&v); save(&r); return r; }
    }
    let r = json!({ "ok": true, "none": true, "t": now_s() });
    save(&r);
    r
}
/// the user's own lyrics for a song: a { title, artist, lrc } (empty lrc = remove it, back to LRCLIB)
pub fn lyrics_put(data: &Path, a: &Value) -> Value {
    let (title, artist) = (a["title"].as_str().unwrap_or(""), a["artist"].as_str().unwrap_or(""));
    if title.trim().is_empty() { return json!({ "ok": false }); }
    let d = dir(data);
    let p = d.join(format!("{}.lrc", key(title, artist)));
    let lrc = a["lrc"].as_str().unwrap_or("");
    if lrc.trim().is_empty() { let _ = std::fs::remove_file(&p); return json!({ "ok": true }); }
    json!({ "ok": std::fs::create_dir_all(&d).is_ok() && std::fs::write(&p, lrc).is_ok() })
}

/* ------------------------------------------------------- the user's fonts */
fn font_dir(data: &Path) -> PathBuf { data.join("fonts") }
pub fn font_name(s: &str) -> String {
    // any letter of any script (Thai marks included), only path / reserved characters removed
    let n: String = s.chars().filter(|c| !c.is_control() && !r#"\/:*?"<>|"#.contains(*c)).take(80).collect();
    let n = n.trim().trim_start_matches('.').to_string();
    let l = n.to_lowercase();
    if [".ttf", ".otf", ".woff", ".woff2"].iter().any(|e| l.ends_with(e)) { n } else { String::new() }
}
pub fn font_put(data: &Path, name: &str, bytes: &[u8]) -> Value {
    let n = font_name(name);
    if n.is_empty() || bytes.len() > 30 << 20 { return json!({ "ok": false }); }
    let d = font_dir(data);
    json!({ "ok": std::fs::create_dir_all(&d).is_ok() && std::fs::write(d.join(&n), bytes).is_ok(), "name": n })
}
pub fn font_list(data: &Path) -> Value {
    let mut v: Vec<String> = std::fs::read_dir(font_dir(data)).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| !font_name(n).is_empty()).collect()).unwrap_or_default();
    v.sort();
    json!({ "ok": true, "fonts": v })
}
pub fn font_get(data: &Path, name: &str) -> Vec<u8> {
    let n = font_name(name);
    if n.is_empty() { return vec![]; }
    std::fs::read(font_dir(data).join(n)).unwrap_or_default()
}
pub fn font_del(data: &Path, name: &str) -> Value {
    let n = font_name(name);
    json!({ "ok": !n.is_empty() && std::fs::remove_file(font_dir(data).join(n)).is_ok() })
}

/* -------------------------------------------------- loudness (water colours, ripples) */
// How loud the music app is right now: Windows keeps a peak meter per audio session, so we read the player's own
// session (Spotify, Chrome…) — your voice in Discord or game sounds don't move the colours. No capture, no audio data:
// just a 0..1 peak, sampled 60× a second on a small thread that stops by itself 3 s after the page stops asking.
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering::Relaxed};
use winrt::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
use winrt::Win32::Media::Audio::{eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator};
use winrt::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

static LVL: AtomicU32 = AtomicU32::new(0);
static AVG: AtomicU32 = AtomicU32::new(0);
static BEATS: AtomicU32 = AtomicU32::new(0);
static AMP: AtomicU32 = AtomicU32::new(0);
static ASKED: AtomicU64 = AtomicU64::new(0);
static RUN: AtomicBool = AtomicBool::new(false);
static WHOLE: AtomicBool = AtomicBool::new(false);
static WANT: Mutex<String> = Mutex::new(String::new());
static MERR: Mutex<String> = Mutex::new(String::new()); // why no meter (shown by the lylevel test hook)
fn merr(s: String) { if let Ok(mut e) = MERR.lock() { *e = s; } }
fn ms() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0) }
fn f(a: &AtomicU32) -> f32 { f32::from_bits(a.load(Relaxed)) }

fn proc_stem(pid: u32) -> String {
    use winrt::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut buf = [0u16; 512]; let mut n = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, winrt::core::PWSTR(buf.as_mut_ptr()), &mut n).is_ok();
        let _ = winrt::Win32::Foundation::CloseHandle(h);
        if !ok { return String::new(); }
        let p = String::from_utf16_lossy(&buf[..n as usize]);
        p.rsplit(['\\', '/']).next().unwrap_or("").trim_end_matches(".exe").trim_end_matches(".EXE").to_lowercase()
    }
}
/// the player's own session meter (the loudest one that matches), else the whole speaker output
fn find_meter(want: &str) -> Option<(IAudioMeterInformation, bool)> {
    unsafe {
        let en: IMMDeviceEnumerator = match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) { Ok(x) => x, Err(e) => { merr(format!("enum {e}")); return None; } };
        let dev = match en.GetDefaultAudioEndpoint(eRender, eConsole) { Ok(x) => x, Err(e) => { merr(format!("endpoint {e}")); return None; } };
        let mut best: Option<(f32, IAudioMeterInformation)> = None;
        if !want.is_empty() {
            if let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) {
                if let Ok(list) = mgr.GetSessionEnumerator() {
                    for i in 0..list.GetCount().unwrap_or(0) {
                        let Ok(c) = list.GetSession(i) else { continue };
                        let Ok(c2) = c.cast::<IAudioSessionControl2>() else { continue };
                        let pid = c2.GetProcessId().unwrap_or(0);
                        if pid == 0 { continue; }
                        let stem = proc_stem(pid);
                        if stem.len() < 3 || !(want.contains(&stem) || stem.contains(want)) { continue; }
                        let Ok(m) = c.cast::<IAudioMeterInformation>() else { continue };
                        let p = m.GetPeakValue().unwrap_or(0.0);
                        if best.as_ref().map_or(true, |b| p > b.0) { best = Some((p, m)); }
                    }
                }
            }
        }
        if let Some((_, m)) = best { return Some((m, false)); }
        match dev.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None) { Ok(m) => { merr(String::new()); Some((m, true)) } Err(e) => { merr(format!("meter {e}")); None } }
    }
}
fn meter_loop() {
    com();
    let (mut meter, mut found, mut want_was) = (None::<IAudioMeterInformation>, std::time::Instant::now() - std::time::Duration::from_secs(9), String::new());
    let (mut fast, mut slow, mut last_beat) = (0f32, 0f32, std::time::Instant::now());
    while ms().saturating_sub(ASKED.load(Relaxed)) < 3000 {
        let want = WANT.lock().map(|w| w.clone()).unwrap_or_default();
        if meter.is_none() || found.elapsed().as_secs() >= 2 || want != want_was {
            match find_meter(&want) { Some((m, whole)) => { meter = Some(m); WHOLE.store(whole, Relaxed); } None => meter = None }
            found = std::time::Instant::now(); want_was = want;
        }
        let p = meter.as_ref().and_then(|m| unsafe { m.GetPeakValue() }.ok()).unwrap_or(0.0).clamp(0.0, 1.0);
        fast += (p - fast) * if p > fast { 0.6 } else { 0.25 };
        slow += (p - slow) * 0.02;
        // a beat = the level jumps well above its recent average (no more than ~3 a second)
        if fast > slow * 1.45 + 0.05 && last_beat.elapsed().as_millis() > 330 {
            BEATS.fetch_add(1, Relaxed);
            AMP.store((((fast - slow) / (slow + 0.08)).min(1.0)).to_bits(), Relaxed);
            last_beat = std::time::Instant::now();
        }
        LVL.store(fast.to_bits(), Relaxed); AVG.store(slow.to_bits(), Relaxed);
        std::thread::sleep(std::time::Duration::from_millis(16));
    }
    LVL.store(0f32.to_bits(), Relaxed); AVG.store(0f32.to_bits(), Relaxed);
    RUN.store(false, Relaxed);
}
/// a { app: part of the player's app id } → { ok, lvl, avg, beats, amp, whole }
pub fn level(a: &Value) -> Value {
    let want = a["app"].as_str().unwrap_or("").to_lowercase().trim_end_matches(".exe").to_string();
    if let Ok(mut w) = WANT.lock() { *w = want; }
    ASKED.store(ms(), Relaxed);
    if !RUN.swap(true, Relaxed) { std::thread::spawn(meter_loop); }
    json!({ "ok": true, "lvl": f(&LVL), "avg": f(&AVG), "beats": BEATS.load(Relaxed), "amp": f(&AMP), "whole": WHOLE.load(Relaxed), "err": MERR.lock().map(|e| e.clone()).unwrap_or_default(), "run": RUN.load(Relaxed) })
}
