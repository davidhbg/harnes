//! Der Kopf des Begleiters: das echte Claude Code (Abo) im Druckmodus. Frage und Bildschirmfoto gehen
//! als JSON hinein, die Antwort kommt Stück für Stück zurück. Zeigestellen stehen als [ZEIGE:x,y:Name]
//! im Text und werden herausgelöst. Anmeldedaten liest der Begleiter nie – er startet nur claude.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use crate::screen::Shot;

pub enum Piece {
    /// Text zum Sprechen (ein Satz oder Satzteil)
    Say(String),
    /// Zeigestelle in Bildkoordinaten
    Point(f32, f32, String),
    Session(String),
    Done,
    Error(String),
}

pub fn find_claude() -> Option<String> {
    if let Ok(home) = std::env::var("USERPROFILE") {
        let p = format!(r"{home}\.local\bin\claude.exe");
        if std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }
    let path = std::env::var("PATH").unwrap_or_default();
    for dir in path.split(';') {
        let p = std::path::Path::new(dir).join("claude.exe");
        if p.exists() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    None
}

fn system_prompt(user: &str, w: u32, h: u32) -> String {
    format!(
        "Du bist Harnes, ein freundlicher Begleiter, der als kleiner Zeiger neben der Maus von {user} lebt. \
Du siehst ein Bildschirmfoto seines Bildschirms ({w}×{h} Pixel) und hörst seine gesprochene Frage. \
Antworte auf Deutsch so, wie man spricht: kurz (meist 1 bis 4 Sätze), locker, ohne Markdown, ohne Listen, ohne Emojis. \
Wenn du auf etwas auf dem Bildschirm hinweist, nenne es im Satz mit seinem sichtbaren Namen und setze direkt dahinter eine Markierung \
[ZEIGE:x,y:kurzer Name] mit den Pixelkoordinaten der Mitte des Elements im Bildschirmfoto, zum Beispiel: Klick oben rechts auf „Teilen“ [ZEIGE:812,40:Teilen]. \
Die Markierung wird nicht vorgelesen; dein Zeiger fliegt hin, \
während du den Satz sprichst. Höchstens 4 Markierungen. Wenn auf dem Bild nichts passt, sag das ehrlich. \
Benutze keine Werkzeuge, antworte direkt."
    )
}

/// Startet eine Anfrage im Hintergrund. Liefert Stücke über `tx` (Satz für Satz, Zeigestellen dazwischen).
pub fn ask(question: String, shot: &Shot, resume: Option<String>, model: String, user: String, tx: impl Fn(Piece) + Send + 'static) {
    let image = shot.png_base64.clone();
    let (w, h) = (shot.w, shot.h);
    std::thread::spawn(move || {
        let Some(exe) = find_claude() else {
            tx(Piece::Error("Claude Code ist nicht installiert (claude.exe nicht gefunden).".into()));
            return;
        };
        let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
        let dir = format!(r"{home}\.remoteharnes\begleiter");
        let _ = std::fs::create_dir_all(&dir);
        let mut cmd = Command::new(exe);
        cmd.args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--model",
            &model,
            "--strict-mcp-config",
            "--mcp-config",
            r#"{"mcpServers":{}}"#,
            "--append-system-prompt",
            &system_prompt(&user, w, h),
            "--disallowedTools",
            "Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite",
        ]);
        if let Some(id) = &resume {
            cmd.args(["--resume", id]);
        }
        // Läuft der Begleiter innerhalb einer Claude-Code-Sitzung (Tests), deren Variablen entfernen
        for (k, _) in std::env::vars() {
            if k == "CLAUDECODE" || k == "CLAUDE_PID" || k == "CLAUDE_EFFORT" || k.starts_with("CLAUDE_CODE_") || k.starts_with("CLAUDE_AGENT_SDK_") || k == "ANTHROPIC_BASE_URL" {
                cmd.env_remove(k);
            }
        }
        use std::os::windows::process::CommandExt;
        cmd.current_dir(&dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).creation_flags(0x0800_0000); // ohne Konsolenfenster
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                tx(Piece::Error(format!("Claude ließ sich nicht starten: {e}")));
                return;
            }
        };
        let msg = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [
                { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": image } },
                { "type": "text", "text": question }
            ]}
        });
        if let Some(mut stdin) = child.stdin.take() {
            let _ = writeln!(stdin, "{msg}");
        }
        let stdout = child.stdout.take().unwrap();
        let mut parser = TagParser::default();
        let mut got_text = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            match v["type"].as_str() {
                Some("system") => {
                    if let Some(id) = v["session_id"].as_str() {
                        tx(Piece::Session(id.to_string()));
                    }
                }
                Some("stream_event") => {
                    let ev = &v["event"];
                    if ev["type"] == "content_block_delta" && ev["delta"]["type"] == "text_delta" {
                        if let Some(t) = ev["delta"]["text"].as_str() {
                            got_text = true;
                            for p in parser.push(t) {
                                tx(p);
                            }
                        }
                    }
                }
                Some("result") => {
                    if v["is_error"].as_bool() == Some(true) {
                        tx(Piece::Error(v["result"].as_str().unwrap_or("Claude hat einen Fehler gemeldet.").to_string()));
                    } else if !got_text {
                        if let Some(t) = v["result"].as_str() {
                            for p in parser.push(t) {
                                tx(p);
                            }
                        }
                    }
                    break;
                }
                _ => {}
            }
        }
        for p in parser.flush() {
            tx(p);
        }
        let mut err = String::new();
        if let Some(mut e) = child.stderr.take() {
            use std::io::Read;
            let _ = e.read_to_string(&mut err);
        }
        let status = child.wait();
        if !got_text && status.map(|s| !s.success()).unwrap_or(true) {
            let hint = err.lines().last().unwrap_or("").to_string();
            tx(Piece::Error(format!("Claude hat nicht geantwortet. {hint}")));
        }
        tx(Piece::Done);
    });
}

/// Zerlegt den Antwortstrom in Sätze und Zeigestellen.
#[derive(Default)]
pub struct TagParser {
    buf: String,
    sentence: String,
}

impl TagParser {
    pub fn push(&mut self, t: &str) -> Vec<Piece> {
        self.buf.push_str(t);
        let mut out = Vec::new();
        loop {
            if let Some(start) = self.buf.find('[') {
                // Text vor der Markierung
                let before: String = self.buf.drain(..start).collect();
                self.add_text(&before, &mut out);
                if let Some(end) = self.buf.find(']') {
                    let tag: String = self.buf.drain(..=end).collect();
                    if let Some(p) = parse_tag(&tag) {
                        // erst den angefangenen Satz bis hierher sprechen, dann zeigen
                        self.flush_sentence(&mut out);
                        out.push(p);
                    } else {
                        self.add_text(&tag, &mut out);
                    }
                    continue;
                }
                // Markierung noch unvollständig: warten (außer sie ist offensichtlich keine)
                if self.buf.len() > 80 {
                    let t: String = self.buf.drain(..1).collect();
                    self.add_text(&t, &mut out);
                    continue;
                }
                break;
            } else {
                let rest = std::mem::take(&mut self.buf);
                self.add_text(&rest, &mut out);
                break;
            }
        }
        out
    }

    fn add_text(&mut self, t: &str, out: &mut Vec<Piece>) {
        for ch in t.chars() {
            self.sentence.push(ch);
            if matches!(ch, '.' | '!' | '?' | '\n' | ':') && self.sentence.trim().chars().count() > 12 {
                self.flush_sentence(out);
            }
        }
    }

    fn flush_sentence(&mut self, out: &mut Vec<Piece>) {
        let s = self.sentence.trim().replace(['*', '#', '`'], "");
        self.sentence.clear();
        if !s.is_empty() {
            out.push(Piece::Say(s));
        }
    }

    pub fn flush(&mut self) -> Vec<Piece> {
        let mut out = Vec::new();
        let rest = std::mem::take(&mut self.buf);
        self.add_text(&rest, &mut out);
        self.flush_sentence(&mut out);
        out
    }
}

fn parse_tag(tag: &str) -> Option<Piece> {
    let inner = tag.trim_start_matches('[').trim_end_matches(']');
    let rest = inner.strip_prefix("ZEIGE:").or_else(|| inner.strip_prefix("POINT:"))?;
    let mut parts = rest.splitn(3, [',', ':']);
    let x: f32 = parts.next()?.trim().parse().ok()?;
    let y: f32 = parts.next()?.trim().parse().ok()?;
    let label = parts.next().unwrap_or("").trim().to_string();
    Some(Piece::Point(x, y, label))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn says(ps: &[Piece]) -> Vec<String> {
        ps.iter()
            .map(|p| match p {
                Piece::Say(s) => format!("S:{s}"),
                Piece::Point(x, y, l) => format!("P:{x},{y}:{l}"),
                _ => String::new(),
            })
            .collect()
    }

    #[test]
    fn zerlegt_saetze_und_zeigestellen() {
        let mut p = TagParser::default();
        let mut all = Vec::new();
        for chunk in ["Oben rechts siehst du ", "den Knopf [ZEI", "GE:812,40:Teilen] zum Teilen. ", "Fertig!"] {
            all.extend(p.push(chunk));
        }
        all.extend(p.flush());
        assert_eq!(says(&all), vec!["S:Oben rechts siehst du den Knopf", "P:812,40:Teilen", "S:zum Teilen. Fertig!"]);
    }
}
