//! Harnes Begleiter: ein kleiner Zeiger, der neben der Maus lebt. Strg+Alt halten und sprechen –
//! er sieht den Bildschirm, antwortet mit Stimme und fliegt auf die Stellen, um die es geht.
//! Zweimal kurz Strg+Alt: Gesprächsmodus (einfach reden, wie in ChatGPT oder Claude).
//! Strg+Alt+Q beendet, Strg+Alt+M schaltet die Stimme stumm, Strg+Alt+B blendet den Zeiger aus.
#![windows_subsystem = "windows"]

mod brain;
mod draw;
mod notify;
mod screen;
mod voice;

use std::sync::atomic::Ordering;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tiny_skia::Pixmap;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::HiDpi::{GetDpiForSystem, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::draw::*;
use crate::screen::Shot;
use crate::voice::{Act, Heard, ListenCmd, SpeakEv};

// ---------------------------------------------------------------- Ereignisse an das Hauptprogramm

enum Ev {
    Heard(Heard),
    Brain(u32, brain::Piece),
    Speak(SpeakEv),
    HoldStart,
    HoldEnd,
    DoubleTap,
    Quit,
    Mute,
    Hide,
    Ask(String),
    Notify(String, String),
}

static TX: OnceLock<Mutex<Sender<Ev>>> = OnceLock::new();
static HWND_MAIN: OnceLock<isize> = OnceLock::new();
const WM_EV: u32 = WM_APP + 1;

fn post(ev: Ev) {
    if let Some(tx) = TX.get() {
        let _ = tx.lock().unwrap().send(ev);
    }
    if let Some(h) = HWND_MAIN.get() {
        unsafe {
            let _ = PostMessageW(HWND(*h as *mut _), WM_EV, WPARAM(0), LPARAM(0));
        }
    }
}

fn log(msg: &str) {
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
    let dir = format!(r"{home}\.remoteharnes\begleiter");
    let _ = std::fs::create_dir_all(&dir);
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(format!(r"{dir}\log.txt")) {
        let _ = writeln!(f, "{:?} {msg}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
    }
}

// ---------------------------------------------------------------- Tasten (Strg+Alt halten / zweimal tippen)

#[derive(Default)]
struct Keys {
    ctrl: bool,
    alt: bool,
    since: Option<Instant>,
    other: bool,
    holding: bool,
    last_tap: Option<Instant>,
}

static KEYS: Mutex<Keys> = Mutex::new(Keys { ctrl: false, alt: false, since: None, other: false, holding: false, last_tap: None });
const HOLD_MS: u128 = 320;

unsafe extern "system" fn key_hook(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code >= 0 {
        let k = unsafe { &*(lp.0 as *const KBDLLHOOKSTRUCT) };
        let down = wp.0 as u32 == WM_KEYDOWN || wp.0 as u32 == WM_SYSKEYDOWN;
        let vk = VIRTUAL_KEY(k.vkCode as u16);
        let is_ctrl = matches!(vk, VK_LCONTROL | VK_RCONTROL | VK_CONTROL);
        let is_alt = matches!(vk, VK_LMENU | VK_RMENU | VK_MENU);
        let mut st = KEYS.lock().unwrap();
        if is_ctrl || is_alt {
            if is_ctrl {
                st.ctrl = down;
            } else {
                st.alt = down;
            }
            if st.ctrl && st.alt && st.since.is_none() {
                st.since = Some(Instant::now());
                st.other = false;
            }
            if !down && st.since.is_some() {
                let since = st.since.take().unwrap();
                if st.holding {
                    st.holding = false;
                    post(Ev::HoldEnd);
                } else if !st.other && since.elapsed().as_millis() < HOLD_MS {
                    if st.last_tap.map(|t| t.elapsed().as_millis() < 450).unwrap_or(false) {
                        st.last_tap = None;
                        post(Ev::DoubleTap);
                    } else {
                        st.last_tap = Some(Instant::now());
                    }
                }
            }
        } else if down && st.since.is_some() {
            // Strg+Alt+Taste: Kürzel (auch AltGr-Zeichen wie @) – kein Zuhören
            st.other = true;
            if !st.holding {
                match vk {
                    VK_Q => post(Ev::Quit),
                    VK_M => post(Ev::Mute),
                    VK_B => post(Ev::Hide),
                    _ => {}
                }
            }
        }
    }
    unsafe { CallNextHookEx(HHOOK::default(), code, wp, lp) }
}

fn check_hold() {
    let mut st = KEYS.lock().unwrap();
    if let Some(since) = st.since {
        if !st.other && !st.holding && since.elapsed().as_millis() >= HOLD_MS {
            st.holding = true;
            drop(st);
            post(Ev::HoldStart);
        }
    }
}

// ---------------------------------------------------------------- Zustand

#[derive(PartialEq, Clone, Copy)]
enum Phase {
    Idle,
    Listening,
    Finishing,
    Thinking,
    Speaking,
}

struct Fly {
    from: (f32, f32),
    to: (f32, f32),
    t0: Instant,
    ms: f32,
}

struct Bubble {
    title: String,
    text: String,
    until: Option<Instant>,
}

const W: i32 = 680;
const H: i32 = 420;

struct App {
    hwnd: HWND,
    painter: Painter,
    pm: Pixmap,
    mem_dc: HDC,
    bits: *mut u8,
    scale: f32,
    buddy: (f32, f32),
    fly: Option<Fly>,
    hold_point_until: Option<Instant>,
    phase: Phase,
    bubble: Option<Bubble>,
    heard: String,
    hypothesis: String,
    finishing_until: Option<Instant>,
    conv: bool,
    hidden: bool,
    answer: String,
    shot: Option<Shot>,
    session: Option<(String, Instant)>,
    generation: u32,
    speaker: voice::Speaker,
    listen: Sender<ListenCmd>,
    model: String,
    user: String,
    started: Instant,
    /// Meldung von Harnes, die gerade vorgelesen wird (Titel, Text)
    notice: Option<(String, String)>,
}

fn cursor() -> (f32, f32) {
    let mut p = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut p);
    }
    (p.x as f32, p.y as f32)
}

fn read_settings() -> (String, String) {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let mut model = "sonnet".to_string();
    let mut user = std::env::var("USERNAME").unwrap_or_else(|_| "dir".into());
    if let Ok(s) = std::fs::read_to_string(format!(r"{home}\.remoteharnes\begleiter.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            if let Some(m) = v["modell"].as_str() {
                model = m.to_string();
            }
        }
    }
    if let Ok(s) = std::fs::read_to_string(format!(r"{home}\.remoteharnes\config.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            if let Some(b) = v["benutzer"].as_str() {
                if !b.trim().is_empty() {
                    user = b.to_string();
                }
            }
        }
    }
    (model, user)
}

impl App {
    fn say_bubble(&mut self, title: &str, text: &str, secs: Option<f32>) {
        self.bubble = Some(Bubble { title: title.into(), text: text.into(), until: secs.map(|s| Instant::now() + Duration::from_secs_f32(s)) });
    }

    fn start_listening(&mut self) {
        if matches!(self.phase, Phase::Thinking | Phase::Speaking) {
            self.interrupt();
        }
        self.heard.clear();
        self.hypothesis.clear();
        self.phase = Phase::Listening;
        self.say_bubble("Ich höre zu …", if self.conv { "Gesprächsmodus – sprich einfach." } else { "Sprich, solange du Strg+Alt hältst." }, None);
        let _ = self.listen.send(ListenCmd::Start);
    }

    fn interrupt(&mut self) {
        // laufende Antwort abbrechen (wie in ChatGPT: reinreden)
        self.generation += 1;
        self.speaker.stop.store(true, Ordering::SeqCst);
        let _ = self.speaker.tx.send(Act::End);
        self.notice = None;
        self.fly = None;
        self.phase = Phase::Idle;
    }

    fn ask(&mut self, question: String) {
        let question = question.trim().to_string();
        if question.is_empty() {
            self.phase = Phase::Idle;
            self.say_bubble("Hm?", "Ich habe nichts verstanden.", Some(2.5));
            if self.conv {
                self.start_listening();
            }
            return;
        }
        log(&format!("Frage: {question}"));
        // der Zeiger selbst soll nicht auf dem Foto sein
        unsafe {
            let _ = SetWindowDisplayAffinity(self.hwnd, WDA_EXCLUDEFROMCAPTURE);
        }
        let shot = screen::capture(1366);
        unsafe {
            let _ = SetWindowDisplayAffinity(self.hwnd, WDA_NONE);
        }
        let Some(shot) = shot else {
            self.say_bubble("Fehler", "Bildschirmfoto ging nicht.", Some(4.0));
            self.phase = Phase::Idle;
            return;
        };
        self.generation += 1;
        let generation = self.generation;
        self.phase = Phase::Thinking;
        self.answer.clear();
        self.say_bubble("Moment …", &question, None);
        // innerhalb von 10 Minuten geht das Gespräch weiter
        let resume = self.session.as_ref().filter(|(_, t)| t.elapsed() < Duration::from_secs(600)).map(|(s, _)| s.clone());
        brain::ask(question, &shot, resume, self.model.clone(), self.user.clone(), move |p| post(Ev::Brain(generation, p)));
        self.shot = Some(shot);
    }

    fn handle(&mut self, ev: Ev) {
        match ev {
            Ev::HoldStart => self.start_listening(),
            Ev::HoldEnd => {
                if self.phase == Phase::Listening && !self.conv {
                    self.phase = Phase::Finishing;
                    self.finishing_until = Some(Instant::now() + Duration::from_millis(1500));
                    let _ = self.listen.send(ListenCmd::Stop);
                }
            }
            Ev::DoubleTap => {
                self.conv = !self.conv;
                if self.conv {
                    self.start_listening();
                    self.say_bubble("Gesprächsmodus an", "Sprich einfach los. Zweimal Strg+Alt tippen beendet ihn.", None);
                } else {
                    let _ = self.listen.send(ListenCmd::Stop);
                    if self.phase == Phase::Listening {
                        self.phase = Phase::Idle;
                    }
                    self.say_bubble("Gesprächsmodus aus", "Strg+Alt halten, wenn du wieder etwas wissen willst.", Some(3.0));
                }
            }
            Ev::Quit => unsafe {
                PostQuitMessage(0);
            },
            Ev::Mute => {
                let m = !self.speaker.muted.load(Ordering::SeqCst);
                self.speaker.muted.store(m, Ordering::SeqCst);
                self.say_bubble(if m { "Stumm" } else { "Ton an" }, if m { "Ich antworte nur noch in der Sprechblase." } else { "Ich spreche wieder." }, Some(2.5));
            }
            Ev::Ask(q) => self.ask(q),
            Ev::Notify(titel, text) => {
                log(&format!("Meldung: {titel}"));
                self.say_bubble(&titel, &text, Some(10.0));
                // nur vorlesen, wenn gerade nichts anderes läuft
                if self.phase == Phase::Idle && !self.hidden {
                    self.notice = Some((titel.clone(), text));
                    self.answer.clear();
                    let _ = self.speaker.tx.send(Act::Say(titel));
                    let _ = self.speaker.tx.send(Act::End);
                }
            }
            Ev::Hide => {
                self.hidden = !self.hidden;
                if !self.hidden {
                    self.say_bubble("Da bin ich wieder", "", Some(1.5));
                }
            }
            Ev::Heard(h) => match h {
                Heard::Hypothesis(t) => {
                    if self.phase == Phase::Listening || self.phase == Phase::Finishing {
                        self.hypothesis = t.clone();
                        let shown = format!("{} {}", self.heard, t);
                        if let Some(b) = &mut self.bubble {
                            b.text = shown.trim().to_string();
                        }
                    }
                }
                Heard::Final(t) => {
                    self.heard = format!("{} {}", self.heard, t).trim().to_string();
                    self.hypothesis.clear();
                    if self.conv && self.phase == Phase::Listening {
                        // im Gespräch: jede fertige Äußerung sofort beantworten
                        let q = std::mem::take(&mut self.heard);
                        let _ = self.listen.send(ListenCmd::Stop);
                        self.ask(q);
                    } else if let Some(b) = &mut self.bubble {
                        b.text = self.heard.clone();
                    }
                }
                Heard::Stopped => {
                    if self.phase == Phase::Finishing {
                        self.finish_listening();
                    }
                }
                Heard::Error(e) => {
                    log(&e);
                    self.conv = false;
                    self.phase = Phase::Idle;
                    self.say_bubble("Ich kann gerade nicht zuhören", &e, Some(9.0));
                }
            },
            Ev::Brain(generation, piece) => {
                if generation != self.generation {
                    return; // alte, abgebrochene Antwort
                }
                match piece {
                    brain::Piece::Say(s) => {
                        log(&format!("Antwort: {s}"));
                        let _ = self.speaker.tx.send(Act::Say(s));
                    }
                    brain::Piece::Point(x, y, label) => {
                        if let Some(shot) = &self.shot {
                            let (sx, sy) = shot.to_screen(x, y);
                            let _ = self.speaker.tx.send(Act::Show(sx, sy, label));
                        }
                    }
                    brain::Piece::Session(id) => self.session = Some((id, Instant::now())),
                    brain::Piece::Done => {
                        let _ = self.speaker.tx.send(Act::End);
                        if let Some((_, t)) = &mut self.session {
                            *t = Instant::now();
                        }
                    }
                    brain::Piece::Error(e) => {
                        log(&e);
                        self.say_bubble("Das ging schief", &e, Some(8.0));
                        self.phase = Phase::Idle;
                    }
                }
            }
            Ev::Speak(s) => match s {
                SpeakEv::Saying(t) => {
                    self.phase = Phase::Speaking;
                    if let Some((titel, text)) = &self.notice {
                        let (titel, text) = (titel.clone(), text.clone());
                        self.say_bubble(&titel, &text, None);
                        let _ = t;
                        return;
                    }
                    if !self.answer.is_empty() {
                        self.answer.push(' ');
                    }
                    self.answer.push_str(&t);
                    // nur das Ende der Antwort zeigen, damit die Blase nicht riesig wird
                    let chars: Vec<char> = self.answer.chars().collect();
                    let shown: String = if chars.len() > 260 { format!("…{}", chars[chars.len() - 250..].iter().collect::<String>()) } else { self.answer.clone() };
                    self.say_bubble("Harnes", &shown, None);
                }
                SpeakEv::Show(x, y, label) => {
                    self.fly = Some(Fly { from: self.buddy, to: (x, y), t0: Instant::now(), ms: 650.0 });
                    self.hold_point_until = None;
                    if !label.is_empty() {
                        if let Some(b) = &mut self.bubble {
                            b.title = label;
                        }
                    }
                }
                SpeakEv::Finished => {
                    self.notice = None;
                    if self.phase == Phase::Speaking || self.phase == Phase::Thinking {
                        self.phase = Phase::Idle;
                        if let Some(b) = &mut self.bubble {
                            b.until = Some(Instant::now() + Duration::from_secs(7));
                        }
                        self.hold_point_until = Some(Instant::now() + Duration::from_millis(2500));
                        if self.conv {
                            self.start_listening();
                        }
                    }
                }
            },
        }
    }

    fn finish_listening(&mut self) {
        self.finishing_until = None;
        let q = if self.heard.is_empty() { std::mem::take(&mut self.hypothesis) } else { format!("{} {}", self.heard, self.hypothesis).trim().to_string() };
        self.heard.clear();
        self.hypothesis.clear();
        self.ask(q);
    }

    fn tick(&mut self) {
        check_hold();
        if self.phase == Phase::Finishing && self.finishing_until.map(|t| Instant::now() > t).unwrap_or(false) {
            self.finish_listening();
        }
        // Position: zur Zeigestelle fliegen oder der Maus folgen
        let (cx, cy) = cursor();
        let follow = (cx + 16.0 * self.scale, cy + 18.0 * self.scale);
        if let Some(f) = &self.fly {
            let k = (f.t0.elapsed().as_secs_f32() * 1000.0 / f.ms).min(1.0);
            let e = if k < 0.5 { 4.0 * k * k * k } else { 1.0 - (-2.0 * k + 2.0).powi(3) / 2.0 };
            let lift = ((f.to.0 - f.from.0).hypot(f.to.1 - f.from.1) * 0.22).min(140.0);
            self.buddy = (f.from.0 + (f.to.0 - f.from.0) * e, f.from.1 + (f.to.1 - f.from.1) * e - (std::f32::consts::PI * e).sin() * lift);
            if self.hold_point_until.map(|t| Instant::now() > t).unwrap_or(false) {
                self.fly = None;
                self.hold_point_until = None;
            }
        } else {
            self.buddy.0 += (follow.0 - self.buddy.0) * 0.28;
            self.buddy.1 += (follow.1 - self.buddy.1) * 0.28;
        }
        if let Some(b) = &self.bubble {
            if b.until.map(|t| Instant::now() > t).unwrap_or(false) {
                self.bubble = None;
            }
        }
        self.render();
    }

    fn render(&mut self) {
        let s = self.scale;
        let t = self.started.elapsed().as_secs_f32();
        let mon = screen::monitor_at_cursor();
        // Sprechblase neben dem Zeiger, aber auf dem Bildschirm
        let (bx0, by0) = self.buddy;
        let mut lines: Vec<String> = Vec::new();
        let (mut bw, mut bh) = (0.0, 0.0);
        let size = 15.0 * s;
        let lh = 21.0 * s;
        if let Some(b) = &self.bubble {
            let maxw = 360.0 * s;
            lines = if b.text.is_empty() { vec![] } else { self.painter.wrap(&b.text, size, maxw, false) };
            if lines.len() > 9 {
                lines = lines.split_off(lines.len() - 9);
            }
            let tw = lines.iter().map(|l| self.painter.width(l, size, false)).fold(self.painter.width(&b.title, 13.0 * s, true), f32::max);
            bw = tw + 30.0 * s;
            bh = 40.0 * s + lines.len() as f32 * lh;
        }
        let mut bx = bx0 + 30.0 * s;
        let mut by = by0 + 26.0 * s;
        if bx + bw > mon.right as f32 - 8.0 {
            bx = bx0 - bw - 14.0 * s;
        }
        if by + bh > mon.bottom as f32 - 8.0 {
            by = by0 - bh - 10.0 * s;
        }
        let ox = (bx0 - 60.0 * s).min(bx - 12.0).floor();
        let oy = (by0 - 60.0 * s).min(by - 12.0).floor();
        let (lx, ly) = (bx0 - ox, by0 - oy);
        self.pm.fill(tiny_skia::Color::TRANSPARENT);
        if !self.hidden || self.phase != Phase::Idle || self.bubble.is_some() {
            let active = self.phase != Phase::Idle;
            let pulse = (t * 3.0).sin() * 0.5 + 0.5;
            glow(&mut self.pm, lx + 8.0 * s, ly + 9.0 * s, (if active { 30.0 + pulse * 10.0 } else { 22.0 }) * s, if active { 1.0 } else { 0.6 });
            match self.phase {
                Phase::Listening | Phase::Finishing => {
                    for i in 0..2 {
                        let k = ((t * 1.4 + i as f32 * 0.5) % 1.0) as f32;
                        ring(&mut self.pm, lx + 8.0 * s, ly + 9.0 * s, (14.0 + k * 26.0) * s, (1.0 - k) * 0.85, PEACH, 2.0 * s);
                    }
                }
                Phase::Thinking => {
                    for i in 0..3 {
                        let a = t * 4.0 + i as f32 * 2.094;
                        dot(&mut self.pm, lx + 8.0 * s + a.cos() * 18.0 * s, ly + 9.0 * s + a.sin() * 18.0 * s, 3.2 * s, VIOLET, 0.9);
                    }
                }
                Phase::Speaking => {
                    for i in 0..4 {
                        let hgt = (5.0 + ((t * 9.0 + i as f32 * 1.3).sin() * 0.5 + 0.5) * 12.0) * s;
                        bar(&mut self.pm, lx + (26.0 + i as f32 * 6.0) * s, ly + 22.0 * s - hgt / 2.0, 3.5 * s, hgt, PEACH, 0.9);
                    }
                }
                Phase::Idle => {}
            }
            let alpha = if self.hidden && !active { 0.0 } else if active { 1.0 } else { 0.9 };
            pointer(&mut self.pm, lx, ly, 1.15 * s, alpha);
            if let Some(b) = &self.bubble {
                let (cx, cy) = (bx - ox, by - oy);
                card(&mut self.pm, cx, cy, bw, bh, 1.0);
                self.painter.text(&mut self.pm, "◆", cx + 14.0 * s, cy + 22.0 * s, 12.0 * s, PEACH, 1.0, true);
                self.painter.text(&mut self.pm, &b.title, cx + 30.0 * s, cy + 22.0 * s, 13.0 * s, VIOLET, 1.0, true);
                for (i, l) in lines.iter().enumerate() {
                    self.painter.text(&mut self.pm, l, cx + 15.0 * s, cy + 22.0 * s + lh * (i as f32 + 1.0) + 2.0, size, TEXT, 1.0, false);
                }
                let _ = MUTED;
            }
        }
        self.present(ox as i32, oy as i32);
    }

    fn present(&mut self, x: i32, y: i32) {
        // RGBA (vormultipliziert) -> BGRA für Windows
        let src = self.pm.data();
        let dst = unsafe { std::slice::from_raw_parts_mut(self.bits, (W * H * 4) as usize) };
        for i in (0..src.len()).step_by(4) {
            dst[i] = src[i + 2];
            dst[i + 1] = src[i + 1];
            dst[i + 2] = src[i];
            dst[i + 3] = src[i + 3];
        }
        unsafe {
            let screen = GetDC(HWND::default());
            let pt = POINT { x, y };
            let size = SIZE { cx: W, cy: H };
            let src_pt = POINT { x: 0, y: 0 };
            let blend = BLENDFUNCTION { BlendOp: AC_SRC_OVER as u8, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: AC_SRC_ALPHA as u8 };
            let _ = UpdateLayeredWindow(self.hwnd, screen, Some(&pt), Some(&size), self.mem_dc, Some(&src_pt), COLORREF(0), Some(&blend), ULW_ALPHA);
            ReleaseDC(HWND::default(), screen);
        }
    }
}

static mut APP: Option<App> = None;

#[allow(static_mut_refs)]
unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_TIMER => {
            if let Some(app) = unsafe { APP.as_mut() } {
                app.tick();
            }
            LRESULT(0)
        }
        WM_EV => {
            if let Some(app) = unsafe { APP.as_mut() } {
                let evs: Vec<Ev> = RX.get().map(|r| r.lock().unwrap().try_iter().collect()).unwrap_or_default();
                for ev in evs {
                    app.handle(ev);
                }
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wp, lp) },
    }
}

static RX: OnceLock<Mutex<Receiver<Ev>>> = OnceLock::new();

#[allow(static_mut_refs)]
fn main() {
    unsafe {
        // nur einmal starten
        let _m = CreateMutexW(None, true, w!("HarnesBegleiterEinmal"));
        if GetLastError() == ERROR_ALREADY_EXISTS {
            return;
        }
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let (tx, rx) = channel::<Ev>();
    let _ = TX.set(Mutex::new(tx));
    let _ = RX.set(Mutex::new(rx));

    unsafe {
        let inst = HINSTANCE(GetModuleHandleW(PCWSTR::null()).unwrap().0);
        let class = w!("HarnesBegleiter");
        let wc = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: inst, lpszClassName: class, ..Default::default() };
        RegisterClassW(&wc);
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class,
            w!("Harnes Begleiter"),
            WS_POPUP,
            0,
            0,
            W,
            H,
            HWND::default(),
            HMENU::default(),
            inst,
            None,
        )
        .unwrap();
        // im eigenen Bildschirmfoto unsichtbar (die KI soll den Bildschirm sehen, nicht den Zeiger)
        // sichtbar für Aufnahmen; nur beim eigenen Bildschirmfoto ausgeblendet (siehe ask)
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let _ = HWND_MAIN.set(hwnd.0 as isize);

        // Zeichenfläche (32 Bit, oben links beginnend)
        let screen = GetDC(HWND::default());
        let mem_dc = CreateCompatibleDC(screen);
        let bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: W, biHeight: -H, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() },
            ..Default::default()
        };
        let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let dib = CreateDIBSection(screen, &bi, DIB_RGB_COLORS, &mut bits, HANDLE::default(), 0).unwrap();
        SelectObject(mem_dc, dib);
        ReleaseDC(HWND::default(), screen);

        let speaker = voice::start_speaker(|e| post(Ev::Speak(e)));
        let listen = voice::start_listener(|h| post(Ev::Heard(h)));
        let (model, user) = read_settings();
        let scale = GetDpiForSystem() as f32 / 96.0;
        let c = cursor();
        APP = Some(App {
            hwnd,
            painter: Painter::new(),
            pm: Pixmap::new(W as u32, H as u32).unwrap(),
            mem_dc,
            bits: bits as *mut u8,
            scale,
            buddy: c,
            fly: None,
            hold_point_until: None,
            phase: Phase::Idle,
            bubble: Some(Bubble {
                title: "Harnes ist da".into(),
                text: "Strg+Alt halten und sprechen – ich sehe deinen Bildschirm und zeige dir die Stellen. Zweimal kurz Strg+Alt: Gespräch. Strg+Alt+Q beendet.".into(),
                until: Some(Instant::now() + Duration::from_secs(9)),
            }),
            heard: String::new(),
            hypothesis: String::new(),
            finishing_until: None,
            conv: false,
            hidden: false,
            answer: String::new(),
            shot: None,
            session: None,
            generation: 0,
            speaker,
            listen,
            model,
            user,
            started: Instant::now(),
            notice: None,
        });
        log("Begleiter gestartet");
        // zum Testen und für Vorführungen: --frage "…" beantwortet eine Frage ohne Mikrofon
        let args: Vec<String> = std::env::args().collect();
        if let Some(i) = args.iter().position(|a| a == "--frage") {
            if let Some(q) = args.get(i + 1).cloned() {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1500));
                    post(Ev::Ask(q));
                });
            }
        }

        notify::start(|t, x| post(Ev::Notify(t, x)));
        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(key_hook), inst, 0).ok();
        SetTimer(hwnd, 1, 16, None);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if let Some(h) = hook {
            let _ = UnhookWindowsHookEx(h);
        }
        notify::stop();
        log("Begleiter beendet");
        let _ = PCWSTR::null();
    }
}
