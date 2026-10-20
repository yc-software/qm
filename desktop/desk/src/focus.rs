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
    target: i32,
    window: u32,
    background: bool,
    activated: Cell<bool>,
}

impl Activation {
    fn ensure(&self, send: impl FnOnce(i32, u32, i16) -> Result<(), Failure>) -> Result<(), Failure> {
        if !self.background || self.activated.get() {
            return Ok(());
        }
        if self.window == 0 {
            return Err(Failure::new(ErrorCode::ActionFailed, "Background window has no ID; observe again"));
        }
        send(self.target, self.window, 1)?;
        self.activated.set(true);
        Ok(())
    }
}

pub fn activate_current() -> Result<(), Failure> {
    check_current()?;
    if let Some(activation) = ACTIVATION.with(|current| current.borrow().upgrade()) {
        activation.ensure(synthetic_focus)?;
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
        let activation = Rc::new(Activation { target, window, background: original != target, activated: Cell::new(false) });
        ACTIVATION.with(|current| *current.borrow_mut() = Rc::downgrade(&activation));
        let guard = Self { activation, intervention: Some(intervention) };
        EXPECTED_FOREGROUND.store(original, Ordering::Release);
        guard.check()?;
        Ok(guard)
    }

    pub fn finish(&mut self) -> Result<(), Failure> {
        EXPECTED_FOREGROUND.store(0, Ordering::Release);
        ACTIVATION.with(|current| *current.borrow_mut() = Weak::new());
        if !self.activation.activated.replace(false) {
            return Ok(());
        }
        let until = Instant::now() + Duration::from_millis(80);
        while Instant::now() < until && !crate::cancellation::cancelled() {
            std::thread::sleep(Duration::from_millis(8));
        }
        if frontmost() != Some(self.activation.target) {
            synthetic_focus(self.activation.target, 0, 2)?;
        }
        Ok(())
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
    fn background_activation_waits_for_synthetic_dispatch_and_runs_once() {
        let state = Activation { target: 41, window: 7, background: true, activated: Cell::new(false) };
        assert!(!state.activated.get());
        state
            .ensure(|pid, window, subtype| {
                assert_eq!((pid, window, subtype), (41, 7, 1));
                assert!(!state.activated.get());
                Ok(())
            })
            .unwrap();
        state.ensure(|_, _, _| panic!("duplicate activation")).unwrap();
        assert!(state.activated.get());
    }

    #[test]
    fn foreground_and_failed_activation_need_no_deactivation() {
        let mut state = Activation { target: 41, window: 0, background: false, activated: Cell::new(false) };
        state.ensure(|_, _, _| panic!("foreground activation")).unwrap();
        assert!(!state.activated.get());
        state.background = true;
        assert!(state.ensure(|_, _, _| panic!("missing window activation")).is_err());
        state.window = 7;
        assert!(state.ensure(|_, _, _| Err(Failure::new(ErrorCode::ActionFailed, "failed"))).is_err());
        assert!(!state.activated.get());
    }
}
