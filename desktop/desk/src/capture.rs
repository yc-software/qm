use crate::cancellation;
use crate::protocol::{Rect, Screenshot};
use crate::tree::intersect as intersection;
use base64::Engine;
use block2::RcBlock;
use core_foundation::array::CFArray;
use core_foundation::base::{CFRetain, CFType, CFTypeRef, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop};
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::base::kCGImageAlphaPremultipliedLast;
use core_graphics::color_space::{kCGColorSpaceSRGB, CGColorSpace};
use core_graphics::context::CGContext;
use core_graphics::image::CGImage;
use core_graphics::window::{
    copy_window_info, create_image, kCGWindowImageBoundsIgnoreFraming, kCGWindowImageNominalResolution, kCGWindowListOptionIncludingWindow,
    kCGWindowListOptionOnScreenAboveWindow, kCGWindowNumber, kCGWindowOwnerPID,
};
use foreign_types::ForeignType;
use objc2::rc::Retained;
use objc2::runtime::AnyClass;
use objc2::AnyThread;
use objc2_foundation::{NSArray, NSError, NSMutableData};
use objc2_screen_capture_kit::{SCContentFilter, SCDisplay, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCWindow};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

#[link(name = "ImageIO", kind = "framework")]
extern "C" {
    fn CGImageDestinationCreateWithData(data: CFTypeRef, kind: CFStringRef, count: usize, options: CFTypeRef) -> CFTypeRef;
    fn CGImageDestinationAddImage(destination: CFTypeRef, image: CFTypeRef, properties: CFTypeRef);
    fn CGImageDestinationFinalize(destination: CFTypeRef) -> bool;
}

const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_EDGE: f64 = 32_768.0;

struct Piece {
    image: CGImage,
    at: Rect,
}

unsafe impl Send for Piece {}

enum Part {
    Plan { area: Rect, pieces: usize },
    Piece(Piece),
}

type Parts = Sender<Result<Part, String>>;

pub fn window(id: u32, panels: &[u32], frame: Rect) -> Result<Screenshot, String> {
    size(frame)?;
    if AnyClass::get(c"SCScreenshotManager").is_none() {
        return legacy(id, frame);
    }
    let above = above(id);
    let panels = panels.to_vec();
    let (tx, rx) = channel();
    let block = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        let planned = unsafe { content.as_ref() }.ok_or_else(|| reason(error)).and_then(|c| plan(c, id, &above, &panels, frame, &tx));
        if let Err(e) = planned {
            let _ = tx.send(Err(e));
        }
    });
    unsafe { SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(true, false, &block) };
    drop(block);
    let (area, pieces) = collect(rx)?;
    let image = compose(area, &pieces)?;
    encode(&image, area)
}

fn above(id: u32) -> Vec<(u32, i64)> {
    let number = |d: &CFDictionary<CFString, CFType>, key| d.find(key).and_then(|v| v.downcast::<CFNumber>()).and_then(|n| n.to_i64());
    let infos = copy_window_info(kCGWindowListOptionOnScreenAboveWindow | kCGWindowListOptionIncludingWindow, id);
    infos
        .iter()
        .flat_map(CFArray::iter)
        .filter_map(|item| {
            let d = unsafe { CFDictionary::<CFString, CFType>::wrap_under_get_rule(*item as _) };
            Some((
                number(&d, unsafe { CFString::wrap_under_get_rule(kCGWindowNumber) })? as u32,
                number(&d, unsafe { CFString::wrap_under_get_rule(kCGWindowOwnerPID) })?,
            ))
        })
        .collect()
}

fn plan(content: &SCShareableContent, id: u32, above: &[(u32, i64)], panels: &[u32], frame: Rect, tx: &Parts) -> Result<(), String> {
    let windows = unsafe { content.windows() };
    let target = windows.iter().find(|w| unsafe { w.windowID() } == id).ok_or("The window is not available to capture.")?;
    let pid = above.iter().find(|(w, _)| *w == id).map(|(_, p)| *p);
    let candidates: Vec<(u32, Rect, bool)> = windows
        .iter()
        .filter_map(|w| {
            let wid = unsafe { w.windowID() };
            let (owner, shown) = (above.iter().find(|(a, _)| *a == wid).map(|(_, p)| *p), unsafe { w.isOnScreen() });
            let forced = panels.contains(&wid);
            (wid != id && shown && owner.is_some() && (forced || owner == pid)).then(|| (wid, rect(unsafe { w.frame() }), forced))
        })
        .collect();
    let (ids, area) = associated(frame, &candidates);
    if ids.is_empty() {
        tx.send(Ok(Part::Plan { area: frame, pieces: 1 })).map_err(|e| e.to_string())?;
        let filter = unsafe { SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &target) };
        grab(&filter, frame, None, tx.clone());
        return Ok(());
    }
    let shown: Vec<Retained<SCWindow>> =
        windows.iter().filter(|w| unsafe { w.windowID() } == id || ids.contains(&unsafe { w.windowID() })).collect();
    let shown = NSArray::from_retained_slice(&shown);
    let parts: Vec<(Retained<SCDisplay>, Rect)> =
        unsafe { content.displays() }.iter().filter_map(|d| intersection(rect(unsafe { d.frame() }), area).map(|r| (d, r))).collect();
    if parts.is_empty() {
        return Err("The window is not on any display.".into());
    }
    tx.send(Ok(Part::Plan { area, pieces: parts.len() })).map_err(|e| e.to_string())?;
    for (display, at) in parts {
        let filter = unsafe { SCContentFilter::initWithDisplay_includingWindows(SCContentFilter::alloc(), &display, &shown) };
        let origin = rect(unsafe { display.frame() });
        grab(&filter, at, Some(Rect { x: at.x - origin.x, y: at.y - origin.y, w: at.w, h: at.h }), tx.clone());
    }
    Ok(())
}

fn grab(filter: &SCContentFilter, at: Rect, source: Option<Rect>, tx: Parts) {
    let config = unsafe { SCStreamConfiguration::new() };
    unsafe {
        config.setWidth(at.w.round().max(1.0) as usize);
        config.setHeight(at.h.round().max(1.0) as usize);
        config.setShowsCursor(false);
        config.setIgnoreShadowsDisplay(true);
        config.setIgnoreShadowsSingleWindow(true);
        if let Some(s) = source {
            config.setSourceRect(cg(s));
        }
    }
    let done = RcBlock::new(move |image: *mut objc2_core_graphics::CGImage, error: *mut NSError| {
        let piece = match unsafe { image.as_ref() } {
            Some(i) => Ok(Part::Piece(Piece {
                image: unsafe { CGImage::from_ptr(CFRetain((i as *const objc2_core_graphics::CGImage).cast()) as _) },
                at,
            })),
            None => Err(reason(error)),
        };
        let _ = tx.send(piece);
    });
    unsafe { SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(filter, &config, Some(&done)) };
}

fn collect(rx: Receiver<Result<Part, String>>) -> Result<(Rect, Vec<Piece>), String> {
    let start = Instant::now();
    let (mut plan, mut pieces) = (None, vec![]);
    loop {
        if let Some((area, n)) = plan {
            if pieces.len() == n {
                return Ok((area, pieces));
            }
        }
        if cancellation::cancelled() {
            return Err("Computer action cancelled".into());
        }
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(Ok(Part::Plan { area, pieces: n })) => plan = Some((area, n)),
            Ok(Ok(Part::Piece(p))) => pieces.push(p),
            Ok(Err(e)) => return Err(e),
            Err(RecvTimeoutError::Disconnected) => return Err("Screen capture ended without an image.".into()),
            Err(RecvTimeoutError::Timeout) if start.elapsed() >= TIMEOUT => return Err("Screen capture timed out.".into()),
            Err(RecvTimeoutError::Timeout) => {
                CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, Duration::ZERO, true);
            }
        }
    }
}

fn size(r: Rect) -> Result<(usize, usize), String> {
    let (w, h) = (r.w.round(), r.h.round());
    let usable = [r.x, r.y, r.w, r.h].iter().all(|v| v.is_finite())
        && (1.0..=MAX_EDGE).contains(&w)
        && (1.0..=MAX_EDGE).contains(&h)
        && w * h <= 64_000_000.0;
    if usable {
        Ok((w as usize, h as usize))
    } else {
        Err(format!("The window frame {}x{} is not a size that can be captured.", r.w, r.h))
    }
}

fn compose(area: Rect, pieces: &[Piece]) -> Result<CGImage, String> {
    let (w, h) = size(area)?;
    let failed = || "Could not compose the screenshot.".to_string();
    let space = CGColorSpace::create_with_name(unsafe { kCGColorSpaceSRGB }).ok_or_else(failed)?;
    let context = CGContext::create_bitmap_context(None, w, h, 8, 0, &space, kCGImageAlphaPremultipliedLast);
    let h = h as f64;
    context.clear_rect(core_graphics::geometry::CGRect::new(
        &core_graphics::geometry::CGPoint::new(0.0, 0.0),
        &core_graphics::geometry::CGSize::new(w as f64, h),
    ));
    for p in pieces {
        let at = Rect { x: p.at.x - area.x, y: h - (p.at.y - area.y) - p.at.h, w: p.at.w, h: p.at.h };
        context.draw_image(
            core_graphics::geometry::CGRect::new(
                &core_graphics::geometry::CGPoint::new(at.x, at.y),
                &core_graphics::geometry::CGSize::new(at.w, at.h),
            ),
            &p.image,
        );
    }
    context.create_image().ok_or_else(failed)
}

fn reason(error: *mut NSError) -> String {
    unsafe { error.as_ref() }.map_or_else(|| "Screen capture returned nothing.".into(), |e| e.localizedDescription().to_string())
}

fn legacy(id: u32, frame: Rect) -> Result<Screenshot, String> {
    let bounds = core_graphics::geometry::CGRect::new(
        &core_graphics::geometry::CGPoint::new(frame.x, frame.y),
        &core_graphics::geometry::CGSize::new(frame.w, frame.h),
    );
    let image =
        create_image(bounds, kCGWindowListOptionIncludingWindow, id, kCGWindowImageBoundsIgnoreFraming | kCGWindowImageNominalResolution)
            .ok_or("Window capture returned nothing.")?;
    encode(&image, frame)
}

fn encode(image: &CGImage, area: Rect) -> Result<Screenshot, String> {
    let data = NSMutableData::new();
    let kind = CFString::from_static_string("public.png");
    let written = unsafe {
        let destination = CGImageDestinationCreateWithData(Retained::as_ptr(&data).cast(), kind.as_concrete_TypeRef(), 1, std::ptr::null());
        if destination.is_null() {
            return Err("Could not encode the screenshot.".into());
        }
        let destination = CFType::wrap_under_create_rule(destination);
        CGImageDestinationAddImage(destination.as_CFTypeRef(), image.as_ptr().cast(), std::ptr::null());
        CGImageDestinationFinalize(destination.as_CFTypeRef())
    };
    if !written {
        return Err("Could not encode the screenshot.".into());
    }
    let (width, height) = (image.width() as u32, image.height() as u32);
    Ok(Screenshot {
        png_base64: base64::engine::general_purpose::STANDARD.encode(data.to_vec()),
        width,
        height,
        pixels_per_point: if area.w > 0.0 { width as f64 / area.w } else { 1.0 },
        frame: area,
    })
}

fn associated(target: Rect, candidates: &[(u32, Rect, bool)]) -> (Vec<u32>, Rect) {
    let mut ids: Vec<u32> = vec![];
    let mut area = target;
    let mut shown = vec![target];
    loop {
        let next = candidates.iter().find(|(id, r, forced)| {
            !ids.contains(id)
                && (*forced || shown.iter().any(|s| intersection(*s, *r).is_some()) || shown.iter().skip(1).any(|s| touching(*s, *r)))
        });
        match next {
            Some((id, r, _)) => {
                ids.push(*id);
                shown.push(*r);
                area = union(area, *r);
            }
            None => return (ids, area),
        }
    }
}

fn touching(a: Rect, b: Rect) -> bool {
    let w = (a.x + a.w).min(b.x + b.w) - a.x.max(b.x);
    let h = (a.y + a.h).min(b.y + b.h) - a.y.max(b.y);
    (w > 0.0 && h >= -1.0) || (h > 0.0 && w >= -1.0)
}

fn union(a: Rect, b: Rect) -> Rect {
    let (x, y) = (a.x.min(b.x), a.y.min(b.y));
    Rect { x, y, w: (a.x + a.w).max(b.x + b.w) - x, h: (a.y + a.h).max(b.y + b.h) - y }
}

fn rect(r: objc2_core_foundation::CGRect) -> Rect {
    Rect { x: r.origin.x, y: r.origin.y, w: r.size.width, h: r.size.height }
}

fn cg(r: Rect) -> objc2_core_foundation::CGRect {
    objc2_core_foundation::CGRect::new(objc2_core_foundation::CGPoint::new(r.x, r.y), objc2_core_foundation::CGSize::new(r.w, r.h))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, w, h }
    }

    fn tuple(r: Rect) -> (f64, f64, f64, f64) {
        (r.x, r.y, r.w, r.h)
    }

    #[test]
    fn menus_cascading_past_the_window_grow_the_shot() {
        let window = r(100.0, 100.0, 400.0, 300.0);
        let menu = (1, r(450.0, 150.0, 200.0, 300.0), false);
        let submenu = (2, r(650.0, 200.0, 200.0, 100.0), false);
        let elsewhere = (3, r(1000.0, 0.0, 100.0, 100.0), false);
        let menu_bar_icon = (4, r(200.0, 80.0, 20.0, 20.0), false);
        let (ids, area) = associated(window, &[submenu, elsewhere, menu, menu_bar_icon]);
        assert_eq!(ids, vec![1, 2]);
        assert_eq!(tuple(area), (100.0, 100.0, 750.0, 350.0));
    }

    #[test]
    fn named_panels_join_without_touching_the_window() {
        let (ids, area) = associated(r(0.0, 0.0, 100.0, 100.0), &[(7, r(200.0, 0.0, 50.0, 50.0), true)]);
        assert_eq!(ids, vec![7]);
        assert_eq!(tuple(area), (0.0, 0.0, 250.0, 100.0));
    }

    #[test]
    fn unusable_frames_are_refused_before_allocating() {
        for frame in [
            r(0.0, 0.0, 32768.0, 32768.0),
            r(0.0, 0.0, 0.0, 10.0),
            r(0.0, 0.0, 10.0, 0.2),
            r(f64::NAN, 0.0, 10.0, 10.0),
            r(0.0, 0.0, f64::INFINITY, 10.0),
            r(0.0, 0.0, 1e9, 10.0),
            r(0.0, 0.0, -5.0, 10.0),
        ] {
            assert!(size(frame).is_err(), "{frame:?}");
            assert!(compose(frame, &[]).is_err(), "{frame:?}");
        }
        assert_eq!(size(r(-3.0, -4.0, 10.4, 20.6)), Ok((10, 21)));
    }

    fn tile(w: usize, h: usize, bands: &[[f64; 3]]) -> CGImage {
        let space = CGColorSpace::create_with_name(unsafe { kCGColorSpaceSRGB }).unwrap();
        let context = CGContext::create_bitmap_context(None, w, h, 8, 0, &space, kCGImageAlphaPremultipliedLast);
        let band = h as f64 / bands.len() as f64;
        for (i, [red, green, blue]) in bands.iter().enumerate() {
            context.set_rgb_fill_color(*red, *green, *blue, 1.0);
            let y = h as f64 - (i as f64 + 1.0) * band;
            context.fill_rect(core_graphics::geometry::CGRect::new(
                &core_graphics::geometry::CGPoint::new(0.0, y),
                &core_graphics::geometry::CGSize::new(w as f64, band),
            ));
        }
        context.create_image().unwrap()
    }

    fn pixel(image: &CGImage, x: usize, y: usize) -> [u8; 4] {
        let data = image.data();
        let i = y * image.bytes_per_row() + x * 4;
        data.bytes()[i..i + 4].try_into().unwrap()
    }

    #[test]
    fn compose_places_tiles_top_down_at_their_screen_positions() {
        let (green, red, blue) = ([0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
        let area = r(-5.0, -20.0, 10.0, 50.0);
        let pieces = [
            Piece { image: tile(10, 20, &[green, red]), at: r(-5.0, -20.0, 10.0, 20.0) },
            Piece { image: tile(10, 20, &[blue]), at: r(-5.0, 10.0, 10.0, 20.0) },
        ];
        let image = compose(area, &pieces).unwrap();
        assert_eq!((image.width(), image.height()), (10, 50));
        assert_eq!(pixel(&image, 5, 0), [0, 255, 0, 255]);
        assert_eq!(pixel(&image, 5, 9), [0, 255, 0, 255]);
        assert_eq!(pixel(&image, 5, 10), [255, 0, 0, 255]);
        assert_eq!(pixel(&image, 5, 19), [255, 0, 0, 255]);
        assert_eq!(pixel(&image, 5, 20), [0, 0, 0, 0]);
        assert_eq!(pixel(&image, 5, 29), [0, 0, 0, 0]);
        assert_eq!(pixel(&image, 5, 30), [0, 0, 255, 255]);
        assert_eq!(pixel(&image, 5, 49), [0, 0, 255, 255]);
    }

    #[test]
    fn a_lone_window_keeps_its_frame() {
        let (ids, area) = associated(r(10.0, 20.0, 30.0, 40.0), &[]);
        assert!(ids.is_empty());
        assert_eq!(tuple(area), (10.0, 20.0, 30.0, 40.0));
    }
}
