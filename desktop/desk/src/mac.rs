use crate::cancellation;

mod input;
mod markers;
use crate::protocol::*;
use crate::text::{self, Key as TextKey, Stroke};
use crate::tree::{self, Item, Key, Locator, Props, ROOT};
use core_foundation::array::CFArray;
use core_foundation::attributed_string::{CFAttributedString, CFAttributedStringGetAttributes, CFAttributedStringGetString};
use core_foundation::base::{CFGetTypeID, CFHash, CFRange, CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop, CFRunLoopRunResult, CFRunLoopSource};
use core_foundation::string::{CFString, CFStringRef};
use core_foundation::url::CFURL;
use core_graphics::event::{CGEvent, CGEventFlags, CGEventType, CGMouseButton, EventField, ScrollEventUnit};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::{CGPoint, CGSize};
use core_graphics::window::{copy_window_info, kCGWindowListOptionOnScreenOnly, kCGWindowNumber};
use foreign_types::ForeignType;
use objc2_app_kit::{NSApplicationActivationPolicy, NSFont, NSFontDescriptorSymbolicTraits, NSRunningApplication, NSWorkspace};
use objc2_foundation::NSString;
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::{Duration, Instant};

type El = CFType;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
    fn AXUIElementCreateSystemWide() -> CFTypeRef;
    fn AXUIElementGetPid(element: CFTypeRef, pid: *mut i32) -> i32;
    fn AXUIElementCopyAttributeValue(e: CFTypeRef, a: CFStringRef, v: *mut CFTypeRef) -> i32;
    fn AXUIElementCopyMultipleAttributeValues(e: CFTypeRef, names: CFTypeRef, options: u32, v: *mut CFTypeRef) -> i32;
    fn AXUIElementCopyParameterizedAttributeNames(e: CFTypeRef, names: *mut CFTypeRef) -> i32;
    fn AXUIElementCopyParameterizedAttributeValue(e: CFTypeRef, name: CFStringRef, parameter: CFTypeRef, value: *mut CFTypeRef) -> i32;
    fn AXUIElementGetTypeID() -> usize;
    fn AXValueGetTypeID() -> usize;
    fn AXObserverCreate(pid: i32, cb: extern "C" fn(CFTypeRef, CFTypeRef, CFStringRef, *mut c_void), out: *mut CFTypeRef) -> i32;
    fn AXObserverAddNotification(o: CFTypeRef, e: CFTypeRef, name: CFStringRef, refcon: *mut c_void) -> i32;
    fn AXObserverGetRunLoopSource(o: CFTypeRef) -> core_foundation::runloop::CFRunLoopSourceRef;
    fn AXValueGetType(v: CFTypeRef) -> u32;
    fn AXUIElementSetAttributeValue(e: CFTypeRef, a: CFStringRef, v: CFTypeRef) -> i32;
    fn AXUIElementIsAttributeSettable(e: CFTypeRef, a: CFStringRef, v: *mut bool) -> i32;
    fn AXUIElementCopyActionNames(e: CFTypeRef, v: *mut CFTypeRef) -> i32;
    fn AXUIElementPerformAction(e: CFTypeRef, a: CFStringRef) -> i32;
    fn AXUIElementCopyElementAtPosition(app: CFTypeRef, x: f32, y: f32, e: *mut CFTypeRef) -> i32;
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

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn TISCopyCurrentKeyboardLayoutInputSource() -> CFTypeRef;
    fn TISCopyCurrentASCIICapableKeyboardLayoutInputSource() -> CFTypeRef;
    fn TISGetInputSourceProperty(source: CFTypeRef, key: CFStringRef) -> CFTypeRef;
    static kTISPropertyUnicodeKeyLayoutData: CFStringRef;
    fn LMGetKbdType() -> u8;
    fn UCKeyTranslate(
        layout: *const u8,
        code: u16,
        action: u16,
        modifiers: u32,
        keyboard: u32,
        options: u32,
        dead: *mut u32,
        max: usize,
        len: *mut usize,
        out: *mut u16,
    ) -> i32;
}

const MAX_TREE_CHARS: usize = 60_000;
const MAX_VISITS: usize = 6_000;
const MAX_BUSY_VISITS: usize = 800;
const MAX_DEPTH: usize = 200;
const CLIPS: &[&str] = &["AXScrollArea", "AXWebArea"];
const BORING: &[&str] = &["AXShowMenu", "AXScrollToVisible", "AXShowDefaultUI", "AXShowAlternateUI"];
const SPARSE: &[&str] = &["AXWebArea", "AXGroup", "AXScrollArea", "AXLayoutArea", "AXUnknown"];
const TRANSIENT: &[&str] = &["AXDialog", "AXSystemDialog", "AXFloatingWindow", "AXSystemFloatingWindow"];
const POPUPS: &[&str] = &["AXSheet", "AXPopover", "AXDrawer", "AXMenu"];
const INVALID_ELEMENT: i32 = -25202;
const FETCH: &[&str] = &[
    "AXRole",
    "AXSubrole",
    "AXTitle",
    "AXDescription",
    "AXHelp",
    "AXValue",
    "AXVisibleCharacterRange",
    "AXPlaceholderValue",
    "AXURL",
    "AXIdentifier",
    "AXExpanded",
    "AXFocused",
    "AXEnabled",
    "AXSelected",
    "AXTitleUIElement",
    "AXPosition",
    "AXSize",
    "AXChildren",
];
const BUSY: &[&str] = &["AXBusyIndicator", "AXProgressIndicator"];
const PRESS_MS: u64 = 50;
const HOVER_MS: u64 = 30;
static EVENT_NUMBER: AtomicI64 = AtomicI64::new(1);
const SETTLE: Duration = Duration::from_millis(1000);
const SETTLE_MIN: Duration = Duration::from_millis(200);
const SETTLE_QUIET: Duration = Duration::from_millis(300);
const SETTLE_MAX: Duration = Duration::from_millis(2000);
const NOTICES: &[&str] = &[
    "AXCreated",
    "AXUIElementDestroyed",
    "AXValueChanged",
    "AXTitleChanged",
    "AXLayoutChanged",
    "AXFocusedUIElementChanged",
    "AXFocusedWindowChanged",
    "AXMainWindowChanged",
    "AXSelectedRowsChanged",
    "AXRowCountChanged",
    "AXSelectedChildrenChanged",
    "AXSelectedTextChanged",
    "AXMenuOpened",
    "AXMenuClosed",
    "AXWindowCreated",
    "AXLoadComplete",
];
static EPOCH: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

fn now_ms() -> i64 {
    EPOCH.get_or_init(Instant::now).elapsed().as_millis() as i64
}

#[derive(Default)]
struct Notices {
    last: AtomicI64,
    generation: AtomicU64,
}

extern "C" fn noticed(_: CFTypeRef, _: CFTypeRef, _: CFStringRef, refcon: *mut c_void) {
    let n = unsafe { &*(refcon as *const Notices) };
    n.last.store(now_ms(), Ordering::Relaxed);
    n.generation.fetch_add(1, Ordering::Relaxed);
}

#[derive(Clone)]
struct Metadata {
    actions: Vec<String>,
    settable: bool,
    attributed: bool,
}

#[derive(Default)]
struct Cache {
    generation: u64,
    entries: usize,
    map: HashMap<usize, Vec<(El, Metadata)>>,
}

const MAX_CACHED: usize = 20_000;

impl Cache {
    fn get(&self, e: &El, hash: usize) -> Option<Metadata> {
        self.map.get(&hash)?.iter().find(|(k, _)| k == e).map(|(_, metadata)| metadata.clone())
    }

    fn put(&mut self, e: &El, hash: usize, metadata: Metadata) {
        if self.entries >= MAX_CACHED {
            self.map.clear();
            self.entries = 0;
        }
        self.entries += 1;
        self.map.entry(hash).or_default().push((e.clone(), metadata));
    }
}

struct Observer {
    _observer: CFType,
    source: CFRunLoopSource,
    notices: Box<Notices>,
    cache: Cache,
}

impl Observer {
    fn new(pid: i32, ax: &El) -> Option<Observer> {
        let mut o: CFTypeRef = std::ptr::null();
        let status = unsafe { AXObserverCreate(pid, noticed, &mut o) };
        let observer = ax_result(status, o)?;
        let notices = Box::<Notices>::default();
        let refcon = &*notices as *const Notices as *mut c_void;
        let added = NOTICES
            .iter()
            .filter(|n| unsafe { AXObserverAddNotification(o, ax.as_CFTypeRef(), cfs(n).as_concrete_TypeRef(), refcon) } == 0)
            .count();
        if added == 0 {
            return None;
        }
        let source = unsafe { CFRunLoopSource::wrap_under_get_rule(AXObserverGetRunLoopSource(o)) };
        CFRunLoop::get_current().add_source(&source, unsafe { kCFRunLoopDefaultMode });
        Some(Observer { _observer: observer, source, notices, cache: Cache::default() })
    }

    fn drain() {
        for _ in 0..1000 {
            if !matches!(CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, Duration::ZERO, true), CFRunLoopRunResult::HandledSource)
            {
                return;
            }
        }
    }

    fn take_cache(&mut self) -> Cache {
        Self::drain();
        let generation = self.notices.generation.load(Ordering::Relaxed);
        let cache = std::mem::take(&mut self.cache);
        if cache.generation == generation {
            cache
        } else {
            Cache { generation, ..Cache::default() }
        }
    }
}

impl Drop for Observer {
    fn drop(&mut self) {
        CFRunLoop::get_current().remove_source(&self.source, unsafe { kCFRunLoopDefaultMode });
    }
}

struct App {
    name: String,
    bundle: Option<String>,
    pid: i32,
    active: bool,
    launched: Option<f64>,
    path: Option<std::path::PathBuf>,
}

struct Snapshot {
    window: u32,
    window_element: El,
    frame: Rect,
    elements: Vec<(u32, El)>,
    text: HashMap<u32, text::ObservedText>,
    markers: HashMap<u32, (El, String)>,
    lines: HashMap<Key, String>,
    ids: tree::Ids<El>,
}

impl Snapshot {
    fn matches_window(&self, element: &El, id: u32, frame: Option<Rect>) -> bool {
        self.window == id && &self.window_element == element && frame == Some(self.frame)
    }
}

#[derive(Default)]
pub struct Desk {
    cache: HashMap<i32, Snapshot>,
    touched: HashMap<i32, Instant>,
    enabled: HashMap<i32, Vec<(&'static str, bool)>>,
    observers: HashMap<i32, Observer>,
    launches: HashMap<i32, Option<f64>>,
}

impl Drop for Desk {
    fn drop(&mut self) {
        for (pid, prior) in &self.enabled {
            let current = NSRunningApplication::runningApplicationWithProcessIdentifier(*pid)
                .filter(|a| !a.isTerminated())
                .map(|a| a.launchDate().map(|d| d.timeIntervalSinceReferenceDate()));
            if current.as_ref() != self.launches.get(pid) {
                continue;
            }
            let ax = app_element(*pid);
            for (name, was) in prior {
                set_attr(&ax, name, &CFBoolean::from(*was).as_CFType());
            }
        }
    }
}

fn fail(code: ErrorCode, m: impl Into<String>) -> Failure {
    Failure::new(code, m)
}

fn cfs(s: &str) -> CFString {
    CFString::new(s)
}

fn ax_result(status: i32, value: CFTypeRef) -> Option<CFType> {
    if value.is_null() {
        return None;
    }
    let value = unsafe { CFType::wrap_under_create_rule(value) };
    (status == 0).then_some(value)
}

fn attr(e: &El, name: &str) -> Option<CFType> {
    let mut v: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(e.as_CFTypeRef(), cfs(name).as_concrete_TypeRef(), &mut v) };
    ax_result(err, v)
}

fn dead(e: &El) -> bool {
    let mut v: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(e.as_CFTypeRef(), cfs("AXRole").as_concrete_TypeRef(), &mut v) };
    if !v.is_null() {
        drop(unsafe { CFType::wrap_under_create_rule(v) });
    }
    err == INVALID_ELEMENT
}

fn app_element(pid: i32) -> El {
    unsafe { CFType::wrap_under_create_rule(AXUIElementCreateApplication(pid)) }
}

fn pid_of(element: &El) -> Option<i32> {
    let mut pid = 0;
    (unsafe { AXUIElementGetPid(element.as_CFTypeRef(), &mut pid) } == 0 && pid > 0).then_some(pid)
}

pub(crate) fn system_focused_pid() -> Option<i32> {
    let system = unsafe { AXUIElementCreateSystemWide() };
    if system.is_null() {
        return None;
    }
    let system = unsafe { CFType::wrap_under_create_rule(system) };
    pid_of(&attr(&system, "AXFocusedApplication")?)
}

fn text_of(v: &CFType) -> Option<String> {
    if let Some(s) = v.downcast::<CFString>() {
        return Some(s.to_string());
    }
    if let Some(url) = v.downcast::<CFURL>() {
        return Some(url.get_string().to_string());
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
    let status = unsafe { AXUIElementCopyActionNames(e.as_CFTypeRef(), &mut v) };
    ax_result(status, v).map(list).unwrap_or_default().iter().filter_map(text_of).collect()
}

fn set_attr(e: &El, name: &str, v: &CFType) -> i32 {
    unsafe { AXUIElementSetAttributeValue(e.as_CFTypeRef(), cfs(name).as_concrete_TypeRef(), v.as_CFTypeRef()) }
}

fn perform(host: &El, e: &El, action: &str) -> Result<(), Failure> {
    input::register_action_target(host, e)?;
    match unsafe { AXUIElementPerformAction(e.as_CFTypeRef(), cfs(action).as_concrete_TypeRef()) } {
        0 => Ok(()),
        n => Err(fail(ErrorCode::ActionFailed, format!("{action} failed (AXError {n})"))),
    }
}

fn app_policy_allowed(policy: NSApplicationActivationPolicy, include_accessory: bool) -> bool {
    policy == NSApplicationActivationPolicy::Regular || (include_accessory && policy == NSApplicationActivationPolicy::Accessory)
}

fn running(include_accessory: bool) -> Vec<App> {
    NSWorkspace::sharedWorkspace()
        .runningApplications()
        .iter()
        .filter(|a| app_policy_allowed(a.activationPolicy(), include_accessory))
        .map(|a| App {
            name: a.localizedName().map(|s| s.to_string()).unwrap_or_default(),
            bundle: a.bundleIdentifier().map(|s| s.to_string()),
            pid: a.processIdentifier(),
            active: a.isActive(),
            launched: a.launchDate().map(|d| d.timeIntervalSinceReferenceDate()),
            path: a.bundleURL().and_then(|url| url.path()).and_then(|path| std::fs::canonicalize(path.to_string()).ok()),
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
    crate::intervention::include_target(pid);
    e.set_integer_value_field(EventField::EVENT_SOURCE_UNIX_PROCESS_ID, std::process::id() as i64);
    e.post_to_pid(pid);
    std::thread::sleep(Duration::from_millis(8));
}

const EVENT_WINDOW_ID: u32 = 51;

fn in_window(e: &CGEvent, at: &Press, p: CGPoint) -> Result<(), Failure> {
    let pointer = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"CGEventSetWindowLocation".as_ptr()) };
    if pointer.is_null() {
        return Err(fail(ErrorCode::ActionFailed, "Window-relative event delivery is unavailable"));
    }
    let set_location: unsafe extern "C" fn(*mut c_void, CGPoint) = unsafe { std::mem::transmute(pointer) };
    e.set_integer_value_field(EVENT_WINDOW_ID, at.win as i64);
    e.set_integer_value_field(EventField::MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER, at.win as i64);
    e.set_integer_value_field(EventField::MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER_THAT_CAN_HANDLE_THIS_EVENT, at.win as i64);
    unsafe { set_location(e.as_ptr().cast(), pt(p.x - at.frame.x, p.y - at.frame.y)) };
    Ok(())
}

struct Press {
    host: El,
    owner: i32,
    window: El,
    win: u32,
    frame: Rect,
    number: i64,
}

fn validate_input_window(at: &Press) -> Result<(), Failure> {
    if window_id(&at.window) != at.win
        || !input::within(&at.window, &at.host)
        || input::window_geometry(at.win) != Some((at.owner, at.frame))
    {
        return Err(fail(ErrorCode::ActionFailed, "The input window moved, resized or closed; observe again before sending input"));
    }
    Ok(())
}

fn mouse(pid: i32, at: &Press, ty: CGEventType, p: CGPoint, b: CGMouseButton, clicks: i64, flags: CGEventFlags) -> Result<(), Failure> {
    let release = matches!(ty, CGEventType::LeftMouseUp | CGEventType::RightMouseUp | CGEventType::OtherMouseUp);
    if !release {
        validate_input_window(at)?;
    }
    let e = CGEvent::new_mouse_event(source()?, ty, p, b).map_err(|_| fail(ErrorCode::ActionFailed, "mouse event"))?;
    e.set_flags(flags);
    e.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, clicks);
    e.set_integer_value_field(EventField::MOUSE_EVENT_NUMBER, at.number);
    in_window(&e, at, p)?;
    if !release {
        active()?;
    }
    post(e, pid);
    Ok(())
}

fn prepare_window(pid: i32, host: &El, window: El, win: u32, p: CGPoint) -> Result<Press, Failure> {
    let (owner, frame) = input::window_geometry(win)
        .filter(|(owner, _)| *owner == pid)
        .ok_or_else(|| fail(ErrorCode::NoWindow, "Input window ownership is unavailable; observe again"))?;
    let press = Press { host: host.clone(), owner, window, win, frame, number: EVENT_NUMBER.fetch_add(1, Ordering::Relaxed) };
    mouse(pid, &press, CGEventType::MouseMoved, p, CGMouseButton::Left, 0, CGEventFlags::empty())?;
    cancellation::wait(Duration::from_millis(HOVER_MS));
    Ok(press)
}

fn click_at(pid: i32, press: Press, p: CGPoint, button: Button, count: u8, mods: &[Modifier], hold: u32) -> Result<(), Failure> {
    with_modifiers(pid, flags(mods), || click_at_inner(pid, press, p, button, count, mods, hold))
}

fn click_at_inner(pid: i32, mut press: Press, p: CGPoint, button: Button, count: u8, mods: &[Modifier], hold: u32) -> Result<(), Failure> {
    let hold = if hold == 0 { PRESS_MS } else { hold.min(10_000) as u64 };
    let (down, up, b) = match button {
        Button::Left => (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp, CGMouseButton::Left),
        Button::Right => (CGEventType::RightMouseDown, CGEventType::RightMouseUp, CGMouseButton::Right),
        Button::Middle => (CGEventType::OtherMouseDown, CGEventType::OtherMouseUp, CGMouseButton::Center),
    };
    for n in 1..=count.max(1) as i64 {
        active()?;
        if n > 1 {
            press.number = EVENT_NUMBER.fetch_add(1, Ordering::Relaxed);
        }
        mouse(pid, &press, down, p, b, n, flags(mods))?;
        cancellation::wait(Duration::from_millis(hold));
        mouse(pid, &press, up, p, b, n, flags(mods))?;
    }
    Ok(())
}

fn key(pid: i32, code: u16, flags: CGEventFlags, text: Option<&str>, hold: u32) -> Result<(), Failure> {
    send_key_events(pid, crate::keys::events(code, flags.bits()), text, hold)
}

fn send_key_events(pid: i32, steps: Vec<crate::keys::Event>, text: Option<&str>, hold: u32) -> Result<(), Failure> {
    active()?;
    let prepared = steps.into_iter().map(|step| key_event(step, text)).collect::<Result<Vec<_>, _>>()?;
    let mut failure = None;
    let mut releasing = false;
    let mut pressed = crate::keys::Pressed::default();
    for (step, e) in prepared {
        if step.release && !releasing {
            cancellation::wait(Duration::from_millis(hold.min(10_000) as u64));
            releasing = true;
        }
        if step.release && failure.is_none() {
            failure = active().err();
        }
        if !step.release {
            if failure.is_none() {
                failure = active().err();
            }
            if failure.is_some() {
                continue;
            }
        }
        if pressed.record(step) {
            post(e, pid);
        }
    }
    failure.map_or(Ok(()), Err)
}

fn key_event(step: crate::keys::Event, text: Option<&str>) -> Result<(crate::keys::Event, CGEvent), Failure> {
    let e = CGEvent::new_keyboard_event(source()?, step.code, step.down).map_err(|_| fail(ErrorCode::ActionFailed, "key event"))?;
    if step.modifier {
        e.set_type(CGEventType::FlagsChanged);
    }
    e.set_flags(CGEventFlags::from_bits_truncate(step.flags));
    if !step.modifier {
        if let Some(t) = text {
            e.set_string(t);
        }
    }
    Ok((step, e))
}

fn with_modifiers(pid: i32, flags: CGEventFlags, action: impl FnOnce() -> Result<(), Failure>) -> Result<(), Failure> {
    let prepared = crate::keys::events(0, flags.bits())
        .into_iter()
        .filter(|e| e.modifier)
        .map(|step| key_event(step, None))
        .collect::<Result<Vec<_>, _>>()?;
    let (down, up): (Vec<_>, Vec<_>) = prepared.into_iter().partition(|(step, _)| !step.release);
    let mut pressed = crate::keys::Pressed::default();
    let result = (|| {
        for (step, event) in down {
            active()?;
            pressed.record(step);
            post(event, pid);
        }
        action()
    })();
    for (step, event) in up {
        if pressed.record(step) {
            post(event, pid);
        }
    }
    result
}

fn layout_data(source: CFTypeRef) -> Option<CFData> {
    if source.is_null() {
        return None;
    }
    let source = unsafe { CFType::wrap_under_create_rule(source) };
    let data = unsafe { TISGetInputSourceProperty(source.as_CFTypeRef(), kTISPropertyUnicodeKeyLayoutData) };
    (!data.is_null()).then(|| unsafe { CFData::wrap_under_get_rule(data as _) })
}

fn keyboard() -> HashMap<char, Stroke> {
    keyboard_for_flags(CGEventFlags::empty())
}

fn keyboard_for_flags(flags: CGEventFlags) -> HashMap<char, Stroke> {
    let Some(data) = layout_data(unsafe { TISCopyCurrentKeyboardLayoutInputSource() })
        .or_else(|| layout_data(unsafe { TISCopyCurrentASCIICapableKeyboardLayoutInputSource() }))
    else {
        return HashMap::new();
    };
    let kind = unsafe { LMGetKbdType() } as u32;
    text::layout(|code, shift, option| {
        let modifiers =
            if shift { 2 } else { 0 } | if option { 8 } else { 0 } | if flags.contains(CGEventFlags::CGEventFlagCommand) { 1 } else { 0 };
        let (mut dead, mut len, mut out) = (0u32, 0usize, [0u16; 4]);
        let status =
            unsafe { UCKeyTranslate(data.bytes().as_ptr(), code, 0, modifiers, kind, 0, &mut dead, out.len(), &mut len, out.as_mut_ptr()) };
        if status != 0 || dead != 0 {
            return None;
        }
        let mut chars = char::decode_utf16(out[..len].iter().copied());
        match (chars.next(), chars.next()) {
            (Some(Ok(c)), None) => Some(c),
            _ => None,
        }
    })
}

fn type_text(pid: i32, s: &str) -> Result<(), Failure> {
    for k in text::plan(s, &keyboard()) {
        match k {
            TextKey::Return => key(pid, chord("return")?.0, CGEventFlags::empty(), None, 0)?,
            TextKey::Tab => key(pid, chord("tab")?.0, CGEventFlags::empty(), None, 0)?,
            TextKey::Mapped(c, stroke) => {
                let mut mods = vec![];
                if stroke.shift {
                    mods.push(Modifier::Shift);
                }
                if stroke.option {
                    mods.push(Modifier::Option);
                }
                key(pid, stroke.code, flags(&mods), Some(&c.to_string()), 0)?
            }
            TextKey::Unicode(c) => key(pid, 0, CGEventFlags::empty(), Some(&c.to_string()), 0)?,
        }
    }
    Ok(())
}

struct Field {
    element: El,
    value: String,
    selection: Option<(usize, usize)>,
}

fn field(ax: &El) -> Option<Field> {
    let element = attr(ax, "AXFocusedUIElement")?;
    let value = attr(&element, "AXValue")?.downcast::<CFString>()?.to_string();
    let selection = ax_value::<[isize; 2]>(&element, "AXSelectedTextRange", 4)
        .filter(|[start, len]| *start >= 0 && *len >= 0)
        .map(|[start, len]| (start as usize, len as usize));
    Some(Field { element, value, selection })
}

fn paste(pid: i32, ax: &El, s: &str, format: PasteFormat) -> Result<(), Failure> {
    let v = match keyboard_for_flags(CGEventFlags::CGEventFlagCommand).get(&'v') {
        Some(k) => k.code,
        None => chord("v")?.0,
    };
    let before = field(ax);
    let pasted = text::expected(s, format);
    let mut check = || {
        use crate::pasteboard::Check;
        match (&before, field(ax)) {
            (Some(b), Some(now))
                if now.element == b.element && pasted.iter().any(|p| text::inserted(&b.value, b.selection, &now.value, p)) =>
            {
                Check::Landed
            }
            (Some(_), Some(_)) => Check::NotYet,
            _ => Check::Unreadable,
        }
    };
    let cmd_v = || key(pid, v, CGEventFlags::CGEventFlagCommand, None, 0);
    crate::pasteboard::paste(s, format, cmd_v, &mut check, &active)
}

fn active() -> Result<(), Failure> {
    if cancellation::cancelled() {
        Err(fail(ErrorCode::ActionFailed, "Computer action cancelled"))
    } else {
        crate::focus::check_current()
    }
}

fn chord(k: &str) -> Result<(u16, Vec<Modifier>), Failure> {
    let parsed = crate::keys::parse(k).ok_or_else(|| fail(ErrorCode::UnknownKey, format!("unknown key {k}")))?;
    let mods = [
        (crate::keys::COMMAND, Modifier::Command),
        (crate::keys::SHIFT, Modifier::Shift),
        (crate::keys::OPTION, Modifier::Option),
        (crate::keys::CONTROL, Modifier::Control),
    ]
    .into_iter()
    .filter_map(|(bit, m)| (parsed.flags & bit != 0).then_some(m))
    .collect();
    Ok((parsed.code, mods))
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
    let candidates = [attr(app, "AXFocusedWindow"), attr(app, "AXMainWindow")]
        .into_iter()
        .flatten()
        .chain(attr(app, "AXWindows").into_iter().flat_map(list));
    for window in candidates {
        if bool_attr(&window, "AXMinimized") == Some(true) || window_id(&window) == 0 {
            continue;
        }
        let sheet = attr(&window, "AXSheets").into_iter().flat_map(list).next();
        if let Some(sheet) = sheet.filter(|sheet| window_id(sheet) != 0) {
            return Some(sheet);
        }
        return Some(window);
    }
    None
}

fn window_id(w: &El) -> u32 {
    let mut id = 0;
    unsafe { _AXUIElementGetWindow(w.as_CFTypeRef(), &mut id) };
    id
}

fn on_current_space(win: u32) -> bool {
    let Some(windows) = copy_window_info(kCGWindowListOptionOnScreenOnly, 0) else {
        return false;
    };
    windows.iter().any(|item| {
        let info = unsafe { CFDictionary::<CFString, CFType>::wrap_under_get_rule(*item as _) };
        let key = unsafe { CFString::wrap_under_get_rule(kCGWindowNumber) };
        info.find(key).and_then(|v| v.downcast::<CFNumber>()).and_then(|n| n.to_i64()) == Some(i64::from(win))
    })
}

struct Node {
    props: Props,
    has_value: bool,
    raw: Option<String>,
    rendered: Option<text::RenderedText>,
    frame: Option<Rect>,
    children: Vec<El>,
}

thread_local! {
    static FETCH_NAMES: CFArray<CFString> = CFArray::from_CFTypes(&FETCH.iter().map(|n| cfs(n)).collect::<Vec<_>>());
    static READINESS_NAMES: CFArray<CFString> = CFArray::from_CFTypes(&[cfs("AXRole"), cfs("AXChildren")]);
}

fn fetch_attributes(e: &El, names: &CFArray<CFString>) -> Vec<Option<CFType>> {
    let mut v: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyMultipleAttributeValues(e.as_CFTypeRef(), names.as_CFTypeRef(), 0, &mut v) };
    let Some(values) = ax_result(err, v) else {
        return names.iter().map(|name| attr(e, &name.to_string())).collect();
    };
    let values = list(values);
    let error = |x: &CFType| unsafe { CFGetTypeID(x.as_CFTypeRef()) == AXValueGetTypeID() && AXValueGetType(x.as_CFTypeRef()) == 5 };
    let mut out: Vec<Option<CFType>> = values.into_iter().map(|x| (!error(&x)).then_some(x)).collect();
    out.resize(names.len() as usize, None);
    out
}

fn point_of<T: Default>(v: &CFType, kind: u32) -> Option<T> {
    let mut out = T::default();
    unsafe { AXValueGetValue(v.as_CFTypeRef(), kind, &mut out as *mut T as *mut c_void) }.then_some(out)
}

fn fetch(e: &El) -> Node {
    let v = FETCH_NAMES.with(|names| fetch_attributes(e, names));
    let get = |name: &str| v[FETCH.iter().position(|n| *n == name).unwrap()].as_ref();
    let s = |name: &str| get(name).and_then(text_of).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let b = |name: &str| get(name).and_then(|v| v.downcast::<CFBoolean>()).map(bool::from);
    let title = s("AXTitle");
    let label = if title.is_none() {
        get("AXTitleUIElement").and_then(|l| str_attr(l, "AXValue").or_else(|| str_attr(l, "AXTitle")))
    } else {
        None
    };
    let has_value = get("AXValue").is_some();
    let role = s("AXRole").unwrap_or_else(|| "AXUnknown".into());
    let visible_text = matches!(role.as_str(), "AXTextArea" | "AXTextField")
        .then(|| {
            let value = get("AXValue").and_then(text_of)?;
            let range = get("AXVisibleCharacterRange").and_then(|v| point_of::<[isize; 2]>(v, 4))?;
            crate::text::visible_text(&value, range, tree::MAX_TEXT)
        })
        .flatten();
    let props = Props {
        role,
        visible_text,
        rich_text: None,
        subrole: s("AXSubrole"),
        title,
        description: s("AXDescription").or_else(|| s("AXHelp")),
        label,
        value: s("AXValue"),
        placeholder: s("AXPlaceholderValue"),
        url: s("AXURL"),
        identifier: s("AXIdentifier"),
        expanded: b("AXExpanded"),
        focused: b("AXFocused") == Some(true),
        disabled: b("AXEnabled") == Some(false),
        selected: b("AXSelected") == Some(true),
        settable: has_value,
        actions: vec![],
        list_item: false,
    };
    let frame = match (get("AXPosition").and_then(|p| point_of::<CGPoint>(p, 1)), get("AXSize").and_then(|p| point_of::<CGSize>(p, 2))) {
        (Some(p), Some(z)) => Some(Rect { x: p.x, y: p.y, w: z.width, h: z.height }),
        _ => None,
    };
    let children = get("AXChildren").cloned().map(list).unwrap_or_default();
    let raw = get("AXValue").or(get("AXTitle")).and_then(text_of);
    Node { props, has_value, raw, rendered: None, frame, children }
}

impl Node {
    fn marker_candidate(&self, clip: Rect) -> bool {
        !self.has_value
            && self.children.is_empty()
            && matches!(self.props.role.as_str(), "AXStaticText" | "AXTextArea" | "AXTextField")
            && self.frame.is_some_and(|frame| frame.w > 0.0 && frame.h > 0.0 && tree::intersect(frame, clip) == Some(frame))
    }

    fn limit_text(&mut self, budget: &mut usize) {
        if let Some(rendered) = &self.rendered {
            if let Some(remaining) = budget.checked_sub(rendered.retained_bytes()) {
                *budget = remaining;
            } else {
                self.rendered = None;
                self.props.rich_text = None;
            }
        }
    }
}

fn rebind_text(text: HashMap<u32, text::ObservedText>, moved: &HashMap<u32, u32>) -> HashMap<u32, text::ObservedText> {
    text.into_iter().map(|(id, text)| (*moved.get(&id).unwrap_or(&id), text)).collect()
}

fn attributed_supported(e: &El) -> bool {
    let mut names = std::ptr::null();
    let status = unsafe { AXUIElementCopyParameterizedAttributeNames(e.as_CFTypeRef(), &mut names) };
    ax_result(status, names).map(list).unwrap_or_default().iter().any(|name| text_of(name).as_deref() == Some("AXAttributedStringForRange"))
}

fn native_font_traits(name: &str, size: f64) -> Option<NSFontDescriptorSymbolicTraits> {
    if !size.is_finite() || size <= 0.0 {
        return None;
    }
    let system = NSFont::systemFontOfSize(size).fontDescriptor();
    for traits in [
        NSFontDescriptorSymbolicTraits::empty(),
        NSFontDescriptorSymbolicTraits::TraitBold,
        NSFontDescriptorSymbolicTraits::TraitItalic,
        NSFontDescriptorSymbolicTraits::TraitBold | NSFontDescriptorSymbolicTraits::TraitItalic,
    ] {
        let descriptor = system.fontDescriptorWithSymbolicTraits(traits);
        if let Some(font) = NSFont::fontWithDescriptor_size(&descriptor, size).filter(|font| font.fontName().to_string() == name) {
            return Some(font.fontDescriptor().symbolicTraits());
        }
    }
    NSFont::fontWithName_size(&NSString::from_str(name), size)
        .filter(|font| font.fontName().to_string() == name)
        .map(|font| font.fontDescriptor().symbolicTraits())
}

fn attributed_runs(value: &CFAttributedString, expected: &str) -> Option<Vec<(String, text::TextStyle)>> {
    let plain = unsafe { CFString::wrap_under_get_rule(CFAttributedStringGetString(value.as_concrete_TypeRef())) }.to_string();
    if plain != expected {
        return None;
    }
    let mut runs = vec![];
    let mut fonts = HashMap::new();
    let mut at = 0;
    while at < value.char_len() {
        if cancellation::cancelled() {
            return None;
        }
        let mut range = CFRange { location: 0, length: 0 };
        let attrs = unsafe { CFAttributedStringGetAttributes(value.as_concrete_TypeRef(), at, &mut range) };
        if attrs.is_null() || range.location > at || range.length <= 0 {
            return None;
        }
        let end = range.location.checked_add(range.length)?;
        if end <= at || end > value.char_len() {
            return None;
        }
        let attrs = unsafe { CFDictionary::<CFString, CFType>::wrap_under_get_rule(attrs) };
        let get = |key: &str| attrs.find(cfs(key)).map(|v| v.clone());
        let number = |key: &str| get(key).and_then(|v| v.downcast::<CFNumber>()).and_then(|v| v.to_i64());
        let flag = |key: &str| {
            get(key).and_then(|v| v.downcast::<CFBoolean>()).map(bool::from).unwrap_or_else(|| number(key).is_some_and(|v| v != 0))
        };
        let font_traits = get("AXFont")
            .and_then(|font| {
                let font = font.downcast::<CFDictionary>()?;
                let font = unsafe { CFDictionary::<CFString, CFType>::wrap_under_get_rule(font.as_concrete_TypeRef()) };
                let name = font.find(cfs("AXFontName")).and_then(|value| text_of(&value))?;
                let size = font.find(cfs("AXFontSize")).and_then(|value| value.downcast::<CFNumber>()).and_then(|value| value.to_f64())?;
                *fonts.entry((name.clone(), size.to_bits())).or_insert_with(|| native_font_traits(&name, size))
            })
            .unwrap_or_else(NSFontDescriptorSymbolicTraits::empty);
        let list_prefix = get("AXListItemPrefix")
            .and_then(|v| v.downcast::<CFAttributedString>())
            .map(|v| unsafe { CFString::wrap_under_get_rule(CFAttributedStringGetString(v.as_concrete_TypeRef())) }.to_string());
        let link = if let Some(link) = get("AXLink").filter(|link| link.type_of() == unsafe { AXUIElementGetTypeID() }) {
            if cancellation::cancelled() {
                return None;
            }
            str_attr(&link, "AXURL").filter(|url| url.len() <= 2048)
        } else {
            None
        };
        let style = text::TextStyle {
            bold: get("AXFontBold").map_or_else(|| font_traits.contains(NSFontDescriptorSymbolicTraits::TraitBold), |_| flag("AXFontBold")),
            italic: get("AXFontItalic")
                .map_or_else(|| font_traits.contains(NSFontDescriptorSymbolicTraits::TraitItalic), |_| flag("AXFontItalic")),
            underline: flag("AXUnderline"),
            strike: flag("AXStrikethrough"),
            link,
            list_prefix,
            list_level: number("AXListItemLevel").and_then(|v| usize::try_from(v).ok()).unwrap_or(0),
        };
        let run = text::visible_text(&plain, [at, end - at], tree::MAX_TEXT)?;
        runs.push((run.text, style));
        at = end;
    }
    Some(runs)
}

fn attributed_text(e: &El, n: &Node) -> Option<text::RenderedText> {
    let raw = n.raw.as_deref()?;
    let prefix;
    let visible = match n.props.visible_text.as_ref() {
        Some(visible) => visible,
        None => {
            prefix = text::visible_text(raw, [0, isize::try_from(raw.encode_utf16().count()).ok()?], tree::MAX_TEXT)?;
            &prefix
        }
    };
    if visible.text.is_empty() {
        return None;
    }
    let range = [isize::try_from(visible.start).ok()?, isize::try_from(visible.shown_end - visible.start).ok()?];
    let parameter = unsafe { AXValueCreate(4, range.as_ptr() as *const c_void) };
    if parameter.is_null() {
        return None;
    }
    let parameter = unsafe { CFType::wrap_under_create_rule(parameter) };
    let mut value = std::ptr::null();
    let result = unsafe {
        AXUIElementCopyParameterizedAttributeValue(
            e.as_CFTypeRef(),
            cfs("AXAttributedStringForRange").as_concrete_TypeRef(),
            parameter.as_CFTypeRef(),
            &mut value,
        )
    };
    let value = ax_result(result, value)?.downcast::<CFAttributedString>()?;
    let runs = attributed_runs(&value, &visible.text)?;
    let starts_line = visible.start == 0 || raw.encode_utf16().nth(visible.start - 1) == Some(10);
    let mut markdown = text::attributed_text(&runs, starts_line)?;
    markdown.offset(visible.start);
    if visible.shown_end < visible.end {
        markdown.syntax("\n… text truncated");
    }
    Some(markdown)
}

fn complete(e: &El, mut n: Node, cache: Option<&mut Cache>) -> Node {
    let hash = unsafe { CFHash(e.as_CFTypeRef()) };
    let text_role = matches!(n.props.role.as_str(), "AXTextArea" | "AXTextField" | "AXStaticText");
    let rich_candidate = text_role && (n.props.role != "AXStaticText" || n.children.is_empty());
    let cached = cache.as_ref().and_then(|c| c.get(e, hash));
    let uncached = cached.is_none();
    let metadata = cached.unwrap_or_else(|| Metadata {
        actions: actions(e).into_iter().filter(|a| !BORING.contains(&a.as_str())).collect(),
        settable: n.props.settable && settable(e, "AXValue"),
        attributed: text_role && attributed_supported(e),
    });
    if metadata.attributed && rich_candidate {
        n.rendered = attributed_text(e, &n);
        n.props.rich_text = n.rendered.as_ref().map(|rendered| rendered.markdown.clone());
    }
    n.props.actions = metadata.actions.clone();
    n.props.settable = metadata.settable;
    if let Some(c) = cache {
        if uncached {
            c.put(e, hash, metadata);
        }
    }
    n
}

fn extras(ax: &El, main: &El) -> Vec<El> {
    let mut out: Vec<El> = attr(ax, "AXChildren")
        .map(list)
        .unwrap_or_default()
        .into_iter()
        .filter(|c| str_attr(c, "AXRole").as_deref() == Some("AXMenu"))
        .collect();
    let bar = attr(ax, "AXMenuBar").map(|b| attr(&b, "AXChildren").map(list).unwrap_or_default()).unwrap_or_default();
    for item in bar.iter().filter(|i| bool_attr(i, "AXSelected") == Some(true)) {
        out.extend(
            attr(item, "AXChildren")
                .map(list)
                .unwrap_or_default()
                .into_iter()
                .filter(|c| str_attr(c, "AXRole").as_deref() == Some("AXMenu")),
        );
    }
    for w in attr(ax, "AXWindows").map(list).unwrap_or_default() {
        let role = str_attr(&w, "AXRole").unwrap_or_default();
        let sub = str_attr(&w, "AXSubrole").unwrap_or_default();
        if &w != main && (POPUPS.contains(&role.as_str()) || TRANSIENT.contains(&sub.as_str())) && !out.contains(&w) {
            out.push(w);
        }
    }
    out
}

#[derive(Clone, Copy)]
struct WalkAt {
    depth: usize,
    anchor: u32,
    clip: Rect,
    at: Locator,
}

struct Walk {
    ids: tree::Ids<El>,
    elements: Vec<(u32, El)>,
    text: HashMap<u32, text::ObservedText>,
    markers: HashMap<u32, (El, String)>,
    text_budget: usize,
    notes: HashMap<u32, u32>,
    truncated: bool,
    visited: usize,
    window: Rect,
    cache: Option<Cache>,
}

impl Walk {
    fn id(&mut self, e: &El, locator: Locator) -> u32 {
        let id = self.ids.assign(e, unsafe { CFHash(e.as_CFTypeRef()) }, locator);
        self.elements.push((id, e.clone()));
        id
    }

    fn full(&self) -> bool {
        self.visited >= MAX_VISITS || cancellation::cancelled()
    }

    fn note(&mut self, anchor: u32, s: String) -> Item {
        let seq = self.notes.entry(anchor).or_default();
        let key = Key::Note(anchor, *seq);
        *seq += 1;
        Item::leaf(key, s)
    }

    fn fold(&mut self, n: &mut Node) -> Option<Vec<Node>> {
        if !n.props.folds_text() || n.children.is_empty() || n.children.len() > 20 || self.visited + n.children.len() > MAX_VISITS {
            return None;
        }
        self.visited += n.children.len();
        let kids: Vec<Node> = n.children.iter().map(|c| complete(c, fetch(c), self.cache.as_mut())).collect();
        if kids.iter().all(|k| k.has_value && k.props.plain_text() && k.children.is_empty()) {
            let parts: Vec<(String, Option<Rect>)> = kids.iter().filter_map(|k| Some((k.raw.clone()?, k.frame))).collect();
            n.props.title = Some(tree::joined_text(&parts)).filter(|t| !t.is_empty());
            n.children.clear();
            None
        } else {
            Some(kids)
        }
    }

    fn visit(&mut self, e: &El, mut n: Node, context: WalkAt, force: bool, out: &mut Vec<Item>) {
        let WalkAt { depth, anchor, clip, at } = context;
        if depth > MAX_DEPTH {
            self.truncated = true;
            return;
        }
        let hash = unsafe { CFHash(e.as_CFTypeRef()) };
        if self.ids.seen(e, hash) {
            return;
        }
        let locator = at.child(&n.props);
        let mut marker_source = None;
        let mut marker_note = None;
        if n.marker_candidate(clip) {
            match markers::read(e) {
                Some(markers::Read::Text { range, raw, attributed }) => {
                    let retained = raw.capacity() * 3 + std::mem::size_of::<(El, String)>();
                    if let Some(remaining) = self.text_budget.checked_sub(retained) {
                        self.text_budget = remaining;
                        n.rendered = attributed_runs(&attributed, &raw).and_then(|runs| text::attributed_text(&runs, false));
                        n.props.rich_text = n.rendered.as_ref().map(|rendered| rendered.markdown.clone());
                        n.props.value = Some(raw.clone());
                        n.raw = Some(raw.clone());
                        marker_note = Some(format!(
                            "Text from element marker range: {} UTF-16 units; text selection unavailable",
                            raw.encode_utf16().count()
                        ));
                        marker_source = Some((range, raw));
                    } else {
                        self.truncated = true;
                        marker_note = Some("… marker text omitted; observation text budget reached".into());
                    }
                }
                Some(markers::Read::Omitted(length)) => {
                    self.truncated = true;
                    marker_note = Some(format!(
                        "… element marker range length is {length}; text not read because it exceeds the {}-unit limit",
                        tree::MAX_TEXT
                    ));
                }
                None => {}
            }
        }
        let prefetched = self.fold(&mut n);
        n.limit_text(&mut self.text_budget);
        let (s, keep) = n.props.describe();
        let keep = keep || force || marker_note.is_some();
        let clip = narrow(clip, &n.props.role, n.frame);
        let drawn = n.props.role == "AXWebArea" || n.children.is_empty();
        let (anchor, mut kids) = if keep { (self.id(e, locator), vec![]) } else { (anchor, vec![]) };
        self.children(&n.children, prefetched, WalkAt { depth: depth + 1, anchor, clip, at: locator }, n.props.content_list(), &mut kids);
        if kids.is_empty()
            && drawn
            && !self.truncated
            && SPARSE.contains(&n.props.role.as_str())
            && n.frame.is_some_and(|f| tree::sparse(f, self.window, 0))
        {
            let note =
                "… nothing readable inside; the app may draw this area itself (for example a canvas). Use the screenshot and point targets";
            kids.push(self.note(anchor, note.into()));
        }
        if keep {
            if let Some(note) = marker_note {
                kids.push(self.note(anchor, note));
            }
            if let Some(source) = marker_source {
                self.markers.insert(anchor, source);
            } else if let (Some(value), Some(rendered)) = (n.raw, n.rendered) {
                self.text.insert(anchor, text::ObservedText::new(&value, rendered));
            }
            out.push(Item { key: Key::Element(anchor), text: s, kids });
        } else {
            out.extend(kids);
        }
    }

    fn text_run(&mut self, run: &mut Vec<(El, Node)>, context: WalkAt, out: &mut Vec<Item>) {
        match run.len() {
            0 => {}
            1 => {
                let (e, n) = run.pop().unwrap();
                self.visit(&e, n, context, false, out);
            }
            _ => {
                let texts: Vec<(String, Option<Rect>)> = run.iter().filter_map(|(_, n)| Some((n.raw.clone()?, n.frame))).collect();
                let (first, n) = &run[0];
                let id = self.id(first, context.at.child(&n.props));
                out.push(Item::leaf(Key::Element(id), tree::merged_text(&texts)));
            }
        }
        run.clear();
    }

    fn children(&mut self, kids: &[El], prefetched: Option<Vec<Node>>, context: WalkAt, list: bool, out: &mut Vec<Item>) {
        let WalkAt { anchor, clip, .. } = context;
        let mut prefetched = prefetched.unwrap_or_default().into_iter();
        let mut hidden = 0;
        let mut run: Vec<(El, Node)> = vec![];
        for (i, c) in kids.iter().enumerate() {
            let prefetched_node = prefetched.next();
            if cancellation::cancelled() || (prefetched_node.is_none() && self.full()) {
                self.truncated = true;
                self.text_run(&mut run, context, out);
                let note = format!("… {} more not shown; the observation size limit was reached", kids.len() - i);
                out.push(self.note(anchor, note));
                break;
            }
            let loaded = prefetched_node.is_some();
            let n = prefetched_node.unwrap_or_else(|| {
                self.visited += 1;
                fetch(c)
            });
            if n.frame.is_some_and(|f| tree::visible(f, clip).is_none()) {
                hidden += 1;
                continue;
            }
            let mut n = if loaded { n } else { complete(c, n, self.cache.as_mut()) };
            n.props.list_item = list;
            if n.props.plain_text() && n.has_value && n.children.is_empty() {
                run.push((c.clone(), n));
                continue;
            }
            self.text_run(&mut run, context, out);
            self.visit(c, n, context, false, out);
        }
        self.text_run(&mut run, context, out);
        if hidden > 0 {
            out.push(self.note(anchor, format!("… {hidden} more offscreen; scroll to reveal")));
        }
    }
}

fn relocate(roots: &[(El, Locator)], target: Locator) -> Option<El> {
    let mut queue: std::collections::VecDeque<(El, Locator)> = roots.iter().cloned().collect();
    let (mut found, mut seen) = (None, 0);
    while let Some((e, at)) = queue.pop_front() {
        seen += 1;
        if seen > MAX_VISITS || cancellation::cancelled() {
            return None;
        }
        let n = fetch(&e);
        let here = at.child(&n.props);
        if here == target {
            if found.is_some() {
                return None;
            }
            found = Some(e);
        }
        queue.extend(n.children.into_iter().map(|c| (c, here)));
    }
    found
}

fn empty_web(e: &El, depth: usize, seen: &mut usize) -> bool {
    *seen += 1;
    if *seen > MAX_BUSY_VISITS || depth > MAX_DEPTH {
        return false;
    }
    let mut values = READINESS_NAMES.with(|names| fetch_attributes(e, names)).into_iter();
    let role = values.next().flatten().as_ref().and_then(text_of);
    let kids = values.next().flatten().map(list).unwrap_or_default();
    if role.as_deref() == Some("AXWebArea") {
        return kids.is_empty();
    }
    kids.iter().any(|c| empty_web(c, depth + 1, seen))
}

fn narrow(clip: Rect, role: &str, f: Option<Rect>) -> Rect {
    match f {
        Some(f) if CLIPS.contains(&role) => tree::intersect(f, clip).unwrap_or(Rect { w: 0.0, h: 0.0, ..clip }),
        _ => clip,
    }
}

fn visible_rect(e: &El, f: Rect, window: Rect) -> Option<Rect> {
    let mut clips = vec![];
    let mut root = None;
    let mut parent = attr(e, "AXParent");
    for _ in 0..MAX_DEPTH {
        let Some(p) = parent else { break };
        let role = str_attr(&p, "AXRole").unwrap_or_default();
        if role == "AXWindow" || role == "AXApplication" {
            root = Some((role, p));
            break;
        }
        if CLIPS.contains(&role.as_str()) {
            clips.push((role, frame(&p)));
        }
        parent = attr(&p, "AXParent");
    }
    let everywhere = Rect { x: -1e9, y: -1e9, w: 2e9, h: 2e9 };
    let base = match root {
        Some((role, w)) if role == "AXWindow" => frame(&w).unwrap_or(window),
        Some(_) => everywhere,
        None => window,
    };
    let clip = clips.iter().rev().fold(base, |c, (role, f)| narrow(c, role, *f));
    tree::visible(f, clip)
}

fn busy(e: &El, depth: usize, seen: &mut usize) -> bool {
    *seen += 1;
    if *seen > MAX_BUSY_VISITS || depth > MAX_DEPTH {
        return false;
    }
    let mut values = READINESS_NAMES.with(|names| fetch_attributes(e, names)).into_iter();
    if values.next().flatten().as_ref().and_then(text_of).is_some_and(|role| BUSY.contains(&role.as_str())) {
        return true;
    }
    values.next().flatten().map(list).unwrap_or_default().iter().any(|c| busy(c, depth + 1, seen))
}

fn select(
    ax: &El,
    e: &El,
    observed: Option<&text::ObservedText>,
    text: &str,
    prefix: &str,
    suffix: &str,
    selection: Selection,
) -> Result<(), Failure> {
    if !settable(e, "AXSelectedTextRange") {
        return Err(fail(ErrorCode::ActionFailed, "The element does not support setting its text selection"));
    }
    let value = attr(e, "AXValue")
        .and_then(|v| text_of(&v))
        .ok_or_else(|| fail(ErrorCode::ActionFailed, "The element's text value could not be read"))?;
    let range = text::observed_selection_range(&value, observed, text, prefix, suffix, selection)
        .map_err(|message| fail(ErrorCode::ActionFailed, message))?;
    input::register_target(ax, e)?;
    if bool_attr(e, "AXFocused") != Some(true) {
        let status = set_attr(e, "AXFocused", &CFBoolean::true_value().as_CFType());
        if status != 0 || bool_attr(e, "AXFocused") != Some(true) {
            return Err(fail(
                ErrorCode::ActionFailed,
                format!("Focusing the element failed (AXError {status}); its selection was not changed"),
            ));
        }
    }
    if attr(e, "AXValue").and_then(|v| text_of(&v)).as_ref() != Some(&value) {
        return Err(fail(ErrorCode::ActionFailed, "The element's text changed while focusing it; observe it again before selecting"));
    }
    active()?;
    let v = unsafe { CFType::wrap_under_create_rule(AXValueCreate(4, range.as_ptr() as *const c_void)) };
    match set_attr(e, "AXSelectedTextRange", &v) {
        0 => Ok(()),
        n => Err(fail(ErrorCode::ActionFailed, format!("setting the selection failed (AXError {n})"))),
    }
}

fn quiet(since: Instant, notices: &Notices, minimum: Duration, silence: Duration, maximum: Duration) {
    let start = now_ms() - since.elapsed().as_millis() as i64;
    loop {
        CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, Duration::from_millis(50), false);
        let elapsed = since.elapsed();
        let last = notices.last.load(Ordering::Relaxed).max(start);
        if active().is_err() || elapsed >= maximum {
            return;
        }
        if elapsed >= minimum && now_ms() - last >= silence.as_millis() as i64 {
            return;
        }
    }
}

fn settle(w: &El, since: Instant, notices: Option<&Notices>) {
    if let Some(n) = notices {
        quiet(since, n, SETTLE_MIN, SETTLE_QUIET, SETTLE_MAX);
    } else {
        cancellation::wait(SETTLE.saturating_sub(since.elapsed()));
    }
    for _ in 0..16 {
        if cancellation::cancelled() || !busy(w, 0, &mut 0) {
            return;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
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
    fn sync_app(&mut self, app: &App) {
        if self.launches.get(&app.pid) == Some(&app.launched) {
            return;
        }
        self.cache.remove(&app.pid);
        self.touched.remove(&app.pid);
        self.enabled.remove(&app.pid);
        self.observers.remove(&app.pid);
        self.launches.insert(app.pid, app.launched);
    }

    pub fn handle(&mut self, cmd: Command, pace: &mut dyn FnMut(u32, Point) -> Result<(), Failure>) -> Reply {
        objc2::rc::autoreleasepool(|_| self.handle_inner(cmd, pace))
    }

    fn handle_inner(&mut self, cmd: Command, pace: &mut dyn FnMut(u32, Point) -> Result<(), Failure>) -> Reply {
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

    fn enable(&mut self, pid: i32, ax: &El, w: &El) {
        if self.enabled.contains_key(&pid) {
            return;
        }
        let mut prior = vec![];
        let mut turn_on = |name: &'static str| {
            let was = bool_attr(ax, name);
            let on = was == Some(true) || set_attr(ax, name, &CFBoolean::true_value().as_CFType()) == 0;
            if on && was != Some(true) {
                prior.push((name, false));
            }
            on
        };
        let manual = turn_on("AXManualAccessibility");
        let wait = || {
            for _ in 0..10 {
                if cancellation::cancelled() || !empty_web(w, 0, &mut 0) {
                    return true;
                }
                cancellation::wait(Duration::from_millis(100));
            }
            false
        };
        if !wait() && !manual {
            turn_on("AXEnhancedUserInterface");
            wait();
        }
        self.enabled.insert(pid, prior);
    }

    fn observe(&mut self, app: &App, shot: bool, diff: bool) -> Result<Observation, Failure> {
        self.sync_app(app);
        if let Some(at) = self.touched.remove(&app.pid) {
            let (_, w) = window(app)?;
            settle(&w, at, self.observers.get(&app.pid).map(|o| &*o.notices));
        }
        let (ax, w) = window(app)?;
        self.enable(app.pid, &ax, &w);
        if let std::collections::hash_map::Entry::Vacant(slot) = self.observers.entry(app.pid) {
            if let Some(o) = Observer::new(app.pid, &ax) {
                slot.insert(o);
            }
        }
        let win = window_id(&w);
        let f = frame(&w).unwrap_or(Rect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 });
        let mut prev = self.cache.remove(&app.pid).filter(|s| s.window == win);
        let mut walk = Walk {
            ids: prev.as_mut().map(|p| std::mem::take(&mut p.ids)).unwrap_or_default(),
            elements: vec![],
            text: HashMap::new(),
            markers: HashMap::new(),
            text_budget: 1024 * 1024,
            notes: HashMap::new(),
            truncated: false,
            visited: 0,
            window: f,
            cache: self.observers.get_mut(&app.pid).map(Observer::take_cache),
        };
        let mut items = vec![];
        let everywhere = Rect { x: -1e9, y: -1e9, w: 2e9, h: 2e9 };
        let others = extras(&ax, &w);
        if !others.is_empty() {
            items.push(Item::leaf(Key::Section(0), "Open menus and other windows of this app:".into()));
            for o in &others {
                let n = complete(o, fetch(o), walk.cache.as_mut());
                walk.visit(o, n, WalkAt { depth: 0, anchor: ROOT, clip: everywhere, at: Locator::ROOT }, true, &mut items);
            }
            let title = str_attr(&w, "AXTitle").unwrap_or_default();
            items.push(Item::leaf(Key::Section(1), format!("Window \"{}\":", tree::clip(&title, 80))));
        }
        let kids = attr(&w, "AXChildren").map(list).unwrap_or_default();
        walk.children(
            &kids,
            None,
            WalkAt { depth: 0, anchor: ROOT, clip: if f.w > 0.0 && f.h > 0.0 { f } else { everywhere }, at: Locator::ROOT },
            false,
            &mut items,
        );
        if let (Some(o), Some(c)) = (self.observers.get_mut(&app.pid), walk.cache.take()) {
            o.cache = c;
        }
        let moved = walk.ids.rebind(dead);
        items.iter_mut().for_each(|i| i.renumber(&moved));
        walk.text = rebind_text(walk.text, &moved);
        walk.markers = walk.markers.into_iter().map(|(id, source)| (*moved.get(&id).unwrap_or(&id), source)).collect();
        for (id, _) in walk.elements.iter_mut() {
            *id = *moved.get(id).unwrap_or(id);
        }
        let (mut lines, cut) = tree::layout(&items, MAX_TREE_CHARS);
        if let Some(focus) = attr(&ax, "AXFocusedUIElement") {
            let what = match walk.elements.iter().find(|(_, e)| *e == focus) {
                Some((id, _)) if lines.iter().any(|(k, _)| *k == Key::Element(*id)) => format!("[{id}]"),
                _ => format!("{} (not in the tree above)", complete(&focus, fetch(&focus), None).props.describe().0),
            };
            lines.push((Key::Info(0), format!("Focus: {what}")));
            if let Some(sel) = str_attr(&focus, "AXSelectedText") {
                lines.push((Key::Info(1), format!("Selected text: \"{}\"", tree::clip(&sel, tree::MAX_TEXT))));
            }
        }
        let screenshot = if shot {
            let related = input::related_windows(app.pid, &w, f, &others);
            Some(capture(&w, f, &related)?)
        } else {
            None
        };
        let moved: HashSet<u32> = moved.into_values().collect();
        let rendered = tree::render(&lines, prev.as_ref().filter(|_| diff).map(|p| &p.lines), &moved);
        let obs = Observation {
            app: app.name.clone(),
            bundle_id: app.bundle.clone(),
            pid: app.pid,
            window: str_attr(&w, "AXTitle").unwrap_or_default(),
            window_id: win,
            frame: f,
            elements: lines.iter().filter(|(k, _)| matches!(k, Key::Element(_))).count() as u32,
            truncated: walk.truncated || cut,
            diffed: rendered.diffed,
            tree: rendered.tree,
            removed: rendered.removed,
            screenshot,
        };
        let lines: HashMap<_, _> = lines.into_iter().collect();
        self.cache.insert(
            app.pid,
            Snapshot {
                window: win,
                window_element: w.clone(),
                frame: f,
                elements: walk.elements,
                text: walk.text.into_iter().filter(|(id, _)| lines.contains_key(&Key::Element(*id))).collect(),
                markers: walk.markers.into_iter().filter(|(id, _)| lines.contains_key(&Key::Element(*id))).collect(),
                lines,
                ids: walk.ids.carry(),
            },
        );
        Ok(obs)
    }

    fn act(
        &mut self,
        query: &str,
        actions: &[Action],
        observe: Option<(bool, bool)>,
        mut pace: Option<&mut dyn FnMut(u32, Point) -> Result<(), Failure>>,
    ) -> Result<Reply, Failure> {
        let app = resolve(query)?;
        self.sync_app(&app);
        if !self.cache.contains_key(&app.pid) {
            return Err(fail(ErrorCode::BadIndex, "Observe this app before acting; its previous observation is no longer available"));
        }
        let (ax, w) = window(&app)?;
        let win = window_id(&w);
        if !on_current_space(win) {
            return Err(fail(ErrorCode::NoWindow, "Window is not visible on the current Space; switch Spaces and observe again"));
        }
        let mut focus = if actions.iter().any(|a| !matches!(a, Action::Wait { .. } | Action::Raise)) {
            Some(crate::focus::Focus::begin(app.pid, win)?)
        } else {
            None
        };
        let mut completed = 0;
        let mut failure = None;
        let mut previous = Instant::now();
        for (i, a) in actions.iter().enumerate() {
            if i > 0 && !matches!(a, Action::Wait { .. }) && !matches!(actions[i - 1], Action::Wait { .. }) {
                if let Some(o) = self.observers.get(&app.pid) {
                    quiet(previous, &o.notices, Duration::from_millis(60), Duration::from_millis(120), Duration::from_millis(800));
                } else {
                    cancellation::wait(Duration::from_millis(120).saturating_sub(previous.elapsed()));
                }
            }
            if matches!(a, Action::Raise) {
                if let Some(mut guard) = focus.take() {
                    if let Err(mut error) = guard.finish() {
                        error.action = Some(i as u32);
                        failure = Some(error);
                        break;
                    }
                }
            }
            let paced =
                focus.as_ref().map_or(Ok(()), |f| f.check()).and_then(|_| self.validate_window(&app)).and_then(|_| match pace.as_mut() {
                    Some(p) => match self.aim(app.pid, &w, a) {
                        Ok(Some(at)) => p(i as u32, Point { x: at.x, y: at.y }),
                        Ok(None) => Ok(()),
                        Err(e) => Err(e),
                    },
                    None => Ok(()),
                });
            if let Err(mut e) = paced
                .and_then(|_| self.validate_window(&app))
                .and_then(|_| self.step(&app, &ax, &w, a))
                .and_then(|_| focus.as_ref().map_or(Ok(()), |f| f.check()))
            {
                e.action = Some(i as u32);
                failure = Some(e);
                break;
            }
            completed += 1;
            previous = Instant::now();
        }
        if let Some(mut guard) = focus.take() {
            if let Err(error) = guard.finish() {
                if let Some(failure) = &mut failure {
                    failure.message += &format!("; background focus cleanup also failed: {}", error.message);
                } else {
                    failure = Some(error);
                }
            }
        }
        let attempted = (completed as usize + 1).min(actions.len());
        if actions[..attempted].iter().any(|a| !matches!(a, Action::Wait { .. })) {
            self.touched.insert(app.pid, Instant::now());
        }
        let (observation, observation_failure) = match observe {
            Some((shot, diff)) => match self.observe(&app, shot, diff) {
                Ok(observation) => (Some(observation), None),
                Err(error) => (None, Some(error)),
            },
            None => (None, None),
        };
        Ok(Reply::Acted { completed, failure, observation, observation_failure })
    }

    fn validate_window(&self, app: &App) -> Result<(), Failure> {
        active()?;
        let (_, current) = window(app)?;
        let snapshot = self.cache.get(&app.pid).ok_or_else(|| fail(ErrorCode::BadIndex, "Observe before acting"))?;
        let current_id = window_id(&current);
        if !snapshot.matches_window(&current, current_id, frame(&current)) || !on_current_space(current_id) {
            return Err(fail(ErrorCode::BadIndex, "The window changed or moved; observe again before acting"));
        }
        Ok(())
    }

    fn element(&self, pid: i32, index: u32) -> Result<El, Failure> {
        let s = self.cache.get(&pid).ok_or_else(|| fail(ErrorCode::BadIndex, "observe first"))?;
        let e = s
            .elements
            .iter()
            .find(|(id, _)| *id == index)
            .map(|(_, e)| e.clone())
            .ok_or_else(|| fail(ErrorCode::BadIndex, format!("no element {index}; observe again")))?;
        let gone = || fail(ErrorCode::BadIndex, format!("element {index} changed or is gone; observe again before acting"));
        let target = s.ids.locator(index).ok_or_else(gone)?;
        let mut roots: Vec<(El, Locator)> =
            attr(&s.window_element, "AXChildren").map(list).unwrap_or_default().into_iter().map(|c| (c, Locator::ROOT)).collect();
        roots.extend(extras(&app_element(pid), &s.window_element).into_iter().map(|o| (o, Locator::ROOT)));
        if !dead(&e) {
            let current = tree::path_locator(&e, &roots, MAX_DEPTH, |element| {
                if cancellation::cancelled() {
                    return None;
                }
                Some((fetch(element).props, attr(element, "AXParent")))
            });
            return if current == Some(target) { Ok(e) } else { Err(gone()) };
        }
        if !target.rebindable {
            return Err(gone());
        }
        relocate(&roots, target).ok_or_else(gone)
    }

    fn point(&self, pid: i32, t: Target) -> Result<CGPoint, Failure> {
        match t {
            Target::Point(p) => {
                let o = self.cache.get(&pid).map(|s| (s.frame.x, s.frame.y)).unwrap_or((0.0, 0.0));
                Ok(pt(o.0 + p.x, o.1 + p.y))
            }
            Target::Index(i) => {
                let e = self.element(pid, i)?;
                let window = self.cache.get(&pid).and_then(|s| frame(&s.window_element));
                let visible = || {
                    let f = frame(&e).ok_or_else(|| fail(ErrorCode::BadIndex, format!("element {i} has no frame")))?;
                    Ok::<_, Failure>(window.map_or(Some(f), |w| visible_rect(&e, f, w)))
                };
                let r = match visible()? {
                    Some(r) => r,
                    None => {
                        let scrolled = perform(&app_element(pid), &e, "AXScrollToVisible");
                        cancellation::wait(Duration::from_millis(250));
                        visible()?.ok_or_else(|| {
                            let why = scrolled.err().map(|e| format!(" ({})", e.message)).unwrap_or_default();
                            fail(
                                ErrorCode::ActionFailed,
                                format!(
                                    "element {i} is offscreen and could not be scrolled into view{why}; scroll toward it and observe again"
                                ),
                            )
                        })?
                    }
                };
                input::clickable(&app_element(pid), &e, i, r)
            }
        }
    }

    fn pointer(&self, ax: &El, p: CGPoint) -> Result<(i32, Press), Failure> {
        if input::menu_open(ax) {
            return Err(fail(ErrorCode::ActionFailed, input::MENU_OPEN));
        }
        let (owner, anchor, win, _) = input::service_at(ax, p)?;
        Ok((owner, prepare_window(owner, ax, anchor, win, p)?))
    }

    fn pressed(&self, pid: i32, ax: &El, index: u32) -> Result<Option<El>, Failure> {
        let e = self.element(pid, index)?;
        if input::menu_open(ax) && !input::is_menu_item(&e) {
            return Err(fail(ErrorCode::ActionFailed, input::MENU_OPEN));
        }
        let can_press = actions(&e).iter().any(|a| a == "AXPress");
        Ok((can_press && (input::is_menu_item(&e) || !input::simulate(&e) || frame(&e).is_none())).then_some(e))
    }

    fn aim(&self, pid: i32, w: &El, a: &Action) -> Result<Option<CGPoint>, Failure> {
        match a {
            Action::Click { target: Target::Index(i), button: Button::Left, count: 1, modifiers, hold_ms: 0 }
                if modifiers.is_empty() && self.pressed(pid, &app_element(pid), *i)?.is_some() =>
            {
                Ok(None)
            }
            Action::Click { target, .. } | Action::Scroll { target: Some(target), .. } => self.point(pid, *target).map(Some),
            Action::Scroll { target: None, .. } => Ok(Some(center(w))),
            Action::Drag { from, .. } => self.point(pid, Target::Point(*from)).map(Some),
            _ => Ok(None),
        }
    }

    fn step(&self, app: &App, ax: &El, w: &El, a: &Action) -> Result<(), Failure> {
        let pid = app.pid;
        match a {
            Action::Click { target: Target::Index(i), button: Button::Left, count: 1, modifiers, hold_ms: 0 } if modifiers.is_empty() => {
                if let Some(e) = self.pressed(pid, ax, *i)? {
                    return perform(ax, &e, "AXPress");
                }
                match self.point(pid, Target::Index(*i)) {
                    Ok(p) => {
                        let (to, press) = self.pointer(ax, p)?;
                        click_at(to, press, p, Button::Left, 1, &[], 0)
                    }
                    Err(e) => Err(e),
                }
            }
            Action::Click { target, button, count, modifiers, hold_ms } => {
                let p = self.point(pid, *target)?;
                let (to, press) = self.pointer(ax, p)?;
                click_at(to, press, p, *button, *count, modifiers, *hold_ms)
            }
            Action::TypeText { text } => type_text(input::keyboard_target(ax)?.0, text),
            Action::Paste { text, format } => {
                let (to, target) = input::keyboard_target(ax)?;
                paste(to, &target, text, *format)
            }
            Action::SelectText { index, text, prefix, suffix, selection } => {
                if self.cache.get(&pid).is_some_and(|snapshot| snapshot.markers.contains_key(index)) {
                    return Err(fail(
                        ErrorCode::ActionFailed,
                        "This element exposes text markers without a numeric text value; selection by text is unavailable",
                    ));
                }
                select(
                    ax,
                    &self.element(pid, *index)?,
                    self.cache.get(&pid).and_then(|snapshot| snapshot.text.get(index)),
                    text,
                    prefix,
                    suffix,
                    *selection,
                )
            }
            Action::PressKey { key: k, hold_ms } => {
                let mut chord = crate::keys::parse(k).ok_or_else(|| fail(ErrorCode::UnknownKey, format!("unknown key {k}")))?;
                if let Some(c) = chord.character {
                    if let Some(stroke) = keyboard_for_flags(CGEventFlags::from_bits_truncate(chord.flags)).get(&c) {
                        chord.remap(*stroke);
                    }
                }
                send_key_events(
                    input::keyboard_target(ax)?.0,
                    crate::keys::events_with_modifiers(chord.code, chord.flags, &chord.modifiers),
                    None,
                    *hold_ms,
                )
            }
            Action::Scroll { target, direction, amount } => {
                if input::menu_open(ax) {
                    return Err(fail(ErrorCode::ActionFailed, input::MENU_OPEN));
                }
                let mut viewport = None;
                if let Amount::Pages(n) = amount {
                    let area = match target {
                        Some(Target::Index(i)) => input::scroll_area(&self.element(pid, *i)?),
                        Some(t) => input::area_at(ax, self.point(pid, *t)?),
                        None => input::area_at(ax, center(w)),
                    };
                    if let Some(area) = area {
                        viewport = frame(&area);
                        if input::scroll_pages(ax, &area, *direction, *n)? {
                            return Ok(());
                        }
                    }
                }
                let p = match target {
                    Some(t) => self.point(pid, *t)?,
                    None => center(w),
                };
                let view = match target {
                    Some(Target::Index(i)) => frame(&self.element(pid, *i)?),
                    _ => frame(w),
                }
                .unwrap_or(Rect { x: 0.0, y: 0.0, w: 600.0, h: 600.0 });
                let (to, press) = self.pointer(ax, p)?;
                let mut left = input::scroll_pixels(*amount, *direction, viewport, view);
                while left > 0 {
                    active()?;
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
                    validate_input_window(&press)?;
                    in_window(&e, &press, p)?;
                    active()?;
                    post(e, to);
                }
                Ok(())
            }
            Action::Drag { from, to } => {
                let (a, b) = (self.point(pid, Target::Point(*from))?, self.point(pid, Target::Point(*to))?);
                let none = CGEventFlags::empty();
                let (pid, press) = self.pointer(ax, a)?;
                mouse(pid, &press, CGEventType::LeftMouseDown, a, CGMouseButton::Left, 1, none)?;
                let mut last = a;
                let dragged = (|| {
                    cancellation::wait(Duration::from_millis(PRESS_MS));
                    for s in 1..=12 {
                        active()?;
                        let t = s as f64 / 12.0;
                        let point = pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
                        mouse(pid, &press, CGEventType::LeftMouseDragged, point, CGMouseButton::Left, 1, none)?;
                        last = point;
                        cancellation::wait(Duration::from_millis(12));
                    }
                    Ok(())
                })();
                let released = mouse(pid, &press, CGEventType::LeftMouseUp, last, CGMouseButton::Left, 1, none);
                dragged.and(released)
            }
            Action::SetValue { index, value, submit } => input::set_value(pid, &self.element(pid, *index)?, *index, value, *submit),
            Action::Perform { index, action } => {
                let name = if action.starts_with("AX") { action.clone() } else { format!("AX{action}") };
                let element = self.element(pid, *index)?;
                let listed = actions(&element);
                if !listed.contains(&name) {
                    return Err(fail(
                        ErrorCode::ActionFailed,
                        format!("action {name} is not listed for element {index}; listed actions: {}", listed.join(", ")),
                    ));
                }
                perform(ax, &element, &name)
            }
            Action::Raise => {
                input::register_action_target(ax, w)?;
                let status = set_attr(ax, "AXFrontmost", &CFBoolean::true_value().as_CFType());
                if status != 0 {
                    return Err(fail(ErrorCode::ActionFailed, format!("setting AXFrontmost failed (AXError {status})")));
                }
                perform(ax, w, "AXRaise")
            }
            Action::Wait { ms } => {
                cancellation::wait(Duration::from_millis((*ms).min(10_000) as u64));
                Ok(())
            }
        }
    }
}

fn apps() -> Result<Reply, Failure> {
    let apps = running(false).into_iter().map(|a| AppInfo { name: a.name, bundle_id: a.bundle, pid: a.pid, active: a.active }).collect();
    Ok(Reply::Apps { apps })
}

fn resolve(query: &str) -> Result<App, Failure> {
    if !unsafe { AXIsProcessTrusted() } {
        return Err(fail(ErrorCode::PermissionMissing, "Accessibility not granted; run `desk permissions --prompt`"));
    }
    let path = if std::path::Path::new(query).is_absolute() {
        Some(
            std::fs::canonicalize(query)
                .map_err(|error| fail(ErrorCode::AppNotFound, format!("Cannot resolve app path {query}: {error}")))?,
        )
    } else {
        None
    };
    let find = || select_app(running(true), query, path.as_deref());
    if find()?.is_none() {
        let flag = if path.is_none() && query.contains('.') && !query.contains(' ') { "-b" } else { "-a" };
        let opened = std::process::Command::new("/usr/bin/open").args(["-g", flag, query]).status().is_ok_and(|s| s.success());
        if !opened {
            return Err(fail(ErrorCode::AppNotFound, format!("could not open {query}")));
        }
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        active()?;
        let pending = match find()? {
            Some(app) => {
                let launched =
                    NSRunningApplication::runningApplicationWithProcessIdentifier(app.pid).is_some_and(|app| app.isFinishedLaunching());
                if launched {
                    match window(&app) {
                        Ok(_) => return Ok(app),
                        Err(error) => error,
                    }
                } else {
                    fail(ErrorCode::NoWindow, format!("{} did not finish launching", app.name))
                }
            }
            None => fail(ErrorCode::AppNotFound, format!("{query} did not start or exited before becoming ready")),
        };
        if Instant::now() >= deadline {
            return Err(pending);
        }
        CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, Duration::from_millis(100), false);
    }
}

fn select_app(apps: Vec<App>, query: &str, path: Option<&std::path::Path>) -> Result<Option<App>, Failure> {
    let mut matches: Vec<_> = apps
        .into_iter()
        .filter(|app| match path {
            Some(path) => app.path.as_deref() == Some(path),
            None => app.name.eq_ignore_ascii_case(query) || app.bundle.as_deref().is_some_and(|bundle| bundle.eq_ignore_ascii_case(query)),
        })
        .collect();
    if matches.len() > 1 {
        matches.sort_by_key(|app| app.pid);
        let candidates = matches
            .iter()
            .map(|app| {
                format!(
                    "{} (PID {}, {}, {})",
                    app.name,
                    app.pid,
                    app.bundle.as_deref().unwrap_or("no bundle ID"),
                    app.path.as_ref().map(|path| path.display().to_string()).unwrap_or_else(|| "unknown path".into())
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        return Err(fail(
            ErrorCode::BadRequest,
            format!(
                "Ambiguous app {query:?}: {candidates}. Use a unique bundle ID or full application path, or close duplicate instances."
            ),
        ));
    }
    Ok(matches.pop())
}

fn window(app: &App) -> Result<(El, El), Failure> {
    let ax = unsafe { CFType::wrap_under_create_rule(AXUIElementCreateApplication(app.pid)) };
    unsafe { AXUIElementSetMessagingTimeout(ax.as_CFTypeRef(), 1.5) };
    let w = window_of(&ax).ok_or_else(|| fail(ErrorCode::NoWindow, format!("{} has no open window", app.name)))?;
    if bool_attr(&ax, "AXHidden") == Some(true) || bool_attr(&w, "AXMinimized") == Some(true) {
        return Err(fail(ErrorCode::NoWindow, "App is hidden or window is minimized; show it and observe again"));
    }
    Ok((ax, w))
}

fn capture(w: &El, f: Rect, panels: &[u32]) -> Result<Screenshot, Failure> {
    if !unsafe { CGPreflightScreenCaptureAccess() } {
        return Err(fail(ErrorCode::PermissionMissing, "Screen Recording not granted; run `desk permissions --prompt`"));
    }
    crate::capture::window(window_id(w), panels, f).map_err(|m| fail(ErrorCode::ActionFailed, m))
}

#[cfg(test)]
mod tests {
    #[test]
    fn copied_ax_results_release_owned_values_on_error_and_success() {
        let value = CFArray::from_CFTypes(&[cfs("owned AX result")]);
        let baseline = value.retain_count();
        for status in [0, -25200] {
            let owned = value.clone();
            let pointer = owned.as_CFTypeRef();
            std::mem::forget(owned);
            let result = ax_result(status, pointer);
            assert_eq!(result.is_some(), status == 0);
            drop(result);
            assert_eq!(value.retain_count(), baseline);
        }
        assert!(ax_result(0, std::ptr::null()).is_none());
    }

    #[test]
    fn observed_window_rejects_rebound_identity_with_same_element_and_frame() {
        let element = app_element(10001);
        let frame = Rect { x: 0.0, y: 0.0, w: 100.0, h: 100.0 };
        let snapshot = Snapshot {
            window: 42,
            window_element: element.clone(),
            frame,
            elements: vec![],
            text: HashMap::new(),
            markers: HashMap::new(),
            lines: HashMap::new(),
            ids: tree::Ids::default(),
        };
        assert!(snapshot.matches_window(&element, 42, Some(frame)));
        assert!(!snapshot.matches_window(&element, 43, Some(frame)));
        assert!(!snapshot.matches_window(&element, 0, Some(frame)));
    }

    #[test]
    fn prefetched_children_keep_content_clipping_and_visit_budget() {
        let window = Rect { x: 0.0, y: 0.0, w: 100.0, h: 100.0 };
        let mut walk = Walk {
            ids: tree::Ids::default(),
            elements: vec![],
            text: HashMap::new(),
            markers: HashMap::new(),
            text_budget: 1024 * 1024,
            notes: HashMap::new(),
            truncated: false,
            visited: MAX_VISITS,
            window,
            cache: None,
        };
        let node = |title: &str, x| Node {
            has_value: false,
            props: Props { role: "AXButton".into(), title: Some(title.into()), ..Default::default() },
            raw: None,
            rendered: None,
            frame: Some(Rect { x, y: 10.0, w: 20.0, h: 20.0 }),
            children: vec![],
        };
        let elements = [app_element(10001), app_element(10002)];
        let mut items = vec![];
        walk.children(
            &elements,
            Some(vec![node("Apply", 10.0), node("Offscreen", 200.0)]),
            WalkAt { depth: 0, anchor: ROOT, clip: window, at: Locator::ROOT },
            false,
            &mut items,
        );
        let (lines, cut) = tree::layout(&items, MAX_TREE_CHARS);
        assert_eq!(walk.visited, MAX_VISITS);
        assert!(!walk.truncated && !cut);
        assert_eq!(walk.elements.len(), 1);
        assert!(lines.iter().any(|(_, line)| line.contains("Apply")));
        assert!(lines.iter().any(|(_, line)| line.contains("1 more offscreen")));
        assert!(!lines.iter().any(|(_, line)| line.contains("Offscreen")));
        let mut unprefetched = vec![];
        walk.children(&elements[..1], None, WalkAt { depth: 0, anchor: ROOT, clip: window, at: Locator::ROOT }, false, &mut unprefetched);
        assert!(walk.truncated);
        assert_eq!(walk.visited, MAX_VISITS);
    }

    #[test]
    fn marker_candidates_require_absent_native_value() {
        let clip = Rect { x: 0.0, y: 0.0, w: 100.0, h: 100.0 };
        for value in [None, Some(""), Some("   "), Some("text")] {
            let node = Node {
                has_value: value.is_some(),
                props: Props {
                    role: "AXTextField".into(),
                    value: value.map(str::trim).filter(|s| !s.is_empty()).map(str::to_string),
                    ..Default::default()
                },
                raw: value.map(str::to_string),
                rendered: None,
                frame: Some(clip),
                children: vec![],
            };
            assert_eq!(node.marker_candidate(clip), value.is_none());
        }
    }

    #[test]
    fn observed_selection_follows_rebound_element_ids() {
        let locator = Locator::ROOT.child(&Props { role: "AXTextArea".into(), identifier: Some("editor".into()), ..Default::default() });
        let mut ids = tree::Ids::default();
        let old = ids.assign(&"old", 1, locator);
        let mut ids = ids.carry();
        let new = ids.assign(&"new", 2, locator);
        let rendered = text::attributed_text(&[("hello".into(), text::TextStyle { bold: true, ..Default::default() })], true).unwrap();
        let mapping = rebind_text(HashMap::from([(new, text::ObservedText::new("hello", rendered))]), &ids.rebind(|e| *e == "old"));
        assert!(!mapping.contains_key(&new));
        assert_eq!(text::observed_selection_range("hello", mapping.get(&old), "**hello**", "", "", Selection::Text).unwrap(), [0, 5]);
    }

    #[test]
    fn observed_selection_budget_falls_back_to_plain_text() {
        let rendered = text::attributed_text(&[("hello".into(), text::TextStyle { bold: true, ..Default::default() })], true).unwrap();
        let mut budget = rendered.retained_bytes();
        let mut node = Node {
            has_value: true,
            props: Props {
                role: "AXTextArea".into(),
                value: Some("hello".into()),
                rich_text: Some(rendered.markdown.clone()),
                ..Default::default()
            },
            raw: Some("hello".into()),
            rendered: Some(rendered),
            frame: None,
            children: vec![],
        };
        node.limit_text(&mut budget);
        assert_eq!(budget, 0);
        assert!(node.props.describe().0.contains("markdown:"));
        node.limit_text(&mut budget);
        assert!(node.rendered.is_none());
        assert_eq!(node.props.describe().0, "TextArea = \"hello\"");
    }

    #[test]
    fn attributed_observation_resolves_native_font_traits() {
        use core_foundation::attributed_string::CFMutableAttributedString;
        for (name, expected) in [(".AppleSystemUIFontBold", "**word**"), (".SFNS-RegularItalic", "*word*")] {
            let mut value = CFMutableAttributedString::new();
            value.replace_str(&cfs("word"), CFRange { location: 0, length: 0 });
            let font = CFDictionary::from_CFType_pairs(&[
                (cfs("AXFontName"), cfs(name).as_CFType()),
                (cfs("AXFontSize"), CFNumber::from(14.0).as_CFType()),
            ]);
            value.set_attribute(CFRange { location: 0, length: 4 }, cfs("AXFont").as_concrete_TypeRef(), &font);
            let immutable = value.as_CFType().downcast::<CFAttributedString>().unwrap();
            let runs = attributed_runs(&immutable, "word").unwrap();
            assert_eq!(text::attributed_markdown(&runs, true).as_deref(), Some(expected), "{name}");
            value.set_attribute(CFRange { location: 0, length: 4 }, cfs("AXFontBold").as_concrete_TypeRef(), &CFBoolean::false_value());
            value.set_attribute(CFRange { location: 0, length: 4 }, cfs("AXFontItalic").as_concrete_TypeRef(), &CFBoolean::false_value());
            let runs = attributed_runs(&immutable, "word").unwrap();
            assert!(text::attributed_markdown(&runs, true).is_none());
        }
    }

    #[test]
    fn attributed_observation_decodes_native_runs_and_rejects_mismatches() {
        use core_foundation::attributed_string::CFMutableAttributedString;
        let mut value = CFMutableAttributedString::new();
        value.replace_str(&cfs("😀bold\nplain"), CFRange { location: 0, length: 0 });
        value.set_attribute(CFRange { location: 2, length: 4 }, cfs("AXFontBold").as_concrete_TypeRef(), &CFBoolean::true_value());
        let value = value.as_CFType().downcast::<CFAttributedString>().unwrap();
        let runs = attributed_runs(&value, "😀bold\nplain").unwrap();
        assert_eq!(text::attributed_markdown(&runs, true).unwrap(), "😀**bold**\nplain");
        assert!(attributed_runs(&value, "stale text").is_none());
        assert_eq!(text::selection_range("😀bold\nplain", "bold", "", "", Selection::Text).unwrap(), [2, 4]);
    }

    use super::*;

    fn app(name: &str, bundle: &str, path: &str, pid: i32) -> App {
        App { name: name.into(), bundle: Some(bundle.into()), path: Some(path.into()), pid, active: false, launched: None }
    }

    #[test]
    fn disjoint_scroll_clips_do_not_reveal_descendants() {
        let window = Rect { x: 0.0, y: 0.0, w: 100.0, h: 100.0 };
        let outer = narrow(window, "AXScrollArea", Some(Rect { x: 0.0, y: 0.0, w: 30.0, h: 30.0 }));
        let inner = narrow(outer, "AXWebArea", Some(Rect { x: 50.0, y: 50.0, w: 40.0, h: 40.0 }));
        let child = Rect { x: 5.0, y: 5.0, w: 10.0, h: 10.0 };
        assert!(tree::visible(child, inner).is_none());
        assert!(tree::visible(child, narrow(inner, "AXScrollArea", Some(window))).is_none());
    }

    #[test]
    fn app_identity_allows_accessory_only_for_explicit_resolution() {
        use NSApplicationActivationPolicy as Policy;
        let candidates = |explicit| {
            [(Policy::Regular, "Editor", 11), (Policy::Accessory, "Panel", 22), (Policy::Prohibited, "Helper", 33)]
                .into_iter()
                .filter(|(policy, _, _)| app_policy_allowed(*policy, explicit))
                .map(|(_, name, pid)| app(name, &format!("test.{name}"), &format!("/{name}.app"), pid))
                .collect::<Vec<_>>()
        };
        assert_eq!(candidates(false).iter().map(|app| app.pid).collect::<Vec<_>>(), [11]);
        assert_eq!(select_app(candidates(true), "/Panel.app", Some(std::path::Path::new("/Panel.app"))).unwrap().unwrap().pid, 22);
        assert_eq!(select_app(candidates(true), "test.Panel", None).unwrap().unwrap().pid, 22);
        assert!(select_app(candidates(true), "Helper", None).unwrap().is_none());
        assert!(select_app(candidates(true), "Pane", None).unwrap().is_none());
    }

    #[test]
    fn app_identity_rejects_every_ambiguous_match() {
        let result = select_app(vec![app("Editor", "test.one", "/One.app", 11), app("Editor", "test.two", "/Two.app", 22)], "editor", None);
        let error = result.err().unwrap();
        assert_eq!(error.code, ErrorCode::BadRequest);
        assert!(error.message.contains("PID 11"));
        assert!(error.message.contains("PID 22"));
        let result = select_app(vec![app("One", "test.same", "/One.app", 11), app("Two", "test.same", "/Two.app", 22)], "test.same", None);
        assert!(result.is_err());
    }

    #[test]
    fn app_identity_selects_exact_path_or_unique_bundle() {
        let apps = || vec![app("Editor", "test.one", "/One.app", 11), app("Editor", "test.two", "/Two.app", 22)];
        assert_eq!(select_app(apps(), "test.TWO", None).unwrap().unwrap().pid, 22);
        assert_eq!(select_app(apps(), "/One.app", Some(std::path::Path::new("/One.app"))).unwrap().unwrap().pid, 11);
        assert!(select_app(apps(), "/Missing.app", Some(std::path::Path::new("/Missing.app"))).unwrap().is_none());
    }
}
