//! Bildschirmfoto des Monitors unter dem Mauszeiger (GDI), verkleinert und als PNG.

use base64::Engine;
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

/// Ein aufgenommenes Bild und wie es auf den Bildschirm abgebildet wird.
pub struct Shot {
    pub png_base64: String,
    /// Größe des Bildes, das die KI sieht
    pub w: u32,
    pub h: u32,
    /// Monitor in Bildschirmpixeln
    pub mon: RECT,
}

impl Shot {
    /// Bildkoordinaten (wie die KI sie nennt) in Bildschirmpixel umrechnen
    pub fn to_screen(&self, x: f32, y: f32) -> (f32, f32) {
        let mw = (self.mon.right - self.mon.left) as f32;
        let mh = (self.mon.bottom - self.mon.top) as f32;
        (self.mon.left as f32 + x * mw / self.w as f32, self.mon.top as f32 + y * mh / self.h as f32)
    }
}

pub fn monitor_at_cursor() -> RECT {
    unsafe {
        let mut p = POINT::default();
        let _ = GetCursorPos(&mut p);
        let mon = MonitorFromPoint(p, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let _ = GetMonitorInfoW(mon, &mut info);
        info.rcMonitor
    }
}

pub fn capture(max_w: u32) -> Option<Shot> {
    let mon = monitor_at_cursor();
    let w = (mon.right - mon.left).max(1);
    let h = (mon.bottom - mon.top).max(1);
    let mut bgra = vec![0u8; (w * h * 4) as usize];
    unsafe {
        let screen = GetDC(HWND::default());
        let mem = CreateCompatibleDC(screen);
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp);
        let _ = BitBlt(mem, 0, 0, w, h, screen, mon.left, mon.top, SRCCOPY | CAPTUREBLT);
        let mut bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        GetDIBits(mem, bmp, 0, h as u32, Some(bgra.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
        SelectObject(mem, old);
        let _ = DeleteObject(bmp);
        let _ = DeleteDC(mem);
        ReleaseDC(HWND::default(), screen);
    }
    // verkleinern (Flächenmittel), spart Tokens und Zeit
    let scale = (max_w as f32 / w as f32).min(1.0);
    let tw = ((w as f32) * scale).round().max(1.0) as u32;
    let th = ((h as f32) * scale).round().max(1.0) as u32;
    let mut rgb = vec![0u8; (tw * th * 3) as usize];
    for ty in 0..th {
        let y0 = (ty as f32 / scale) as i32;
        let y1 = (((ty + 1) as f32 / scale) as i32).max(y0 + 1).min(h);
        for tx in 0..tw {
            let x0 = (tx as f32 / scale) as i32;
            let x1 = (((tx + 1) as f32 / scale) as i32).max(x0 + 1).min(w);
            let (mut r, mut g, mut b, mut n) = (0u32, 0u32, 0u32, 0u32);
            let mut y = y0;
            while y < y1 {
                let mut x = x0;
                while x < x1 {
                    let i = ((y * w + x) * 4) as usize;
                    b += bgra[i] as u32;
                    g += bgra[i + 1] as u32;
                    r += bgra[i + 2] as u32;
                    n += 1;
                    x += 1;
                }
                y += 1;
            }
            let o = ((ty * tw + tx) * 3) as usize;
            let n = n.max(1);
            rgb[o] = (r / n) as u8;
            rgb[o + 1] = (g / n) as u8;
            rgb[o + 2] = (b / n) as u8;
        }
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, tw, th);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        let mut wr = enc.write_header().ok()?;
        wr.write_image_data(&rgb).ok()?;
    }
    Some(Shot { png_base64: base64::engine::general_purpose::STANDARD.encode(out), w: tw, h: th, mon })
}
