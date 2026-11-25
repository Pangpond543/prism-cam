// Phone as a camera. Prism Cam serves a small page over HTTPS on the home network; the phone opens it (QR code) and
// sends its camera straight to the studio page over WebRTC. This side only serves the page and relays the WebRTC
// hand-shake and the controls:
//   phone  → POST /api/hello · /api/send · /api/bye   → event "phone:msg" { pid, m } to the studio page
//   studio → phone_send(pid, m)                         → the phone's long poll GET /api/poll
// HTTPS is required: phone browsers only open the camera on a secure page. The certificate is made on this PC once and
// kept in the app data folder, so a phone only has to accept it the first time (not after every restart).
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, TcpListener, TcpStream, UdpSocket};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const PAGE: &str = include_str!("../phone/index.html");
const JS: &str = include_str!("../phone/phone.js");
const CSS: &str = include_str!("../phone/phone.css");
const ICON: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#0B6F73"/><path d="M38 31 L43 25 H57 L62 31 Z" fill="#fff"/><rect x="24" y="31" width="52" height="40" rx="10" fill="#fff"/><circle cx="50" cy="51" r="12" fill="#0B6F73"/><circle cx="50" cy="51" r="6" fill="#fff"/></svg>"##;
pub const PORT0: u16 = 8543;
const PORTS: u16 = 10; // 8543 … 8552
const NO_WINDOW: u32 = 0x0800_0000;
const FW_RULE: &str = "Prism Cam phone camera";

struct Phone { sid: String, q: Vec<Value>, seen: Instant }
#[derive(Default)]
struct St { token: String, phones: HashMap<String, Phone>, port: u16, stop: Option<Arc<AtomicBool>>, worker: Option<std::thread::JoinHandle<()>>, app: Option<AppHandle> }
fn st() -> &'static (Mutex<St>, Condvar) { static S: OnceLock<(Mutex<St>, Condvar)> = OnceLock::new(); S.get_or_init(|| (Mutex::new(St::default()), Condvar::new())) }
fn lock(m: &Mutex<St>) -> MutexGuard<'_, St> { m.lock().unwrap_or_else(|e| e.into_inner()) }
static START: Mutex<()> = Mutex::new(());
static CONNS: AtomicUsize = AtomicUsize::new(0);
fn log(s: &str) { crate::log_line(&format!("PHONE {s}")); }

fn clean(s: &str, n: usize) -> String { s.chars().filter(|c| c.is_ascii_alphanumeric()).take(n).collect() }
fn emit(pid: &str, m: Value) {
    let app = lock(&st().0).app.clone();
    if let Some(a) = app { let _ = a.emit("phone:msg", json!({ "pid": pid, "m": m })); }
}

/* ------------------------------------------------------------------ control */
/// Start (or keep) the server. `token` = the pairing code in the QR link (made and kept by the studio page).
pub fn start(app: &AppHandle, dir: PathBuf, token: String) -> Value {
    let _one = START.lock().unwrap_or_else(|e| e.into_inner());
    let token = clean(&token, 64);
    if token.len() < 12 { return json!({ "ok": false, "reason": "token" }); }
    let (m, _) = st();
    {
        let mut s = lock(m);
        s.token = token; s.app = Some(app.clone());
        if s.stop.is_some() { let p = s.port; drop(s); return info(p); }
    }
    let cfg = match tls_config(&dir) { Ok(c) => Arc::new(c), Err(e) => { log(&format!("certificate failed: {e}")); return json!({ "ok": false, "reason": "cert", "detail": e }); } };
    let mut bound = None;
    for p in PORT0..PORT0 + PORTS { if let Ok(l) = TcpListener::bind((Ipv4Addr::UNSPECIFIED, p)) { bound = Some((l, p)); break; } }
    let Some((lis, port)) = bound else { log("no free port"); return json!({ "ok": false, "reason": "port" }) };
    let _ = lis.set_nonblocking(true);
    let stop = Arc::new(AtomicBool::new(false));
    let worker = { let stop = stop.clone(); std::thread::spawn(move || accept_loop(lis, cfg, stop)) };
    { let mut s = lock(m); s.port = port; s.stop = Some(stop); s.worker = Some(worker); }
    log(&format!("server on port {port}"));
    info(port)
}
pub fn stop() {
    let _one = START.lock().unwrap_or_else(|e| e.into_inner());
    let (m, cv) = st();
    let (stop, worker) = { let mut s = lock(m); s.phones.clear(); (s.stop.take(), s.worker.take()) };
    if let Some(f) = stop { f.store(true, Ordering::SeqCst); log("server stopped"); }
    cv.notify_all();
    if let Some(w) = worker { let _ = w.join(); } // the port is free again before a new start
}
pub fn running() -> Value {
    let s = lock(&st().0);
    json!({ "on": s.stop.is_some(), "port": s.port, "phones": s.phones.keys().cloned().collect::<Vec<_>>() })
}
/// studio → phone (the phone picks it up with its long poll)
pub fn send(pid: &str, m: Value) -> Value {
    let (mx, cv) = st();
    let mut s = lock(mx);
    let Some(p) = s.phones.get_mut(&clean(pid, 24)) else { return json!({ "ok": false, "reason": "gone" }) };
    if p.q.len() > 200 { p.q.drain(..100); } // a phone that stopped reading must not grow the queue for ever
    p.q.push(m);
    drop(s); cv.notify_all();
    json!({ "ok": true })
}
fn info(port: u16) -> Value {
    let list: Vec<Value> = ips().into_iter().map(|(ip, name)| json!({ "ip": ip.to_string(), "name": name })).collect();
    json!({ "ok": true, "port": port, "ips": list, "host": std::env::var("COMPUTERNAME").unwrap_or_default() })
}
/// this PC's addresses on the home network, the one the default route uses first, virtual adapters last
fn ips() -> Vec<(Ipv4Addr, String)> {
    let primary = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).and_then(|u| { u.connect(("8.8.8.8", 53))?; u.local_addr() }).ok().map(|a| a.ip());
    let mut v: Vec<(Ipv4Addr, String, i32)> = Vec::new();
    for i in if_addrs::get_if_addrs().unwrap_or_default() {
        let IpAddr::V4(a) = i.ip() else { continue };
        if a.is_loopback() || a.is_link_local() || a.is_unspecified() || v.iter().any(|x| x.0 == a) { continue; }
        let n = i.name.to_lowercase();
        let virt = ["vethernet", "virtualbox", "vmware", "hyper-v", "wsl", "loopback", "bluetooth", "tailscale", "zerotier", "radmin", "hamachi", "vpn", "tap-", "wintun", "npcap"].iter().any(|k| n.contains(k));
        let mut rank = if Some(IpAddr::V4(a)) == primary { 0 } else if a.is_private() { 2 } else { 4 };
        if virt { rank += 5; }
        v.push((a, i.name, rank));
    }
    if v.is_empty() { if let Some(IpAddr::V4(a)) = primary { if !a.is_unspecified() { v.push((a, String::new(), 0)); } } }
    v.sort_by_key(|x| x.2);
    v.into_iter().map(|(a, n, _)| (a, n)).collect()
}
pub fn qr_svg(text: &str) -> Value {
    use qrcode::render::svg;
    match qrcode::QrCode::with_error_correction_level(text.as_bytes(), qrcode::EcLevel::M) {
        Ok(code) => json!({ "ok": true, "svg": code.render::<svg::Color>().min_dimensions(240, 240).dark_color(svg::Color("#000000")).light_color(svg::Color("#ffffff")).build() }),
        Err(_) => json!({ "ok": false }),
    }
}

/* -------------------------------------------------------------- certificate */
fn civil(days: i64) -> (i32, u8, u8) { // days since 1970-01-01 → (year, month, day)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u8;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u8;
    ((yoe + era * 400 + if m <= 2 { 1 } else { 0 }) as i32, m, d)
}
fn load_or_make_cert(dir: &Path) -> Result<(Vec<u8>, Vec<u8>), String> {
    let (cp, kp) = (dir.join("phone-cert.der"), dir.join("phone-key.der"));
    let young = std::fs::metadata(&cp).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|e| e < Duration::from_secs(330 * 86_400));
    if young { if let (Ok(c), Ok(k)) = (std::fs::read(&cp), std::fs::read(&kp)) { if !c.is_empty() && !k.is_empty() { return Ok((c, k)); } } }
    let today = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64 / 86_400).unwrap_or(20_000);
    let mut p = rcgen::CertificateParams::new(vec!["prism-cam.local".to_string()]).map_err(|e| e.to_string())?;
    p.distinguished_name.push(rcgen::DnType::CommonName, "Prism Cam (this PC)");
    p.distinguished_name.push(rcgen::DnType::OrganizationName, "Prism Cam");
    let (a, b) = (civil(today - 2), civil(today + 365));
    p.not_before = rcgen::date_time_ymd(a.0, a.1, a.2);
    p.not_after = rcgen::date_time_ymd(b.0, b.1, b.2);
    let key = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
    let cert = p.self_signed(&key).map_err(|e| e.to_string())?;
    let (c, k) = (cert.der().to_vec(), key.serialize_der());
    let _ = std::fs::create_dir_all(dir);
    if std::fs::write(&cp, &c).is_err() || std::fs::write(&kp, &k).is_err() { log("certificate not saved (made a new one for this run)"); }
    else { log("new certificate made"); }
    Ok((c, k))
}
fn tls_config(dir: &Path) -> Result<rustls::ServerConfig, String> {
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
    let (c, k) = load_or_make_cert(dir)?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut cfg = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions().map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(vec![CertificateDer::from(c)], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(k)))
        .map_err(|e| e.to_string())?;
    cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(cfg)
}

/* ------------------------------------------------------------------- server */
fn accept_loop(lis: TcpListener, cfg: Arc<rustls::ServerConfig>, stop: Arc<AtomicBool>) {
    let mut sweep_t = Instant::now();
    while !stop.load(Ordering::SeqCst) {
        match lis.accept() {
            Ok((tcp, _)) => {
                if CONNS.load(Ordering::SeqCst) >= 48 { drop(tcp); continue; } // nobody needs more; keeps a flood from eating threads
                CONNS.fetch_add(1, Ordering::SeqCst);
                let (cfg, stop) = (cfg.clone(), stop.clone());
                std::thread::spawn(move || { let _ = serve(tcp, cfg, stop); CONNS.fetch_sub(1, Ordering::SeqCst); });
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(40)),
            Err(_) => std::thread::sleep(Duration::from_millis(200)),
        }
        if sweep_t.elapsed() > Duration::from_secs(3) { sweep_t = Instant::now(); sweep(); }
    }
}
/// a phone that has not asked for anything for 45 s is gone (page closed, Wi-Fi lost, phone locked for long)
fn sweep() {
    let gone: Vec<String> = {
        let mut s = lock(&st().0);
        let g: Vec<String> = s.phones.iter().filter(|(_, p)| p.seen.elapsed() > Duration::from_secs(45)).map(|(k, _)| k.clone()).collect();
        for k in &g { s.phones.remove(k); }
        g
    };
    for pid in gone { log(&format!("{pid} timed out")); emit(&pid, json!({ "t": "gone" })); }
}

struct Req { method: String, path: String, query: HashMap<String, String>, body: Vec<u8>, host: String }
fn find(h: &[u8], pat: &[u8]) -> Option<usize> { h.windows(pat.len()).position(|w| w == pat) }
fn read_req<S: Read>(s: &mut S, buf: &mut Vec<u8>) -> std::io::Result<Option<Req>> {
    let mut tmp = [0u8; 8192];
    let end = loop {
        if let Some(i) = find(buf, b"\r\n\r\n") { break i; }
        if buf.len() > 32 * 1024 { return Ok(None); }
        let n = s.read(&mut tmp)?;
        if n == 0 { return Ok(None); }
        buf.extend_from_slice(&tmp[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, target) = (first.next().unwrap_or("").to_string(), first.next().unwrap_or("/").to_string());
    let (mut len, mut host) = (0usize, String::new());
    for l in lines {
        let Some((k, v)) = l.split_once(':') else { continue };
        match k.trim().to_ascii_lowercase().as_str() { "content-length" => len = v.trim().parse().unwrap_or(0), "host" => host = v.trim().to_string(), _ => {} }
    }
    if len > 1 << 20 { return Ok(None); }
    let start = end + 4;
    while buf.len() < start + len {
        let n = s.read(&mut tmp)?;
        if n == 0 { return Ok(None); }
        buf.extend_from_slice(&tmp[..n]);
    }
    let body = buf[start..start + len].to_vec();
    buf.drain(..start + len);
    let (path, qs) = target.split_once('?').map(|(a, b)| (a.to_string(), b.to_string())).unwrap_or((target.clone(), String::new()));
    let query = qs.split('&').filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())).collect();
    Ok(Some(Req { method, path, query, body, host }))
}
fn serve(tcp: TcpStream, cfg: Arc<rustls::ServerConfig>, stop: Arc<AtomicBool>) -> std::io::Result<()> {
    tcp.set_nonblocking(false)?;
    let _ = tcp.set_nodelay(true);
    tcp.set_read_timeout(Some(Duration::from_secs(40)))?;
    tcp.set_write_timeout(Some(Duration::from_secs(15)))?;
    let mut b = [0u8; 1];
    if tcp.peek(&mut b)? == 0 { return Ok(()); }
    if b[0] != 0x16 { return redirect(tcp); } // someone typed http:// — send them to the https:// page
    let conn = rustls::ServerConnection::new(cfg).map_err(|e| std::io::Error::other(e.to_string()))?;
    let mut s = rustls::StreamOwned::new(conn, tcp);
    let mut buf = Vec::new();
    while !stop.load(Ordering::SeqCst) {
        let Some(req) = read_req(&mut s, &mut buf)? else { break };
        let (code, ctype, body) = route(&req, &stop);
        let reason = match code { 200 => "OK", 204 => "No Content", 403 => "Forbidden", 404 => "Not Found", 409 => "Conflict", _ => "Bad Request" };
        let head = format!("HTTP/1.1 {code} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nConnection: keep-alive\r\n\r\n", body.len());
        s.write_all(head.as_bytes())?;
        s.write_all(&body)?;
        s.flush()?;
    }
    s.conn.send_close_notify();
    let _ = s.flush();
    Ok(())
}
fn redirect(mut tcp: TcpStream) -> std::io::Result<()> {
    let mut buf = Vec::new();
    let Some(req) = read_req(&mut tcp, &mut buf)? else { return Ok(()) };
    let port = lock(&st().0).port;
    let host = req.host.split(':').next().unwrap_or("").to_string();
    let qs = req.query.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&");
    let loc = format!("https://{host}:{port}{}{}{}", req.path, if qs.is_empty() { "" } else { "?" }, qs);
    let loc: String = loc.chars().filter(|c| !c.is_control()).collect();
    tcp.write_all(format!("HTTP/1.1 301 Moved Permanently\r\nLocation: {loc}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes())
}
type Resp = (u16, &'static str, Vec<u8>);
fn js(code: u16, v: Value) -> Resp { (code, "application/json; charset=utf-8", v.to_string().into_bytes()) }
fn route(req: &Req, stop: &AtomicBool) -> Resp {
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/") | ("GET", "/index.html") => (200, "text/html; charset=utf-8", PAGE.as_bytes().to_vec()),
        ("GET", "/phone.js") => (200, "text/javascript; charset=utf-8", JS.as_bytes().to_vec()),
        ("GET", "/phone.css") => (200, "text/css; charset=utf-8", CSS.as_bytes().to_vec()),
        ("GET", "/icon.svg") | ("GET", "/favicon.ico") => (200, "image/svg+xml", ICON.as_bytes().to_vec()),
        ("GET", "/api/poll") => poll(req.query.get("k").map(|s| s.as_str()).unwrap_or(""), req.query.get("pid").map(|s| s.as_str()).unwrap_or(""), req.query.get("sid").map(|s| s.as_str()).unwrap_or(""), stop),
        ("POST", p) if p.starts_with("/api/") => {
            let v: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
            let (k, pid, sid) = (v["k"].as_str().unwrap_or(""), clean(v["pid"].as_str().unwrap_or(""), 24), clean(v["sid"].as_str().unwrap_or(""), 24));
            if pid.len() < 6 || sid.len() < 6 { return js(400, json!({ "ok": false })); }
            let (m, cv) = st();
            let mut s = lock(m);
            if s.token.is_empty() || clean(k, 64) != s.token { return js(403, json!({ "ok": false, "reason": "key" })); }
            match p {
                "/api/hello" => {
                    let old = s.phones.insert(pid.clone(), Phone { sid: sid.clone(), q: Vec::new(), seen: Instant::now() });
                    drop(s); cv.notify_all(); // an older page of the same phone gets 409 on its next poll
                    log(&format!("{pid} hello{}", if old.is_some() { " (again)" } else { "" }));
                    let name: String = v["name"].as_str().unwrap_or("").chars().filter(|c| !c.is_control()).take(40).collect();
                    let ua: String = v["ua"].as_str().unwrap_or("").chars().filter(|c| !c.is_control()).take(200).collect();
                    emit(&pid, json!({ "t": "hello", "name": name, "ua": ua, "sid": sid, "join": v["join"].as_bool().unwrap_or(false) }));
                    js(200, json!({ "ok": true, "host": std::env::var("COMPUTERNAME").unwrap_or_default() }))
                }
                "/api/send" | "/api/bye" => {
                    match s.phones.get_mut(&pid) {
                        None => return js(404, json!({ "ok": false })),
                        Some(ph) if ph.sid != sid => return js(409, json!({ "ok": false })),
                        Some(ph) => ph.seen = Instant::now(),
                    }
                    if p == "/api/bye" { s.phones.remove(&pid); drop(s); log(&format!("{pid} left")); emit(&pid, json!({ "t": "bye" })); }
                    else { drop(s); emit(&pid, v["m"].clone()); }
                    js(200, json!({ "ok": true }))
                }
                _ => js(404, json!({ "ok": false })),
            }
        }
        _ => (404, "text/plain; charset=utf-8", b"not found".to_vec()),
    }
}
/// long poll: answers as soon as something is waiting for this phone, or after 20 s with nothing
fn poll(k: &str, pid: &str, sid: &str, stop: &AtomicBool) -> Resp {
    let (pid, sid) = (clean(pid, 24), clean(sid, 24));
    let (m, cv) = st();
    let mut s = lock(m);
    if s.token.is_empty() || clean(k, 64) != s.token { return js(403, json!({ "ok": false, "reason": "key" })); }
    let t0 = Instant::now();
    loop {
        match s.phones.get_mut(&pid) {
            None => return js(404, json!({ "ok": false })),
            Some(p) if p.sid != sid => return js(409, json!({ "ok": false })),
            Some(p) => {
                p.seen = Instant::now();
                if !p.q.is_empty() { return js(200, json!({ "ok": true, "m": std::mem::take(&mut p.q) })); }
            }
        }
        if stop.load(Ordering::SeqCst) || t0.elapsed() > Duration::from_secs(20) { return js(200, json!({ "ok": true, "m": [] })); }
        s = cv.wait_timeout(s, Duration::from_millis(1000)).map(|r| r.0).unwrap_or_else(|e| e.into_inner().0);
    }
}

/* ----------------------------------------------------------------- firewall */
// Windows asks once whether Prism Cam may accept connections. If that question was dismissed, Windows adds a BLOCK rule
// for the exe, and phones can't reach the page. "Fix" (one UAC prompt) removes the rules for this exe and allows it.
fn netsh(args: &[&str]) -> bool { std::process::Command::new("netsh").args(args).creation_flags(NO_WINDOW).status().map(|s| s.success()).unwrap_or(false) }
/// Will Windows Firewall let a phone in? Counts the enabled inbound rules for this exe (block / allow that covers the
/// network type in use) and whether the firewall is on for that network type. PowerShell objects are not translated,
/// so this works on a Thai Windows too (netsh's text output is).
pub fn fw_status() -> Value {
    let exe = std::env::current_exe().unwrap_or_default().to_string_lossy().replace('\'', "''");
    let ps = format!(
        "$ErrorActionPreference='SilentlyContinue'; \
         $c = \"$((Get-NetConnectionProfile | Where-Object IPv4Connectivity -ne 'Disconnected' | Select-Object -First 1).NetworkCategory)\" -replace 'Authenticated',''; \
         if (-not $c) {{ $c = 'Public' }}; \
         $on = [bool]((Get-NetFirewallProfile -Name $c).Enabled -eq 'True'); \
         $f = @(Get-NetFirewallApplicationFilter -Program '{exe}' | Get-NetFirewallRule | Where-Object {{ \"$($_.Direction)\" -eq 'Inbound' -and \"$($_.Enabled)\" -eq 'True' }}); \
         $cov = {{ param($r) $p = \"$($r.Profile)\"; $p -eq 'Any' -or $p -match $c }}; \
         $b = @($f | Where-Object {{ \"$($_.Action)\" -eq 'Block' -and (& $cov $_) }}).Count; \
         $a = @($f | Where-Object {{ \"$($_.Action)\" -eq 'Allow' -and (& $cov $_) }}).Count; \
         @{{ cat = $c; on = $on; block = $b; allow = $a }} | ConvertTo-Json -Compress");
    let out = std::process::Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &ps]).creation_flags(NO_WINDOW).output();
    let Ok(out) = out else { return json!({ "ok": false }) };
    let v: Value = serde_json::from_slice(String::from_utf8_lossy(&out.stdout).trim().as_bytes()).unwrap_or(Value::Null);
    if v.is_null() { return json!({ "ok": false }); }
    let (on, block, allow) = (v["on"].as_bool().unwrap_or(true), v["block"].as_i64().unwrap_or(0), v["allow"].as_i64().unwrap_or(0));
    log(&format!("firewall {} on={on} block={block} allow={allow}", v["cat"].as_str().unwrap_or("?")));
    // blocked = a phone can't get in; unknown = no rule yet (Windows asks the first time, or a third-party firewall decides)
    json!({ "ok": true, "cat": v["cat"], "on": on, "block": block, "allow": allow, "need": on && (block > 0 || allow == 0), "blocked": on && block > 0 })
}
pub fn fw_elevated() -> i32 {
    let exe = std::env::current_exe().unwrap_or_default().to_string_lossy().to_string();
    let _ = netsh(&["advfirewall", "firewall", "delete", "rule", &format!("name={FW_RULE}")]);
    let _ = netsh(&["advfirewall", "firewall", "delete", "rule", "name=all", "dir=in", &format!("program={exe}")]);
    let a = netsh(&["advfirewall", "firewall", "add", "rule", &format!("name={FW_RULE}"), "dir=in", "action=allow", &format!("program={exe}"), "enable=yes", "profile=any"]);
    let b = netsh(&["advfirewall", "firewall", "add", "rule", &format!("name={FW_RULE}"), "dir=in", "action=allow", "protocol=TCP", &format!("localport={}-{}", PORT0, PORT0 + PORTS - 1), "enable=yes", "profile=any"]);
    if a && b { 0 } else { 1 }
}
pub fn fw_fix() -> Value {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    let exe = HSTRING::from(std::env::current_exe().unwrap_or_default().as_os_str());
    let mut info = SHELLEXECUTEINFOW { cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32, fMask: SEE_MASK_NOCLOSEPROCESS, lpVerb: w!("runas"), lpFile: PCWSTR(exe.as_ptr()), lpParameters: w!("--phone-firewall"), nShow: 0, ..Default::default() };
    unsafe {
        if ShellExecuteExW(&mut info).is_err() || info.hProcess.is_invalid() { return json!({ "ok": false, "reason": "denied" }); }
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut code = 1u32;
        let _ = GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);
        log(&format!("firewall fix exit={code}"));
        json!({ "ok": code == 0 })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn civil_dates() {
        assert_eq!(super::civil(0), (1970, 1, 1));
        assert_eq!(super::civil(20_415), (2025, 11, 23));
        assert_eq!(super::civil(19_782), (2024, 2, 29));
    }
}
