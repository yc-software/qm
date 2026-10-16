use crate::protocol::*;
use base64::Engine;
use core_foundation::array::CFArray;
use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::event::{CGEvent, CGEventFlags, CGEventType, CGMouseButton, EventField, ScrollEventUnit};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use core_graphics::window::{
    create_image, kCGWindowImageBoundsIgnoreFraming, kCGWindowImageNominalResolution, kCGWindowListOptionIncludingWindow,
};
use foreign_types::ForeignType;
use objc2_app_kit::{NSApplicationActivationPolicy, NSWorkspace};
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::time::Duration;

type El = CFType;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
    fn AXUIElementCopyAttributeValue(e: CFTypeRef, a: CFStringRef, v: *mut CFTypeRef) -> i32;
    fn AXUIElementSetAttributeValue(e: CFTypeRef, a: CFStringRef, v: CFTypeRef) -> i32;
    fn AXUIElementIsAttributeSettable(e: CFTypeRef, a: CFStringRef, v: *mut bool) -> i32;
    fn AXUIElementCopyActionNames(e: CFTypeRef, v: *mut CFTypeRef) -> i32;
    fn AXUIElementPerformAction(e: CFTypeRef, a: CFStringRef) -> i32;
    fn AXUIElementSetMessagingTimeout(e: CFTypeRef, t: f32) -> i32;
    fn AXValueGetValue(v: CFTypeRef, kind: u32, out: *mut c_void) -> bool;
    fn AXValueCreate(kind: u32, value: *const c_void) -> CFTypeRef;
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(o: CFTypeRef) -> bool;
    fn _AXUIElementGetWindow(e: CFTypeRef, id: *mut u32) -> i32;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGEventSetLocation(e: *mut c_void, p: CGPoint);
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFHash(cf: CFTypeRef) -> usize;
}

const MAX_NODES: usize = 800;
const MAX_DEPTH: usize = 60;
const BORING: &[&str] = &["AXShowMenu", "AXScrollToVisible", "AXShowDefaultUI", "AXShowAlternateUI"];
const BUSY: &[&str] = &["AXBusyIndicator", "AXProgressIndicator"];

struct App {
    name: String,
    bundle: Option<String>,
    pid: i32,
    active: bool,
}

struct Snapshot {
    window: u32,
    origin: (f64, f64),
    elements: Vec<(u32, El)>,
    lines: HashMap<u32, String>,
    next: u32,
}

#[derive(Default)]
pub struct Desk {
    cache: HashMap<i32, Snapshot>,
}

fn fail(code: ErrorCode, m: impl Into<String>) -> Failure {
    Failure::new(code, m)
}

fn cfs(s: &str) -> CFString {
    CFString::new(s)
}

fn attr(e: &El, name: &str) -> Option<CFType> {
    let mut v: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(e.as_CFTypeRef(), cfs(name).as_concrete_TypeRef(), &mut v) };
    (err == 0 && !v.is_null()).then(|| unsafe { CFType::wrap_under_create_rule(v) })
}

fn text_of(v: &CFType) -> Option<String> {
    if let Some(s) = v.downcast::<CFString>() {
        return Some(s.to_string());
    }
    let n = v.downcast::<CFNumber>()?;
    n.to_i64().map(|i| i.to_string()).or_else(|| n.to_f64().map(|f| f.to_string()))
}

fn str_attr(e: &El, name: &str) -> Option<String> {
    attr(e, name).and_then(|v| text_of(&v)).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn bool_attr(e: &El, name: &str) -> Option<bool> {
    attr(e, name).and_then(|v| v.downcast::<CFBoolean>()).map(bool::from)
}

fn settable(e: &El, name: &str) -> bool {
    let mut b = false;
    unsafe { AXUIElementIsAttributeSettable(e.as_CFTypeRef(), cfs(name).as_concrete_TypeRef(), &mut b) == 0 && b }
}

fn ax_value<T: Default>(e: &El, name: &str, kind: u32) -> Option<T> {
    let v = attr(e, name)?;
    let mut out = T::default();
    unsafe { AXValueGetValue(v.as_CFTypeRef(), kind, &mut out as *mut T as *mut c_void) }.then_some(out)
}

fn frame(e: &El) -> Option<Rect> {
    let p: CGPoint = ax_value(e, "AXPosition", 1)?;
    let s: CGSize = ax_value(e, "AXSize", 2)?;
    Some(Rect { x: p.x, y: p.y, w: s.width, h: s.height })
}

fn list(v: CFType) -> Vec<CFType> {
    v.downcast::<CFArray>().map(|a| a.iter().map(|p| unsafe { CFType::wrap_under_get_rule(*p) }).collect()).unwrap_or_default()
}

fn actions(e: &El) -> Vec<String> {
    let mut v: CFTypeRef = std::ptr::null();
    if unsafe { AXUIElementCopyActionNames(e.as_CFTypeRef(), &mut v) } != 0 || v.is_null() {
        return vec![];
    }
    list(unsafe { CFType::wrap_under_create_rule(v) }).iter().filter_map(text_of).collect()
}

fn set_attr(e: &El, name: &str, v: &CFType) -> i32 {
    unsafe { AXUIElementSetAttributeValue(e.as_CFTypeRef(), cfs(name).as_concrete_TypeRef(), v.as_CFTypeRef()) }
}

fn perform(e: &El, action: &str) -> Result<(), Failure> {
    match unsafe { AXUIElementPerformAction(e.as_CFTypeRef(), cfs(action).as_concrete_TypeRef()) } {
        0 => Ok(()),
        n => Err(fail(ErrorCode::ActionFailed, format!("{action} failed (AXError {n})"))),
    }
}

fn clip(s: &str, n: usize) -> String {
    let s = s.replace('\n', "⏎");
    if s.chars().count() > n {
        format!("{}…", s.chars().take(n).collect::<String>())
    } else {
        s
    }
}

fn running() -> Vec<App> {
    NSWorkspace::sharedWorkspace()
        .runningApplications()
        .iter()
        .filter(|a| a.activationPolicy() == NSApplicationActivationPolicy::Regular)
        .map(|a| App {
            name: a.localizedName().map(|s| s.to_string()).unwrap_or_default(),
            bundle: a.bundleIdentifier().map(|s| s.to_string()),
            pid: a.processIdentifier(),
            active: a.isActive(),
        })
        .collect()
}

fn pt(x: f64, y: f64) -> CGPoint {
    CGPoint::new(x, y)
}

fn source() -> Result<CGEventSource, Failure> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| fail(ErrorCode::ActionFailed, "no event source"))
}

fn post(e: CGEvent, pid: i32) {
    e.post_to_pid(pid);
    std::thread::sleep(Duration::from_millis(8));
}

fn mouse(pid: i32, win: u32, ty: CGEventType, p: CGPoint, b: CGMouseButton, clicks: i64, flags: CGEventFlags) -> Result<(), Failure> {
    let e = CGEvent::new_mouse_event(source()?, ty, p, b).map_err(|_| fail(ErrorCode::ActionFailed, "mouse event"))?;
    e.set_flags(flags);
    e.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, clicks);
    e.set_integer_value_field(91, win as i64);
    e.set_integer_value_field(92, win as i64);
    post(e, pid);
    Ok(())
}

fn click_at(pid: i32, win: u32, p: CGPoint, button: Button, count: u8, mods: &[Modifier], hold: u32) -> Result<(), Failure> {
    let (down, up, b) = match button {
        Button::Left => (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp, CGMouseButton::Left),
        Button::Right => (CGEventType::RightMouseDown, CGEventType::RightMouseUp, CGMouseButton::Right),
        Button::Middle => (CGEventType::OtherMouseDown, CGEventType::OtherMouseUp, CGMouseButton::Center),
    };
    for n in 1..=count.max(1) as i64 {
        mouse(pid, win, down, p, b, n, flags(mods))?;
        std::thread::sleep(Duration::from_millis(hold.min(10_000) as u64));
        mouse(pid, win, up, p, b, n, flags(mods))?;
    }
    Ok(())
}

fn key(pid: i32, code: u16, flags: CGEventFlags, text: Option<&str>, hold: u32) -> Result<(), Failure> {
    for down in [true, false] {
        if !down {
            std::thread::sleep(Duration::from_millis(hold.min(10_000) as u64));
        }
        let e = CGEvent::new_keyboard_event(source()?, code, down).map_err(|_| fail(ErrorCode::ActionFailed, "key event"))?;
        e.set_flags(flags);
        if let Some(t) = text {
            e.set_string(t);
        }
        post(e, pid);
    }
    Ok(())
}

fn keycode(k: &str) -> Option<u16> {
    const KEYS: &[(&str, u16)] = &[
        ("a", 0),
        ("s", 1),
        ("d", 2),
        ("f", 3),
        ("h", 4),
        ("g", 5),
        ("z", 6),
        ("x", 7),
        ("c", 8),
        ("v", 9),
        ("b", 11),
        ("q", 12),
        ("w", 13),
        ("e", 14),
        ("r", 15),
        ("y", 16),
        ("t", 17),
        ("1", 18),
        ("2", 19),
        ("3", 20),
        ("4", 21),
        ("6", 22),
        ("5", 23),
        ("=", 24),
        ("9", 25),
        ("7", 26),
        ("-", 27),
        ("8", 28),
        ("0", 29),
        ("]", 30),
        ("o", 31),
        ("u", 32),
        ("[", 33),
        ("i", 34),
        ("p", 35),
        ("return", 36),
        ("enter", 36),
        ("l", 37),
        ("j", 38),
        ("'", 39),
        ("k", 40),
        (";", 41),
        ("\\", 42),
        (",", 43),
        ("/", 44),
        ("n", 45),
        ("m", 46),
        (".", 47),
        ("tab", 48),
        ("space", 49),
        ("`", 50),
        ("delete", 51),
        ("backspace", 51),
        ("escape", 53),
        ("esc", 53),
        ("f5", 96),
        ("f6", 97),
        ("f7", 98),
        ("f3", 99),
        ("f8", 100),
        ("f9", 101),
        ("f11", 103),
        ("f10", 109),
        ("f12", 111),
        ("home", 115),
        ("pageup", 116),
        ("forwarddelete", 117),
        ("f4", 118),
        ("end", 119),
        ("f2", 120),
        ("pagedown", 121),
        ("f1", 122),
        ("left", 123),
        ("right", 124),
        ("down", 125),
        ("up", 126),
    ];
    let k = k.to_ascii_lowercase();
    KEYS.iter().find(|(n, _)| *n == k).map(|(_, c)| *c)
}

fn chord(k: &str) -> Result<(u16, Vec<Modifier>), Failure> {
    let unknown = || fail(ErrorCode::UnknownKey, format!("unknown key {k}"));
    let (mods, last) = match k.rsplit_once('+') {
        Some((m, "")) if !m.is_empty() => (m.strip_suffix('+').unwrap_or(m), "+"),
        Some((m, last)) => (m, last),
        None => ("", k),
    };
    let mods = mods
        .split('+')
        .filter(|m| !m.is_empty())
        .map(|m| match m.to_ascii_lowercase().as_str() {
            "cmd" | "command" | "meta" | "super" => Ok(Modifier::Command),
            "shift" => Ok(Modifier::Shift),
            "opt" | "option" | "alt" => Ok(Modifier::Option),
            "ctrl" | "control" => Ok(Modifier::Control),
            _ => Err(unknown()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((keycode(last).ok_or_else(unknown)?, mods))
}

fn flags(mods: &[Modifier]) -> CGEventFlags {
    mods.iter().fold(CGEventFlags::empty(), |f, m| {
        f | match m {
            Modifier::Command => CGEventFlags::CGEventFlagCommand,
            Modifier::Shift => CGEventFlags::CGEventFlagShift,
            Modifier::Option => CGEventFlags::CGEventFlagAlternate,
            Modifier::Control => CGEventFlags::CGEventFlagControl,
        }
    })
}

fn center(w: &El) -> CGPoint {
    frame(w).map(|f| pt(f.x + f.w / 2.0, f.y + f.h / 2.0)).unwrap_or(pt(0.0, 0.0))
}

fn window_of(app: &El) -> Option<El> {
    attr(app, "AXFocusedWindow")
        .or_else(|| attr(app, "AXMainWindow"))
        .or_else(|| attr(app, "AXWindows").and_then(|w| list(w).into_iter().next()))
}

fn window_id(w: &El) -> u32 {
    let mut id = 0;
    unsafe { _AXUIElementGetWindow(w.as_CFTypeRef(), &mut id) };
    id
}

fn line(e: &El, origin: (f64, f64)) -> (String, bool) {
    let role = str_attr(e, "AXRole").unwrap_or_else(|| "AXUnknown".into());
    let title = str_attr(e, "AXTitle");
    let desc = str_attr(e, "AXDescription").or_else(|| str_attr(e, "AXHelp"));
    let value = str_attr(e, "AXValue");
    let can_set = settable(e, "AXValue");
    let acts: Vec<String> = actions(e).into_iter().filter(|a| !BORING.contains(&a.as_str())).collect();
    let keep = title.is_some() || desc.is_some() || value.is_some() || can_set || !acts.is_empty();
    let mut s = role.trim_start_matches("AX").to_string();
    if let Some(t) = &title {
        s += &format!(" \"{}\"", clip(t, 80));
    }
    if let Some(d) = desc.filter(|d| Some(d) != title.as_ref()) {
        s += &format!(" ({})", clip(&d, 80));
    }
    if let Some(v) = value.filter(|v| Some(v) != title.as_ref()) {
        s += &format!(" = \"{}\"", clip(&v, 120));
    }
    let mut tags = vec![];
    for (attr_name, want, tag) in [("AXFocused", true, "focused"), ("AXEnabled", false, "disabled"), ("AXSelected", true, "selected")] {
        if bool_attr(e, attr_name) == Some(want) {
            tags.push(tag);
        }
    }
    if can_set {
        tags.push("settable");
    }
    if !tags.is_empty() {
        s += &format!(" [{}]", tags.join(" "));
    }
    if !acts.is_empty() {
        let a: Vec<&str> = acts.iter().map(|a| a.trim_start_matches("AX")).collect();
        s += &format!(" <{}>", a.join(","));
    }
    if let Some(f) = frame(e) {
        s += &format!(" @{:.0},{:.0} {:.0}x{:.0}", f.x - origin.0, f.y - origin.1, f.w, f.h);
    }
    (s, keep)
}

struct Walk {
    origin: (f64, f64),
    known: HashMap<usize, Vec<(u32, El)>>,
    taken: HashSet<u32>,
    next: u32,
    elements: Vec<(u32, El)>,
    lines: Vec<(u32, String)>,
    truncated: bool,
}

impl Walk {
    fn id(&mut self, e: &El) -> u32 {
        let found = self
            .known
            .get(&unsafe { CFHash(e.as_CFTypeRef()) })
            .and_then(|c| c.iter().find(|(id, k)| !self.taken.contains(id) && k == e))
            .map(|(id, _)| *id);
        let id = found.unwrap_or_else(|| {
            self.next += 1;
            self.next - 1
        });
        self.taken.insert(id);
        id
    }

    fn visit(&mut self, e: &El, depth: usize, indent: usize) {
        if self.elements.len() >= MAX_NODES || depth > MAX_DEPTH {
            self.truncated = true;
            return;
        }
        let (s, keep) = line(e, self.origin);
        let next = if keep {
            let id = self.id(e);
            self.lines.push((id, format!("{}[{}] {}", "  ".repeat(indent), id, s)));
            self.elements.push((id, e.clone()));
            indent + 1
        } else {
            indent
        };
        for c in attr(e, "AXChildren").map(list).unwrap_or_default() {
            self.visit(&c, depth + 1, next);
        }
    }
}

fn busy(e: &El, depth: usize, seen: &mut usize) -> bool {
    *seen += 1;
    if *seen > MAX_NODES || depth > MAX_DEPTH {
        return false;
    }
    if str_attr(e, "AXRole").is_some_and(|r| BUSY.contains(&r.as_str())) {
        return true;
    }
    attr(e, "AXChildren").map(list).unwrap_or_default().iter().any(|c| busy(c, depth + 1, seen))
}

fn select(e: &El, text: &str, prefix: &str, suffix: &str, selection: Selection) -> Result<(), Failure> {
    let value = attr(e, "AXValue").and_then(|v| text_of(&v)).unwrap_or_default();
    let at = value
        .match_indices(text)
        .map(|(i, _)| i)
        .find(|&i| value[..i].ends_with(prefix) && value[i + text.len()..].starts_with(suffix))
        .ok_or_else(|| fail(ErrorCode::ActionFailed, format!("text {text:?} not found in the element's value")))?;
    let start = value[..at].encode_utf16().count() as isize;
    let len = text.encode_utf16().count() as isize;
    let range: [isize; 2] = match selection {
        Selection::Text => [start, len],
        Selection::CursorBefore => [start, 0],
        Selection::CursorAfter => [start + len, 0],
    };
    set_attr(e, "AXFocused", &CFBoolean::true_value().as_CFType());
    let v = unsafe { CFType::wrap_under_create_rule(AXValueCreate(4, range.as_ptr() as *const c_void)) };
    match set_attr(e, "AXSelectedTextRange", &v) {
        0 => Ok(()),
        n => Err(fail(ErrorCode::ActionFailed, format!("setting the selection failed (AXError {n})"))),
    }
}

fn png(img: &core_graphics::image::CGImage) -> Option<(String, u32, u32)> {
    let (w, h, row) = (img.width(), img.height(), img.bytes_per_row());
    if img.bits_per_pixel() != 32 {
        return None;
    }
    let data = img.data();
    let bytes = data.bytes();
    let mut rgba = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let i = y * row + x * 4;
            rgba.extend_from_slice(&[bytes[i + 2], bytes[i + 1], bytes[i], bytes[i + 3]]);
        }
    }
    let mut buf = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut buf, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().ok()?.write_image_data(&rgba).ok()?;
    }
    Some((base64::engine::general_purpose::STANDARD.encode(buf), w as u32, h as u32))
}

fn permissions(prompt: bool) -> Reply {
    let accessibility = if prompt {
        let d = CFDictionary::from_CFType_pairs(&[(cfs("AXTrustedCheckOptionPrompt").as_CFType(), CFBoolean::true_value().as_CFType())]);
        unsafe { AXIsProcessTrustedWithOptions(d.as_CFTypeRef()) }
    } else {
        unsafe { AXIsProcessTrusted() }
    };
    let screen_recording = unsafe {
        if prompt {
            CGRequestScreenCaptureAccess()
        } else {
            CGPreflightScreenCaptureAccess()
        }
    };
    let binary = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
    let help = "System Settings > Privacy & Security > Accessibility and > Screen Recording: add the app that launches desk \
(QM, or your terminal when run alone) with +, switch it on, then quit and reopen that app. \
`desk permissions --prompt` raises the system prompts."
        .to_string();
    Reply::Permissions { accessibility, screen_recording, binary, help }
}

impl Desk {
    pub fn handle(&mut self, cmd: Command, pace: &mut dyn FnMut(u32, Point) -> Result<(), Failure>) -> Reply {
        let r = match cmd {
            Command::Permissions { prompt } => Ok(permissions(prompt)),
            Command::Apps => apps(),
            Command::Observe { app, screenshot, diff } => {
                resolve(&app).and_then(|a| self.observe(&a, screenshot, diff)).map(Reply::Observation)
            }
            Command::Act { app, actions, observe, screenshot, pace: paced, diff } => {
                let pace = if paced { Some(pace) } else { None };
                self.act(&app, &actions, observe.then_some((screenshot, diff)), pace)
            }
            Command::Arrived => Err(fail(ErrorCode::BadRequest, "arrived outside a paced act")),
        };
        r.unwrap_or_else(Reply::Error)
    }

    fn observe(&mut self, app: &App, shot: bool, diff: bool) -> Result<Observation, Failure> {
        let (_, w) = window(app)?;
        let win = window_id(&w);
        let f = frame(&w).unwrap_or(Rect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 });
        let prev = self.cache.remove(&app.pid).filter(|s| s.window == win);
        let mut walk = Walk {
            origin: (f.x, f.y),
            known: HashMap::new(),
            taken: HashSet::new(),
            next: prev.as_ref().map_or(0, |p| p.next),
            elements: vec![],
            lines: vec![],
            truncated: false,
        };
        for (id, e) in prev.iter().flat_map(|p| p.elements.iter()) {
            walk.known.entry(unsafe { CFHash(e.as_CFTypeRef()) }).or_default().push((*id, e.clone()));
        }
        for c in attr(&w, "AXChildren").map(list).unwrap_or_default() {
            walk.visit(&c, 0, 0);
        }
        let screenshot = if shot { Some(capture(&w, f)?) } else { None };
        let base = prev.filter(|_| diff);
        let tree: String = walk
            .lines
            .iter()
            .filter(|(id, l)| base.as_ref().is_none_or(|b| b.lines.get(id) != Some(l)))
            .map(|(_, l)| format!("{l}\n"))
            .collect();
        let removed = base
            .as_ref()
            .map(|b| {
                let mut gone: Vec<u32> = b.lines.keys().filter(|id| !walk.taken.contains(id)).copied().collect();
                gone.sort_unstable();
                gone
            })
            .unwrap_or_default();
        let obs = Observation {
            app: app.name.clone(),
            bundle_id: app.bundle.clone(),
            pid: app.pid,
            window: str_attr(&w, "AXTitle").unwrap_or_default(),
            frame: f,
            elements: walk.elements.len() as u32,
            truncated: walk.truncated,
            diffed: base.is_some(),
            tree,
            removed,
            screenshot,
        };
        self.cache.insert(
            app.pid,
            Snapshot {
                window: win,
                origin: walk.origin,
                elements: walk.elements,
                lines: walk.lines.into_iter().collect(),
                next: walk.next,
            },
        );
        Ok(obs)
    }

    fn settle(&self, w: &El) {
        std::thread::sleep(Duration::from_millis(1000));
        for _ in 0..16 {
            if !busy(w, 0, &mut 0) {
                return;
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    }

    fn act(
        &mut self,
        query: &str,
        actions: &[Action],
        observe: Option<(bool, bool)>,
        mut pace: Option<&mut dyn FnMut(u32, Point) -> Result<(), Failure>>,
    ) -> Result<Reply, Failure> {
        let app = resolve(query)?;
        if !self.cache.contains_key(&app.pid) {
            return Err(fail(ErrorCode::BadIndex, "Observe this app before acting; its previous observation is no longer available"));
        }
        let (ax, w) = window(&app)?;
        let win = window_id(&w);
        let mut completed = 0;
        let mut failure = None;
        for (i, a) in actions.iter().enumerate() {
            let paced = match (pace.as_mut(), self.aim(app.pid, &w, a)) {
                (Some(p), Ok(Some(at))) => p(i as u32, Point { x: at.x, y: at.y }),
                (Some(_), Err(e)) => Err(e),
                _ => Ok(()),
            };
            if let Err(mut e) = paced.and_then(|_| self.step(&app, &ax, &w, win, a)) {
                e.action = Some(i as u32);
                failure = Some(e);
                break;
            }
            completed += 1;
        }
        self.settle(&w);
        let (observation, observation_failure) = match observe {
            Some((shot, diff)) => match self.observe(&app, shot, diff) {
                Ok(observation) => (Some(observation), None),
                Err(error) => (None, Some(error)),
            },
            None => (None, None),
        };
        Ok(Reply::Acted { completed, failure, observation, observation_failure })
    }

    fn element(&self, pid: i32, index: u32) -> Result<El, Failure> {
        let s = self.cache.get(&pid).ok_or_else(|| fail(ErrorCode::BadIndex, "observe first"))?;
        s.elements
            .iter()
            .find(|(id, _)| *id == index)
            .map(|(_, e)| e.clone())
            .ok_or_else(|| fail(ErrorCode::BadIndex, format!("no element {index}; observe again")))
    }

    fn point(&self, pid: i32, t: Target) -> Result<CGPoint, Failure> {
        match t {
            Target::Point(p) => {
                let o = self.cache.get(&pid).map(|s| s.origin).unwrap_or((0.0, 0.0));
                Ok(pt(o.0 + p.x, o.1 + p.y))
            }
            Target::Index(i) => {
                let f = frame(&self.element(pid, i)?).ok_or_else(|| fail(ErrorCode::BadIndex, format!("element {i} has no frame")))?;
                Ok(pt(f.x + f.w / 2.0, f.y + f.h / 2.0))
            }
        }
    }

    fn aim(&self, pid: i32, w: &El, a: &Action) -> Result<Option<CGPoint>, Failure> {
        match a {
            Action::Click { target, .. } | Action::Scroll { target: Some(target), .. } => self.point(pid, *target).map(Some),
            Action::Scroll { target: None, .. } => Ok(Some(center(w))),
            Action::Drag { from, .. } => self.point(pid, Target::Point(*from)).map(Some),
            _ => Ok(None),
        }
    }

    fn step(&self, app: &App, ax: &El, w: &El, win: u32, a: &Action) -> Result<(), Failure> {
        let pid = app.pid;
        match a {
            Action::Click { target: Target::Index(i), button: Button::Left, count: 1, modifiers, hold_ms: 0 } if modifiers.is_empty() => {
                let e = self.element(pid, *i)?;
                if actions(&e).iter().any(|a| a == "AXPress") {
                    perform(&e, "AXPress")
                } else {
                    click_at(pid, win, self.point(pid, Target::Index(*i))?, Button::Left, 1, &[], 0)
                }
            }
            Action::Click { target, button, count, modifiers, hold_ms } => {
                click_at(pid, win, self.point(pid, *target)?, *button, *count, modifiers, *hold_ms)
            }
            Action::TypeText { text } => {
                for c in text.chars() {
                    key(pid, 0, CGEventFlags::empty(), Some(&c.to_string()), 0)?;
                }
                Ok(())
            }
            Action::SelectText { index, text, prefix, suffix, selection } => {
                select(&self.element(pid, *index)?, text, prefix, suffix, *selection)
            }
            Action::PressKey { key: k, hold_ms } => {
                let (code, mods) = chord(k)?;
                key(pid, code, flags(&mods), None, *hold_ms)
            }
            Action::Scroll { target, direction, amount } => {
                let p = match target {
                    Some(t) => self.point(pid, *t)?,
                    None => center(w),
                };
                let view = match target {
                    Some(Target::Index(i)) => frame(&self.element(pid, *i)?),
                    _ => frame(w),
                }
                .unwrap_or(Rect { x: 0.0, y: 0.0, w: 600.0, h: 600.0 });
                let vertical = matches!(direction, Direction::Up | Direction::Down);
                let mut left = match amount {
                    Amount::Pixels(n) => *n as i32,
                    Amount::Pages(n) => (n.clamp(0.0, 20.0) * 0.85 * if vertical { view.h } else { view.w }) as i32,
                };
                while left > 0 {
                    let n = left.min(120);
                    left -= n;
                    let (dy, dx) = match direction {
                        Direction::Up => (n, 0),
                        Direction::Down => (-n, 0),
                        Direction::Left => (0, n),
                        Direction::Right => (0, -n),
                    };
                    let e = CGEvent::new_scroll_event(source()?, ScrollEventUnit::PIXEL, 2, dy, dx, 0)
                        .map_err(|_| fail(ErrorCode::ActionFailed, "scroll event"))?;
                    unsafe { CGEventSetLocation(e.as_ptr() as *mut c_void, p) };
                    post(e, pid);
                }
                Ok(())
            }
            Action::Drag { from, to } => {
                let (a, b) = (self.point(pid, Target::Point(*from))?, self.point(pid, Target::Point(*to))?);
                let none = CGEventFlags::empty();
                mouse(pid, win, CGEventType::LeftMouseDown, a, CGMouseButton::Left, 1, none)?;
                for s in 1..=12 {
                    let t = s as f64 / 12.0;
                    mouse(
                        pid,
                        win,
                        CGEventType::LeftMouseDragged,
                        pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t),
                        CGMouseButton::Left,
                        1,
                        none,
                    )?;
                    std::thread::sleep(Duration::from_millis(12));
                }
                mouse(pid, win, CGEventType::LeftMouseUp, b, CGMouseButton::Left, 1, none)
            }
            Action::SetValue { index, value } => match set_attr(&self.element(pid, *index)?, "AXValue", &cfs(value).as_CFType()) {
                0 => Ok(()),
                n => Err(fail(ErrorCode::ActionFailed, format!("setting AXValue failed (AXError {n})"))),
            },
            Action::Perform { index, action } => {
                let name = if action.starts_with("AX") { action.clone() } else { format!("AX{action}") };
                perform(&self.element(pid, *index)?, &name)
            }
            Action::Raise => {
                set_attr(ax, "AXFrontmost", &CFBoolean::true_value().as_CFType());
                perform(w, "AXRaise")
            }
            Action::Wait { ms } => {
                std::thread::sleep(Duration::from_millis((*ms).min(10_000) as u64));
                Ok(())
            }
        }
    }
}

fn apps() -> Result<Reply, Failure> {
    let apps = running().into_iter().map(|a| AppInfo { name: a.name, bundle_id: a.bundle, pid: a.pid, active: a.active }).collect();
    Ok(Reply::Apps { apps })
}

fn resolve(query: &str) -> Result<App, Failure> {
    if !unsafe { AXIsProcessTrusted() } {
        return Err(fail(ErrorCode::PermissionMissing, "Accessibility not granted; run `desk permissions --prompt`"));
    }
    let find = || {
        running()
            .into_iter()
            .find(|a| a.name.eq_ignore_ascii_case(query) || a.bundle.as_deref().is_some_and(|b| b.eq_ignore_ascii_case(query)))
    };
    let app = match find() {
        Some(app) => app,
        None => {
            let flag = if query.contains('.') && !query.contains(' ') { "-b" } else { "-a" };
            let opened = std::process::Command::new("/usr/bin/open").args(["-g", flag, query]).status().is_ok_and(|s| s.success());
            (0..25)
                .take_while(|_| opened)
                .find_map(|_| {
                    std::thread::sleep(Duration::from_millis(200));
                    find()
                })
                .ok_or_else(|| fail(ErrorCode::AppNotFound, format!("could not open {query}")))?
        }
    };
    Ok(app)
}

fn window(app: &App) -> Result<(El, El), Failure> {
    let ax = unsafe { CFType::wrap_under_create_rule(AXUIElementCreateApplication(app.pid)) };
    unsafe { AXUIElementSetMessagingTimeout(ax.as_CFTypeRef(), 1.5) };
    set_attr(&ax, "AXManualAccessibility", &CFBoolean::true_value().as_CFType());
    let w = window_of(&ax).ok_or_else(|| fail(ErrorCode::NoWindow, format!("{} has no open window", app.name)))?;
    Ok((ax, w))
}

fn capture(w: &El, f: Rect) -> Result<Screenshot, Failure> {
    if !unsafe { CGPreflightScreenCaptureAccess() } {
        return Err(fail(ErrorCode::PermissionMissing, "Screen Recording not granted; run `desk permissions --prompt`"));
    }
    let rect = CGRect::new(&pt(f.x, f.y), &CGSize::new(f.w, f.h));
    let img = create_image(
        rect,
        kCGWindowListOptionIncludingWindow,
        window_id(w),
        kCGWindowImageBoundsIgnoreFraming | kCGWindowImageNominalResolution,
    )
    .ok_or_else(|| fail(ErrorCode::ActionFailed, "window capture returned nothing"))?;
    let (png_base64, width, height) = png(&img).ok_or_else(|| fail(ErrorCode::ActionFailed, "unexpected pixel format"))?;
    Ok(Screenshot { png_base64, width, height, pixels_per_point: if f.w > 0.0 { width as f64 / f.w } else { 1.0 } })
}
