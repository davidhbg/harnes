//! Empfang für Meldungen von Harnes: ein winziger HTTP-Server nur auf 127.0.0.1 mit eigenem
//! Zugangsschlüssel. Port und Schlüssel stehen in ~/.remoteharnes/begleiter-verbindung.json.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;

/// 32 Zufallsbytes aus dem Zufallsgenerator von Windows (BCryptGenRandom), als Hex
fn token() -> Option<String> {
    use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_ALG_HANDLE, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
    let mut buf = [0u8; 32];
    unsafe { BCryptGenRandom(BCRYPT_ALG_HANDLE::default(), &mut buf, BCRYPT_USE_SYSTEM_PREFERRED_RNG) }.ok().ok()?;
    Some(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Vergleich in fester Zeit
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn conn_file() -> String {
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
    format!(r"{home}\.remoteharnes\begleiter-verbindung.json")
}

/// Startet den Empfang. `on` bekommt (Titel, Text) jeder Meldung.
pub fn start(on: impl Fn(String, String) + Send + 'static) {
    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else { return };
    let Ok(addr) = listener.local_addr() else { return };
    let port = addr.port();
    // ohne sicheren Zufall kein Empfang
    let Some(tok) = token() else { return };
    let _ = std::fs::write(conn_file(), serde_json::json!({ "port": addr.port(), "token": tok, "pid": std::process::id() }).to_string());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(3)));
            let mut reader = BufReader::new(&stream);
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            let ok_path = line.starts_with("POST /melden ");
            let (mut len, mut auth, mut host_ok) = (0usize, false, true);
            loop {
                let mut h = String::new();
                if reader.read_line(&mut h).is_err() || h.trim().is_empty() {
                    break;
                }
                let lower = h.to_ascii_lowercase();
                if let Some(v) = lower.strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                } else if let Some(v) = h.strip_prefix("authorization:").or_else(|| h.strip_prefix("Authorization:")) {
                    auth = same(v.trim(), &format!("Bearer {tok}"));
                } else if let Some(v) = lower.strip_prefix("host:") {
                    let v = v.trim();
                    host_ok = v == format!("127.0.0.1:{port}") || v == format!("localhost:{port}");
                }
            }
            let mut body = vec![0u8; len.min(16_384)];
            let _ = reader.read_exact(&mut body);
            let status = if !ok_path { "404 Not Found" } else if !auth || !host_ok { "403 Forbidden" } else { "200 OK" };
            if status == "200 OK" {
                if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&body) {
                    let t = v["titel"].as_str().unwrap_or("Harnes").chars().take(80).collect();
                    let x = v["text"].as_str().unwrap_or("").chars().take(300).collect();
                    on(t, x);
                }
            }
            let mut s = &stream;
            let _ = write!(s, "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        }
    });
}

/// Beim Beenden die Verbindungsdatei entfernen.
pub fn stop() {
    let _ = std::fs::remove_file(conn_file());
}
