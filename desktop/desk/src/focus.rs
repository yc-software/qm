use crate::protocol::{ErrorCode, Failure};
use core_foundation::base::{CFRetain, CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use core_graphics::event::CGEvent;
use foreign_types::ForeignType;
use objc2::msg_send;
use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};
use objc2_foundation::NSPoint;
use std::ffi::c_void;
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant};

static EXPECTED_FOREGROUND: AtomicI32 = AtomicI32::new(0);

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGSessionCopyCurrentDictionary() -> CFTypeRef;
}

fn screen_available() -> bool {
    let session = unsafe { CGSessionCopyCurrentDictionary() };
    if session.is_null() {
        return false;
    }
    let session = unsafe { CFDictionary::<CFString, CFType>::wrap_under_create_rule(session as _) };
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

pub struct Focus {
    target: i32,
    activated: bool,
    intervention: Option<crate::intervention::Intervention>,
}

impl Focus {
    pub fn begin(target: i32, window: u32) -> Result<Self, Failure> {
        if !screen_available() {
            return Err(Failure::new(ErrorCode::ActionFailed, "Screen is locked or console session unavailable"));
        }
        let original = frontmost().ok_or_else(|| Failure::new(ErrorCode::ActionFailed, "Cannot identify the foreground app"))?;
        let intervention = crate::intervention::Intervention::begin(target)?;
        if original == target {
            EXPECTED_FOREGROUND.store(original, Ordering::Release);
            return Ok(Self { target, activated: false, intervention: Some(intervention) });
        }
        if window == 0 {
            return Err(Failure::new(ErrorCode::ActionFailed, "Background window has no ID; observe again"));
        }
        synthetic_focus(target, window, 1)?;
        let guard = Self { target, activated: true, intervention: Some(intervention) };
        EXPECTED_FOREGROUND.store(original, Ordering::Release);
        guard.check()?;
        Ok(guard)
    }

    pub fn finish(&mut self) -> Result<(), Failure> {
        EXPECTED_FOREGROUND.store(0, Ordering::Release);
        if !std::mem::replace(&mut self.activated, false) {
            return Ok(());
        }
        let until = Instant::now() + Duration::from_millis(80);
        while Instant::now() < until && !crate::cancellation::cancelled() {
            std::thread::sleep(Duration::from_millis(8));
        }
        if frontmost() != Some(self.target) {
            synthetic_focus(self.target, 0, 2)?;
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
