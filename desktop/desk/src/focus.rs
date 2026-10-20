use crate::protocol::{ErrorCode, Failure};
use core_foundation::base::{CFRetain, CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use core_graphics::event::CGEvent;
use foreign_types::ForeignType;
use objc2::msg_send;
use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};
use objc2_foundation::NSPoint;
use std::cell::{Cell, RefCell};
use std::ffi::c_void;
use std::rc::{Rc, Weak};
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant};

static EXPECTED_FOREGROUND: AtomicI32 = AtomicI32::new(0);

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

thread_local! {
    static ACTIVATION: RefCell<Weak<Activation>> = const { RefCell::new(Weak::new()) };
}

struct Activation {
    original: i32,
    selected: Cell<(i32, u32)>,
    activated: RefCell<Vec<(i32, u32)>>,
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
    activation.ensure(target, window, synthetic_focus)?;
    check_current()
}

pub fn activate_current() -> Result<(), Failure> {
    check_current()?;
    if let Some(activation) = ACTIVATION.with(|current| current.borrow().upgrade()) {
        let (target, window) = activation.selected.get();
        activation.ensure(target, window, synthetic_focus)?;
    }
    check_current()
}

pub struct Focus {
    activation: Rc<Activation>,
    intervention: Option<crate::intervention::Intervention>,
}

impl Focus {
    pub fn begin(target: i32, window: u32) -> Result<Self, Failure> {
        if !screen_available() {
            return Err(Failure::new(ErrorCode::ActionFailed, "Screen is locked or console session unavailable"));
        }
        let original = frontmost().ok_or_else(|| Failure::new(ErrorCode::ActionFailed, "Cannot identify the foreground app"))?;
        let keyboard_owner = crate::intervention::keyboard_focus_pid()?;
        let intervention = crate::intervention::Intervention::begin(target, original, keyboard_owner)?;
        if keyboard_owner != crate::intervention::keyboard_focus_pid()? || frontmost() != Some(original) {
            return Err(Failure::new(ErrorCode::ActionFailed, "Focus changed while starting input; stopped"));
        }
        let activation = Rc::new(Activation { original, selected: Cell::new((target, window)), activated: RefCell::new(Vec::new()) });
        ACTIVATION.with(|current| *current.borrow_mut() = Rc::downgrade(&activation));
        let guard = Self { activation, intervention: Some(intervention) };
        EXPECTED_FOREGROUND.store(original, Ordering::Release);
        guard.check()?;
        Ok(guard)
    }

    pub fn finish(&mut self) -> Result<(), Failure> {
        EXPECTED_FOREGROUND.store(0, Ordering::Release);
        ACTIVATION.with(|current| *current.borrow_mut() = Weak::new());
        let activated = self.activation.activated.take();
        if activated.is_empty() {
            return Ok(());
        }
        let until = Instant::now() + Duration::from_millis(80);
        while Instant::now() < until && !crate::cancellation::cancelled() {
            std::thread::sleep(Duration::from_millis(8));
        }
        let mut failure = None;
        for (target, _) in activated.into_iter().rev() {
            if frontmost() != Some(target) {
                if let Err(error) = synthetic_focus(target, 0, 2) {
                    failure.get_or_insert(error);
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }

    pub fn check(&self) -> Result<(), Failure> {
        check_current()?;
        if let Some(intervention) = &self.intervention {
            intervention.check()?;
        }
        Ok(())
    }
}

pub fn check_current() -> Result<(), Failure> {
    let expected = EXPECTED_FOREGROUND.load(Ordering::Acquire);
    if expected == 0 {
        return Ok(());
    }
    if !screen_available() {
        return Err(Failure::new(ErrorCode::ActionFailed, "Screen is locked or console session unavailable"));
    }
    crate::intervention::check_current()?;
    if frontmost() != Some(expected) {
        return Err(Failure::new(ErrorCode::ActionFailed, "Foreground app changed during background input; stopped"));
    }
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
        let state = Activation { original: 1, selected: Cell::new((41, 7)), activated: RefCell::new(Vec::new()) };
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
        let state = Activation { original: 1, selected: Cell::new((1, 0)), activated: RefCell::new(Vec::new()) };
        state.ensure(1, 0, |_, _, _| panic!("foreground activation")).unwrap();
        assert!(state.ensure(41, 0, |_, _, _| panic!("missing window activation")).is_err());
        assert!(state.ensure(41, 7, |_, _, _| Err(Failure::new(ErrorCode::ActionFailed, "failed"))).is_err());
        assert_eq!(state.selected.get(), (1, 0));
        assert!(state.activated.borrow().is_empty());
    }
}
