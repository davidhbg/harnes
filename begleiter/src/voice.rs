//! Sprache: Zuhören mit der Spracherkennung von Windows (de-DE), Sprechen mit den Windows-Stimmen.
//! Beides läuft in eigenen Threads; das Hauptprogramm schickt Befehle und bekommt Ereignisse.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows::core::{Interface, HSTRING};
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Globalization::Language;
use windows::Media::Core::MediaSource;
use windows::Media::Playback::{MediaPlaybackState, MediaPlayer};
use windows::Media::SpeechRecognition::*;
use windows::Media::SpeechSynthesis::SpeechSynthesizer;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

pub enum Heard {
    Hypothesis(String),
    Final(String),
    Stopped,
    Error(String),
}

pub enum ListenCmd {
    Start,
    Stop,
}

/// Startet den Zuhör-Thread. `send` leitet Ereignisse an das Hauptprogramm weiter.
pub fn start_listener(send: impl Fn(Heard) + Send + Sync + Clone + 'static) -> Sender<ListenCmd> {
    let (tx, rx) = channel::<ListenCmd>();
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        // Erst die Online-Erkennung von Windows (beste Qualität); ist sie aus, die Offline-Erkennung
        let mut online = setup_recognizer(send.clone()).ok();
        let mut offline: Option<std::process::ChildStdin> = None;
        let mut running = false;
        for cmd in rx {
            match cmd {
                ListenCmd::Start if !running => {
                    if let Some(session) = &online {
                        match session.StartAsync().and_then(|a| a.get()) {
                            Ok(()) => {
                                running = true;
                                continue;
                            }
                            Err(_) => online = None, // z. B. Datenschutz: Online-Spracherkennung aus
                        }
                    }
                    if offline.is_none() {
                        match start_offline(send.clone()) {
                            Ok(stdin) => offline = Some(stdin),
                            Err(e) => {
                                send(Heard::Error(e));
                                continue;
                            }
                        }
                    }
                    if let Some(stdin) = &mut offline {
                        use std::io::Write;
                        if writeln!(stdin, "start").is_ok() {
                            running = true;
                        } else {
                            offline = None;
                            send(Heard::Error("Offline-Zuhören wurde beendet.".into()));
                        }
                    }
                }
                ListenCmd::Stop if running => {
                    running = false;
                    if let Some(session) = &online {
                        let _ = session.StopAsync().and_then(|a| a.get());
                        send(Heard::Stopped);
                    } else if let Some(stdin) = &mut offline {
                        use std::io::Write;
                        let _ = writeln!(stdin, "stop"); // das Hilfsprogramm meldet „S“, wenn es fertig ist
                    } else {
                        send(Heard::Stopped);
                    }
                }
                ListenCmd::Stop => send(Heard::Stopped),
                _ => {}
            }
        }
    });
    tx
}

/// Offline-Zuhören: kleines C#-Programm mit der klassischen Windows-Spracherkennung.
/// Wird beim ersten Mal mit dem C#-Übersetzer von Windows gebaut (nichts zu installieren).
fn start_offline(send: impl Fn(Heard) + Send + Sync + Clone + 'static) -> Result<std::process::ChildStdin, String> {
    use std::io::BufRead;
    use std::os::windows::process::CommandExt;
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    let dir = format!(r"{base}\Harnes");
    let exe = format!(r"{dir}\harnes-hoeren-1.exe");
    if !std::path::Path::new(&exe).exists() {
        let _ = std::fs::create_dir_all(&dir);
        let src = format!(r"{dir}\harnes-hoeren-1.cs");
        std::fs::write(&src, include_str!("hoeren.cs")).map_err(|e| e.to_string())?;
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let csc = format!(r"{root}\Microsoft.NET\Framework64\v4.0.30319\csc.exe");
        let speech = format!(r"{root}\Microsoft.NET\Framework64\v4.0.30319\WPF\System.Speech.dll");
        let ok = std::process::Command::new(&csc)
            .args(["/nologo", "/target:exe", "/optimize", &format!("/out:{exe}"), &format!("/r:{speech}"), &src])
            .creation_flags(0x0800_0000)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !ok {
            return Err("Die Online-Spracherkennung von Windows ist aus, und die Offline-Erkennung ließ sich nicht einrichten.".into());
        }
    }
    let mut child = std::process::Command::new(&exe)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .creation_flags(0x0800_0000)
        .spawn()
        .map_err(|e| format!("Offline-Zuhören startete nicht: {e}"))?;
    let stdout = child.stdout.take().ok_or("keine Ausgabe")?;
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
            let (kind, text) = line.split_at(line.find(' ').unwrap_or(line.len()));
            let text = text.trim().to_string();
            match kind {
                "H" => send(Heard::Hypothesis(text)),
                "F" => send(Heard::Final(text)),
                "S" => send(Heard::Stopped),
                "E" => send(Heard::Error(text)),
                _ => {}
            }
        }
    });
    child.stdin.take().ok_or_else(|| "kein Eingang".into())
}

fn setup_recognizer(send: impl Fn(Heard) + Send + Sync + Clone + 'static) -> windows::core::Result<SpeechContinuousRecognitionSession> {
    let lang = Language::CreateLanguage(&HSTRING::from("de-DE"))?;
    let rec = SpeechRecognizer::Create(&lang)?;
    let topic = SpeechRecognitionTopicConstraint::Create(SpeechRecognitionScenario::Dictation, &HSTRING::from("Diktat"))?;
    rec.Constraints()?.Append(&topic.cast::<ISpeechRecognitionConstraint>()?)?;
    let res = rec.CompileConstraintsAsync()?.get()?;
    if res.Status()? != SpeechRecognitionResultStatus::Success {
        return Err(windows::core::Error::new(windows::Win32::Foundation::E_FAIL, format!("Status {:?}", res.Status()?)));
    }
    let s1 = send.clone();
    rec.HypothesisGenerated(&TypedEventHandler::new(move |_: &Option<SpeechRecognizer>, a: &Option<SpeechRecognitionHypothesisGeneratedEventArgs>| {
        if let Some(a) = a {
            s1(Heard::Hypothesis(a.Hypothesis()?.Text()?.to_string()));
        }
        Ok(())
    }))?;
    let session = rec.ContinuousRecognitionSession()?;
    // lange Pausen beim Nachdenken nicht als Ende werten
    session.SetAutoStopSilenceTimeout(TimeSpan { Duration: 60 * 10_000_000 })?;
    let s2 = send.clone();
    session.ResultGenerated(&TypedEventHandler::new(move |_: &Option<SpeechContinuousRecognitionSession>, a: &Option<SpeechContinuousRecognitionResultGeneratedEventArgs>| {
        if let Some(a) = a {
            let r = a.Result()?;
            if r.Status()? == SpeechRecognitionResultStatus::Success && r.Confidence()? != SpeechRecognitionConfidence::Rejected {
                let t = r.Text()?.to_string();
                if !t.trim().is_empty() {
                    s2(Heard::Final(t));
                }
            }
        }
        Ok(())
    }))?;
    // den Erkenner am Leben halten (die Sitzung gehört zu ihm)
    std::mem::forget(rec);
    Ok(session)
}

// ---------------------------------------------------------------- Sprechen

/// Was der Sprecher der Reihe nach abarbeitet: sprechen oder zeigen. Gezeigt wird genau dann,
/// wenn der Satz davor gesprochen ist – so passen Zeiger und Stimme zusammen.
pub enum Act {
    Say(String),
    Show(f32, f32, String),
    End,
}

pub struct Speaker {
    pub tx: Sender<Act>,
    pub stop: Arc<AtomicBool>,
    pub muted: Arc<AtomicBool>,
}

pub enum SpeakEv {
    Saying(String),
    Show(f32, f32, String),
    Finished,
}

pub fn start_speaker(send: impl Fn(SpeakEv) + Send + 'static) -> Speaker {
    let (tx, rx) = channel::<Act>();
    let stop = Arc::new(AtomicBool::new(false));
    let muted = Arc::new(AtomicBool::new(false));
    let (st, mu) = (stop.clone(), muted.clone());
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let synth = SpeechSynthesizer::new().ok();
        if let Some(s) = &synth {
            pick_voice(s);
            if let Ok(o) = s.Options() {
                let _ = o.SetSpeakingRate(1.08);
            }
        }
        let player = MediaPlayer::new().ok();
        speaker_loop(rx, &send, synth, player, st, mu);
    });
    Speaker { tx, stop, muted }
}

fn pick_voice(s: &SpeechSynthesizer) {
    let Ok(all) = SpeechSynthesizer::AllVoices() else { return };
    let mut best: Option<(i32, windows::Media::SpeechSynthesis::VoiceInformation)> = None;
    for v in all {
        let lang = v.Language().map(|l| l.to_string()).unwrap_or_default();
        let name = v.DisplayName().map(|l| l.to_string()).unwrap_or_default();
        if lang.eq_ignore_ascii_case("de-DE") {
            let score = if name.contains("Katja") { 3 } else if name.contains("Hedda") { 2 } else { 1 };
            if best.as_ref().map(|(sc, _)| score > *sc).unwrap_or(true) {
                best = Some((score, v));
            }
        }
    }
    if let Some((_, v)) = best {
        let _ = s.SetVoice(&v);
    }
}

fn speaker_loop(rx: Receiver<Act>, send: &impl Fn(SpeakEv), synth: Option<SpeechSynthesizer>, player: Option<MediaPlayer>, stop: Arc<AtomicBool>, muted: Arc<AtomicBool>) {
    for act in rx {
        if stop.load(Ordering::SeqCst) {
            // unterbrochen: alles bis zum Ende dieser Antwort verwerfen
            if let Act::End = act {
                stop.store(false, Ordering::SeqCst);
                send(SpeakEv::Finished);
            }
            continue;
        }
        match act {
            Act::Show(x, y, label) => send(SpeakEv::Show(x, y, label)),
            Act::End => send(SpeakEv::Finished),
            Act::Say(text) => {
                send(SpeakEv::Saying(text.clone()));
                if muted.load(Ordering::SeqCst) {
                    let until = Instant::now() + Duration::from_millis(600 + text.len() as u64 * 45);
                    while Instant::now() < until && !stop.load(Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(30));
                    }
                    continue;
                }
                if let (Some(s), Some(p)) = (&synth, &player) {
                    let _ = say(s, p, &text, &stop);
                }
            }
        }
    }
}

fn say(s: &SpeechSynthesizer, p: &MediaPlayer, text: &str, stop: &AtomicBool) -> windows::core::Result<()> {
    let stream = s.SynthesizeTextToStreamAsync(&HSTRING::from(text))?.get()?;
    let source = MediaSource::CreateFromStream(&stream, &stream.ContentType()?)?;
    p.SetSource(&source)?;
    p.Play()?;
    let session = p.PlaybackSession()?;
    let started = Instant::now();
    let mut seen_playing = false;
    loop {
        std::thread::sleep(Duration::from_millis(25));
        if stop.load(Ordering::SeqCst) {
            p.Pause()?;
            break;
        }
        let state = session.PlaybackState()?;
        if state == MediaPlaybackState::Playing {
            seen_playing = true;
            let pos = session.Position()?.Duration;
            let dur = session.NaturalDuration()?.Duration;
            if dur > 0 && pos >= dur - 200_000 {
                std::thread::sleep(Duration::from_millis(30));
                break;
            }
        } else if seen_playing || started.elapsed() > Duration::from_secs(8) {
            break;
        }
    }
    Ok(())
}
