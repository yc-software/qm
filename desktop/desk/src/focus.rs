use crate::protocol::{ErrorCode, Failure, Rect};
use core_foundation::base::{CFRetain, CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_graphics::event::CGEvent;
use core_graphics::geometry::{CGPoint, CGRect};
use foreign_types::ForeignType;
use objc2::msg_send;
use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSApplicationActivationOptions, NSEvent, NSEventModifierFlags, NSEventType, NSRunningApplication};
use objc2_foundation::NSPoint;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::c_void;
use std::rc::{Rc, Weak};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

static INPUT_ACTIVE: AtomicBool = AtomicBool::new(false);

fn screen_available() -> bool {
    let Some(session) = objc2_core_graphics::CGSessionCopyCurrentDictionary() else {
        return false;
    };
    let session = unsafe {
        CFDictionary::<CFString, CFType>::wrap_under_get_rule(objc2_core_foundation::CFRetained::as_ptr(&session).as_ptr().cast())
    };
    let field = |name: &str| session.find(CFString::new(name)).and_then(|v| v.downcast::<CFBoolean>()).map(bool::from);
    field("CGSSessionScreenIsLocked") != Some(true) && field("kCGSSessionOnConsoleKey") == Some(true)
}

fn synthetic_focus(pid: i32, window: u32, subtype: i16) -> Result<(), Failure> {
    autoreleasepool(|_| {
        let event = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
            NSEventType::AppKitDefined,
            NSPoint::new(0.0, 0.0),
            NSEventModifierFlags(if window == 0 { 0 } else { 0xc0000 }),
            0.0,
            window as isize,
            None,
            subtype,
            0,
            0,
        )
        .ok_or_else(|| Failure::new(ErrorCode::ActionFailed, "Cannot create background focus event"))?;
        let cg: *mut c_void = unsafe { msg_send![&*event, CGEvent] };
        if cg.is_null() {
            return Err(Failure::new(ErrorCode::ActionFailed, "Cannot convert background focus event"));
        }
        let event = unsafe { CGEvent::from_ptr(CFRetain(cg.cast()) as _) };
        event.post_to_pid(pid);
        Ok::<(), Failure>(())
    })?;
    Ok(())
}

fn frontmost() -> Option<i32> {
    crate::mac::system_focused_pid()
}

type Update = unsafe extern "C" fn(i32) -> i32;

struct Updates {
    connection: i32,
    enable: Update,
    frozen: bool,
}

impl Updates {
    fn freeze() -> Result<Self, Failure> {
        let lookup = |name: &std::ffi::CStr| {
            let pointer = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
            if pointer.is_null() {
                Err(Failure::new(ErrorCode::ActionFailed, "WindowServer activation support is unavailable"))
            } else {
                Ok(pointer)
            }
        };
        let main = unsafe { std::mem::transmute::<*mut c_void, unsafe extern "C" fn() -> i32>(lookup(c"CGSMainConnectionID")?) };
        let disable = unsafe { std::mem::transmute::<*mut c_void, Update>(lookup(c"CGSDisableUpdate")?) };
        let enable = unsafe { std::mem::transmute::<*mut c_void, Update>(lookup(c"CGSReenableUpdate")?) };
        let connection = unsafe { main() };
        if connection == 0 || unsafe { disable(connection) } != 0 {
            return Err(Failure::new(ErrorCode::ActionFailed, "Cannot suspend display updates for activation"));
        }
        Ok(Self { connection, enable, frozen: true })
    }

    fn resume(&mut self) -> Result<(), Failure> {
        if self.frozen {
            if unsafe { (self.enable)(self.connection) } != 0 {
                return Err(Failure::new(ErrorCode::ActionFailed, "Cannot resume display updates after activation"));
            }
            self.frozen = false;
        }
        Ok(())
    }
}

impl Drop for Updates {
    fn drop(&mut self) {
        if let Err(error) = self.resume() {
            eprintln!("{}", error.message);
        }
    }
}

fn activate_window(target: i32, window: u32, geometry: Option<(CGRect, CGPoint)>) -> Result<(), Failure> {
    let Some((frame, point)) = geometry else {
        return synthetic_focus(target, 0, 1);
    };
    synthetic_focus(target, window, 1)?;
    autoreleasepool(|_| {
        let events = [NSEventType::LeftMouseDown, NSEventType::LeftMouseUp]
            .into_iter()
            .enumerate()
            .map(|(index, kind)| {
                let native =
                    NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                        kind,
                        NSPoint::new(point.x, point.y),
                        NSEventModifierFlags::empty(),
                        0.0,
                        window as isize,
                        None,
                        index as isize + 1,
                        1,
                        1.0,
                    )
                    .ok_or_else(|| Failure::new(ErrorCode::ActionFailed, "Cannot create window activation event"))?;
                let raw: *mut c_void = unsafe { msg_send![&*native, CGEvent] };
                if raw.is_null() {
                    return Err(Failure::new(ErrorCode::ActionFailed, "Cannot convert window activation event"));
                }
                let event = unsafe { CGEvent::from_ptr(CFRetain(raw.cast()) as _) };
                objc2_core_graphics::CGEvent::set_location(
                    Some(unsafe { &*event.as_ptr().cast::<objc2_core_graphics::CGEvent>() }),
                    objc2_core_foundation::CGPoint::new(point.x, point.y),
                );
                event.set_integer_value_field(3, 0);
                event.set_integer_value_field(7, 3);
                event.set_integer_value_field(41, std::process::id() as i64);
                crate::mac::in_window(
                    &event,
                    window,
                    &Rect { x: frame.origin.x, y: frame.origin.y, w: frame.size.width, h: frame.size.height },
                    point,
                )?;
                Ok(event)
            })
            .collect::<Result<Vec<_>, Failure>>()?;
        check_current()?;
        for event in events {
            event.post_to_pid(target);
        }
        Ok(())
    })
}

fn restore_order(target: i32, window: u32, original_window: &CFType) -> Result<(), Failure> {
    let windows = core_graphics::window::copy_window_info(0x11, 0)
        .ok_or_else(|| Failure::new(ErrorCode::ActionFailed, "Cannot verify window order after activation"))?;
    let mut ahead = Vec::new();
    for value in windows.iter() {
        let value = unsafe { CFType::wrap_under_get_rule(*value) };
        let Some(raw) = value.downcast::<CFDictionary>() else { continue };
        let dict = unsafe { CFDictionary::<CFString, CFType>::wrap_under_get_rule(raw.as_concrete_TypeRef()) };
        let number =
            |name: &str| dict.find(CFString::new(name)).and_then(|value| value.downcast::<CFNumber>()).and_then(|value| value.to_i64());
        if number("kCGWindowNumber") == Some(i64::from(window)) {
            if ahead.contains(&(i64::from(target), number("kCGWindowLayer"))) {
                check_current()?;
                crate::mac::restore_focused_window(original_window)?;
            }
            return Ok(());
        }
        if let Some(owner) = number("kCGWindowOwnerPID") {
            ahead.push((owner, number("kCGWindowLayer")));
        }
    }
    Err(Failure::new(ErrorCode::ActionFailed, "Original focused window disappeared during activation"))
}

fn enforce_window(target: i32, window: u32, original: i32) -> Result<(), Failure> {
    let original_window = crate::mac::focused_window(original);
    let geometry = crate::mac::focus_activation_window(target, window);
    let original_app = NSRunningApplication::runningApplicationWithProcessIdentifier(original)
        .ok_or_else(|| Failure::new(ErrorCode::ActionFailed, "Original foreground app exited before activation"))?;
    let transition = crate::intervention::ActivationTransition::begin(target, original)?;
    let mut updates = Updates::freeze()?;
    let activation = (|| {
        check_current()?;
        activate_window(target, window, geometry)?;
        let until = Instant::now() + Duration::from_millis(80);
        while Instant::now() < until {
            check_current()?;
            std::thread::sleep(Duration::from_millis(8));
        }
        check_current()
    })();
    let restoration = (|| {
        check_current()?;
        if !matches!(frontmost(), Some(pid) if pid == original || pid == target) {
            return Ok(());
        }
        if frontmost() != Some(original) && !original_app.activateWithOptions(NSApplicationActivationOptions::empty()) {
            return Err(Failure::new(ErrorCode::ActionFailed, "Cannot restore original foreground app after activation"));
        }
        let until = Instant::now() + Duration::from_millis(350);
        while frontmost() != Some(original) && Instant::now() < until {
            check_current()?;
            std::thread::sleep(Duration::from_millis(8));
        }
        check_current()?;
        if frontmost() != Some(original) {
            return Err(Failure::new(ErrorCode::ActionFailed, "Original foreground app did not return after activation"));
        }
        if let Some((id, original_window)) = original_window {
            restore_order(target, id, &original_window)?;
        }
        if frontmost() == Some(original) {
            transition.verify_keyboard_owner()?;
        }
        check_current()
    })();
    let resumed = updates.resume();
    drop(transition);
    let mut failures = Vec::new();
    for (phase, result) in [("activation", activation), ("restoration", restoration), ("display resume", resumed)] {
        if let Err(error) = result {
            failures.push(format!("{phase} PID {target}: {}", error.message));
        }
    }
    if !failures.is_empty() && frontmost() != Some(target) {
        if let Err(error) = synthetic_focus(target, 0, 2) {
            failures.push(format!("deactivation PID {target}: {}", error.message));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(Failure::new(ErrorCode::ActionFailed, failures.join("; ")))
    }
}

#[derive(Default)]
pub struct Enforcers {
    entries: RefCell<HashMap<i32, crate::intervention::Retained>>,
}

impl Enforcers {
    fn ensure(&self, pid: i32) -> Result<std::sync::Arc<crate::intervention::RetainedState>, Failure> {
        let failure = self.entries.borrow().get(&pid).and_then(|entry| entry.state.check().err());
        if let Some(mut failure) = failure {
            if let Err(cleanup) = self.remove(pid, true) {
                failure.message.push_str(&format!("; cleanup: {}", cleanup.message));
            }
            return Err(failure);
        }
        let mut entries = self.entries.borrow_mut();
        if !entries.contains_key(&pid) {
            if entries.len() >= 32 {
                return Err(Failure::new(ErrorCode::ActionFailed, "Retained app protection limit reached"));
            }
            entries.insert(pid, crate::intervention::Retained::begin(pid)?);
        }
        let state = std::sync::Arc::clone(&entries[&pid].state);
        state.check()?;
        Ok(state)
    }

    fn check(&self, pid: i32) -> Result<(), Failure> {
        self.entries.borrow().get(&pid).map_or(Ok(()), |entry| entry.state.check())
    }

    pub fn clear(&self) -> Result<(), Failure> {
        let pids: Vec<_> = self.entries.borrow().keys().copied().collect();
        let errors: Vec<_> = pids.into_iter().filter_map(|pid| self.remove(pid, true).err().map(|error| error.message)).collect();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(Failure::new(ErrorCode::ActionFailed, errors.join("; ")))
        }
    }

    pub fn remove(&self, pid: i32, same_process: bool) -> Result<(), Failure> {
        if let Some(retained) = self.entries.borrow_mut().remove(&pid) {
            let deactivate = same_process && retained.state.same_process() && retained.state.focused() && frontmost() != Some(pid);
            retained.state.menu(None);
            let result = if deactivate { synthetic_focus(pid, 0, 2) } else { Ok(()) };
            drop(retained);
            result?;
        }
        Ok(())
    }
}

impl Drop for Enforcers {
    fn drop(&mut self) {
        let pids: Vec<_> = self.entries.borrow().keys().copied().collect();
        for pid in pids {
            if let Err(error) = self.remove(pid, true) {
                eprintln!("App protection cleanup failed: {}", error.message);
            }
        }
    }
}

thread_local! {
    static ACTIVATION: RefCell<Weak<Activation>> = const { RefCell::new(Weak::new()) };
}

struct Activation {
    original: i32,
    selected: Cell<(i32, u32)>,
    activated: RefCell<Vec<(i32, u32)>>,
    retained: Rc<Enforcers>,
}

impl Activation {
    fn ensure(&self, target: i32, window: u32, send: impl FnOnce(i32, u32, i16) -> Result<(), Failure>) -> Result<(), Failure> {
        if target != self.original && !self.activated.borrow().contains(&(target, window)) {
            if window == 0 {
                return Err(Failure::new(ErrorCode::ActionFailed, "Background window has no ID; observe again"));
            }
            send(target, window, 1)?;
            let mut activated = self.activated.borrow_mut();
            if let Some(current) = activated.iter_mut().find(|(pid, _)| *pid == target) {
                current.1 = window;
            } else {
                activated.push((target, window));
            }
        }
        self.selected.set((target, window));
        Ok(())
    }
}

pub fn activate_target(target: i32, window: u32) -> Result<(), Failure> {
    check_current()?;
    let activation = ACTIVATION
        .with(|current| current.borrow().upgrade())
        .ok_or_else(|| Failure::new(ErrorCode::ActionFailed, "Target activation requires protected input"))?;
    crate::intervention::include_target(target);
    check_current()?;
    let state = activation.retained.ensure(target)?;
    if !state.ready(window)? {
        activation.activated.borrow_mut().retain(|(pid, _)| *pid != target);
        activation.ensure(target, window, |target, window, _| enforce_window(target, window, activation.original))?;
        state.activated(window);
    } else {
        activation.selected.set((target, window));
    }
    check_current()
}

pub fn activate_current() -> Result<(), Failure> {
    check_current()?;
    if let Some(activation) = ACTIVATION.with(|current| current.borrow().upgrade()) {
        let (target, window) = activation.selected.get();
        activate_target(target, window)?;
    }
    check_current()
}

pub struct Focus {
    activation: Rc<Activation>,
    intervention: Option<crate::intervention::Intervention>,
}

impl Focus {
    pub fn begin(target: i32, window: u32, retained: Rc<Enforcers>) -> Result<Self, Failure> {
        if !screen_available() {
            return Err(Failure::new(ErrorCode::ActionFailed, "Screen is locked or console session unavailable"));
        }
        retained.ensure(target)?;
        let original = frontmost().ok_or_else(|| Failure::new(ErrorCode::ActionFailed, "Cannot identify the foreground app"))?;
        let keyboard_owner = crate::intervention::keyboard_focus_pid()?;
        let intervention = crate::intervention::Intervention::begin(target, original, keyboard_owner)?;
        let activation =
            Rc::new(Activation { original, selected: Cell::new((target, window)), activated: RefCell::new(Vec::new()), retained });
        ACTIVATION.with(|current| *current.borrow_mut() = Rc::downgrade(&activation));
        let guard = Self { activation, intervention: Some(intervention) };
        INPUT_ACTIVE.store(true, Ordering::Release);
        guard.check()?;
        Ok(guard)
    }

    pub fn finish(&mut self) -> Result<(), Failure> {
        INPUT_ACTIVE.store(false, Ordering::Release);
        ACTIVATION.with(|current| *current.borrow_mut() = Weak::new());
        self.activation.activated.borrow_mut().clear();
        self.intervention.take();
        Ok(())
    }

    pub fn check(&self) -> Result<(), Failure> {
        check_current()?;
        self.activation.retained.check(self.activation.selected.get().0)?;
        for (pid, _) in self.activation.activated.borrow().iter() {
            self.activation.retained.check(*pid)?;
        }
        if let Some(intervention) = &self.intervention {
            intervention.check()?;
        }
        Ok(())
    }
}

pub fn check_current() -> Result<(), Failure> {
    if !INPUT_ACTIVE.load(Ordering::Acquire) {
        return Ok(());
    }
    if crate::cancellation::cancelled() {
        return Err(Failure::new(ErrorCode::ActionFailed, "Input cancelled; activation stopped"));
    }
    if !screen_available() {
        return Err(Failure::new(ErrorCode::ActionFailed, "Screen is locked or console session unavailable"));
    }
    crate::intervention::check_current()?;
    Ok(())
}

impl Drop for Focus {
    fn drop(&mut self) {
        if let Err(error) = self.finish() {
            eprintln!("Background focus cleanup failed: {}", error.message);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_tracks_effective_owner_and_balanced_cleanup_targets() {
        let state = Activation { original: 1, selected: Cell::new((41, 7)), activated: RefCell::new(Vec::new()), retained: Rc::default() };
        assert!(state.activated.borrow().is_empty());
        let sent = RefCell::new(Vec::new());
        let send = |pid, window, subtype| {
            sent.borrow_mut().push((pid, window, subtype));
            Ok(())
        };
        state.ensure(41, 7, send).unwrap();
        state.ensure(42, 8, send).unwrap();
        let (pid, window) = state.selected.get();
        state.ensure(pid, window, |_, _, _| panic!("duplicate activation")).unwrap();
        state.ensure(41, 9, send).unwrap();
        assert_eq!(sent.into_inner(), vec![(41, 7, 1), (42, 8, 1), (41, 9, 1)]);
        assert_eq!(state.selected.get(), (41, 9));
        assert_eq!(state.activated.take(), vec![(41, 9), (42, 8)]);
        assert!(state.activated.take().is_empty());
    }

    #[test]
    fn failed_target_activation_preserves_previous_target_and_cleanup() {
        let state = Activation { original: 1, selected: Cell::new((1, 0)), activated: RefCell::new(Vec::new()), retained: Rc::default() };
        state.ensure(1, 0, |_, _, _| panic!("foreground activation")).unwrap();
        assert!(state.ensure(41, 0, |_, _, _| panic!("missing window activation")).is_err());
        assert!(state.ensure(41, 7, |_, _, _| Err(Failure::new(ErrorCode::ActionFailed, "failed"))).is_err());
        assert_eq!(state.selected.get(), (1, 0));
        assert!(state.activated.borrow().is_empty());
    }
}
