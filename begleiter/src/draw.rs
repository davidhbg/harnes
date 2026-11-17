//! Zeichnen mit tiny-skia: der Zeiger des Begleiters, Sprechblase, Zustände (zuhören, denken, sprechen)
//! und Text mit der Systemschrift (Segoe UI).

use ab_glyph::{point, Font, FontVec, PxScale, ScaleFont};
use tiny_skia::*;

pub const PEACH: [u8; 3] = [0xE3, 0xB4, 0x8F];
pub const VIOLET: [u8; 3] = [0xA9, 0x9B, 0xDC];
pub const TEXT: [u8; 3] = [0xE4, 0xDF, 0xF0];
pub const MUTED: [u8; 3] = [0x93, 0x8B, 0xAD];

pub fn rgba(c: [u8; 3], a: f32) -> Color {
    Color::from_rgba8(c[0], c[1], c[2], (a.clamp(0.0, 1.0) * 255.0) as u8)
}

pub struct Painter {
    font: FontVec,
    bold: FontVec,
}

fn load(paths: &[&str]) -> Option<FontVec> {
    for p in paths {
        if let Ok(data) = std::fs::read(p) {
            if let Ok(f) = FontVec::try_from_vec(data) {
                return Some(f);
            }
        }
    }
    None
}

impl Painter {
    pub fn new() -> Self {
        let font = load(&[r"C:\Windows\Fonts\segoeui.ttf", r"C:\Windows\Fonts\arial.ttf"]).expect("keine Schrift gefunden");
        let bold = load(&[r"C:\Windows\Fonts\seguisb.ttf", r"C:\Windows\Fonts\segoeuib.ttf", r"C:\Windows\Fonts\arialbd.ttf"])
            .unwrap_or_else(|| load(&[r"C:\Windows\Fonts\segoeui.ttf"]).unwrap());
        Painter { font, bold }
    }

    fn pick(&self, bold: bool) -> &FontVec {
        if bold {
            &self.bold
        } else {
            &self.font
        }
    }

    pub fn width(&self, s: &str, size: f32, bold: bool) -> f32 {
        let f = self.pick(bold).as_scaled(PxScale::from(size));
        let mut w = 0.0;
        let mut prev = None;
        for ch in s.chars() {
            let id = f.glyph_id(ch);
            if let Some(p) = prev {
                w += f.kern(p, id);
            }
            w += f.h_advance(id);
            prev = Some(id);
        }
        w
    }

    /// Text auf eine Breite umbrechen
    pub fn wrap(&self, s: &str, size: f32, max_w: f32, bold: bool) -> Vec<String> {
        let mut lines = Vec::new();
        for para in s.split('\n') {
            let mut line = String::new();
            for word in para.split_whitespace() {
                let test = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
                if self.width(&test, size, bold) > max_w && !line.is_empty() {
                    lines.push(std::mem::take(&mut line));
                    line = word.to_string();
                } else {
                    line = test;
                }
            }
            lines.push(line);
        }
        lines
    }

    pub fn text(&self, pm: &mut Pixmap, s: &str, x: f32, baseline: f32, size: f32, color: [u8; 3], alpha: f32, bold: bool) {
        let font = self.pick(bold);
        let f = font.as_scaled(PxScale::from(size));
        let mut caret = x;
        let mut prev = None;
        let (w, h) = (pm.width() as i32, pm.height() as i32);
        let data = pm.data_mut();
        for ch in s.chars() {
            let id = f.glyph_id(ch);
            if let Some(p) = prev {
                caret += f.kern(p, id);
            }
            let g = id.with_scale_and_position(PxScale::from(size), point(caret, baseline));
            caret += f.h_advance(id);
            prev = Some(id);
            if let Some(og) = font.outline_glyph(g) {
                let b = og.px_bounds();
                og.draw(|gx, gy, c| {
                    let px = b.min.x as i32 + gx as i32;
                    let py = b.min.y as i32 + gy as i32;
                    if px < 0 || py < 0 || px >= w || py >= h {
                        return;
                    }
                    let a = (c * alpha).clamp(0.0, 1.0);
                    let i = ((py * w + px) * 4) as usize;
                    // vormultipliziert überblenden
                    for k in 0..3 {
                        let src = color[k] as f32 * a;
                        data[i + k] = (src + data[i + k] as f32 * (1.0 - a)) as u8;
                    }
                    data[i + 3] = (a * 255.0 + data[i + 3] as f32 * (1.0 - a)) as u8;
                });
            }
        }
    }
}

pub fn rounded(x: f32, y: f32, w: f32, h: f32, r: f32) -> Option<Path> {
    let r = r.min(w / 2.0).min(h / 2.0);
    let mut pb = PathBuilder::new();
    pb.move_to(x + r, y);
    pb.line_to(x + w - r, y);
    pb.quad_to(x + w, y, x + w, y + r);
    pb.line_to(x + w, y + h - r);
    pb.quad_to(x + w, y + h, x + w - r, y + h);
    pb.line_to(x + r, y + h);
    pb.quad_to(x, y + h, x, y + h - r);
    pb.line_to(x, y + r);
    pb.quad_to(x, y, x + r, y);
    pb.close();
    pb.finish()
}

fn circle(cx: f32, cy: f32, r: f32) -> Option<Path> {
    PathBuilder::from_circle(cx, cy, r.max(0.1))
}

fn solid(c: Color) -> Paint<'static> {
    let mut p = Paint::default();
    p.set_color(c);
    p.anti_alias = true;
    p
}

/// Leuchtender Schein unter dem Zeiger
pub fn glow(pm: &mut Pixmap, cx: f32, cy: f32, r: f32, alpha: f32) {
    if let Some(shader) = RadialGradient::new(
        Point::from_xy(cx, cy),
        0.0,
        Point::from_xy(cx, cy),
        r,
        vec![GradientStop::new(0.0, rgba(PEACH, 0.45 * alpha)), GradientStop::new(0.5, rgba([0xC5, 0x9B, 0xC0], 0.18 * alpha)), GradientStop::new(1.0, rgba(VIOLET, 0.0))],
        SpreadMode::Pad,
        Transform::identity(),
    ) {
        let mut p = Paint::default();
        p.shader = shader;
        p.anti_alias = true;
        if let Some(c) = circle(cx, cy, r) {
            pm.fill_path(&c, &p, FillRule::Winding, Transform::identity(), None);
        }
    }
}

/// Der Zeiger: ein Dreieck mit Verlauf Creme – Altrosa – Violett; Spitze bei (x, y)
pub fn pointer(pm: &mut Pixmap, x: f32, y: f32, scale: f32, alpha: f32) {
    let s = scale;
    let mut pb = PathBuilder::new();
    pb.move_to(x, y);
    pb.line_to(x + 20.0 * s, y + 9.0 * s);
    pb.line_to(x + 10.0 * s, y + 11.5 * s);
    pb.line_to(x + 6.5 * s, y + 22.0 * s);
    pb.close();
    let Some(path) = pb.finish() else { return };
    if let Some(shader) = LinearGradient::new(
        Point::from_xy(x, y),
        Point::from_xy(x + 20.0 * s, y + 22.0 * s),
        vec![GradientStop::new(0.0, rgba([0xF4, 0xE6, 0xC8], alpha)), GradientStop::new(0.5, rgba([0xC5, 0x9B, 0xC0], alpha)), GradientStop::new(1.0, rgba([0x86, 0x76, 0xC4], alpha))],
        SpreadMode::Pad,
        Transform::identity(),
    ) {
        let mut p = Paint::default();
        p.shader = shader;
        p.anti_alias = true;
        pm.fill_path(&path, &p, FillRule::Winding, Transform::identity(), None);
    }
    let mut st = Stroke::default();
    st.width = 1.5 * s;
    st.line_join = LineJoin::Round;
    pm.stroke_path(&path, &solid(Color::from_rgba8(0x17, 0x12, 0x2B, (alpha * 230.0) as u8)), &st, Transform::identity(), None);
}

/// Ring, der beim Zuhören pulsiert
pub fn ring(pm: &mut Pixmap, cx: f32, cy: f32, r: f32, alpha: f32, color: [u8; 3], width: f32) {
    if let Some(c) = circle(cx, cy, r) {
        let mut st = Stroke::default();
        st.width = width;
        pm.stroke_path(&c, &solid(rgba(color, alpha)), &st, Transform::identity(), None);
    }
}

pub fn dot(pm: &mut Pixmap, cx: f32, cy: f32, r: f32, color: [u8; 3], alpha: f32) {
    if let Some(c) = circle(cx, cy, r) {
        pm.fill_path(&c, &solid(rgba(color, alpha)), FillRule::Winding, Transform::identity(), None);
    }
}

pub fn bar(pm: &mut Pixmap, x: f32, y: f32, w: f32, h: f32, color: [u8; 3], alpha: f32) {
    if let Some(p) = rounded(x, y, w, h, w / 2.0) {
        pm.fill_path(&p, &solid(rgba(color, alpha)), FillRule::Winding, Transform::identity(), None);
    }
}

/// Karte der Sprechblase
pub fn card(pm: &mut Pixmap, x: f32, y: f32, w: f32, h: f32, alpha: f32) {
    if let Some(p) = rounded(x + 2.0, y + 6.0, w, h, 16.0) {
        pm.fill_path(&p, &solid(Color::from_rgba8(5, 3, 15, (alpha * 90.0) as u8)), FillRule::Winding, Transform::identity(), None);
    }
    if let Some(p) = rounded(x, y, w, h, 16.0) {
        pm.fill_path(&p, &solid(Color::from_rgba8(0x15, 0x11, 0x26, (alpha * 242.0) as u8)), FillRule::Winding, Transform::identity(), None);
        let mut st = Stroke::default();
        st.width = 1.2;
        pm.stroke_path(&p, &solid(Color::from_rgba8(0x5B, 0x4E, 0x96, (alpha * 255.0) as u8)), &st, Transform::identity(), None);
    }
}
