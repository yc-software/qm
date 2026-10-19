use crate::focus_protocol::{Decision, Scope, PROCESS_NOTIFICATION};
use crate::protocol::{ErrorCode, Failure};
use core_foundation::base::TCFType;
use core_foundation::mach_port::CFMachPort;
use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop};
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventTapProxy, CGEventType,
};
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

type ReleaseKeyFocus = unsafe extern "C" fn(u32) -> i32;
type GetKeyFocus = unsafe extern "C" fn(*mut ProcessSerialNumber, *mut u8) -> i32;
type GetProcessPid = unsafe extern "C" fn(*const ProcessSerialNumber, *mut i32) -> i32;

#[repr(C)]
#[derive(Default)]
struct ProcessSerialNumber {
    high: u32,
    low: u32,
}

pub fn keyboard_focus_pid() -> Result<i32, Failure> {
    let query = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"CPSGetKeyFocusProcess".as_ptr()) };
    let resolve = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"GetProcessPID".as_ptr()) };
    if query.is_null() || resolve.is_null() {
        return Err(Failure::new(ErrorCode::ActionFailed, "Keyboard-focus ownership is unavailable; input was not started"));
    }
    let query = unsafe { std::mem::transmute::<*mut c_void, GetKeyFocus>(query) };
    let resolve = unsafe { std::mem::transmute::<*mut c_void, GetProcessPid>(resolve) };
    let mut process = ProcessSerialNumber::default();
    let mut flags = 0;
    let mut pid = 0;
    if unsafe { query(&mut process, &mut flags) } != 0 || unsafe { resolve(&process, &mut pid) } != 0 || pid <= 0 {
        return Err(Failure::new(ErrorCode::ActionFailed, "Cannot identify the keyboard-focus owner; input was not started"));
    }
    Ok(pid)
}

const NOTIFICATION_SUBTYPE: CGEventField = CGEventField(64);
const FOCUS_THEFT_ID: CGEventField = CGEventField(71);
const FOCUS_SUBJECT_PID: CGEventField = CGEventField(73);
static ACTIVE: Mutex<Option<Arc<Context>>> = Mutex::new(None);

struct Context {
    scope: Mutex<Scope>,
    failure: Mutex<Option<String>>,
    release: ReleaseKeyFocus,
}

impl Context {
    fn fail(&self, message: impl Into<String>) {
        if let Ok(mut failure) = self.failure.lock() {
            if failure.is_none() {
                *failure = Some(message.into());
            }
        }
    }
}

unsafe extern "C-unwind" fn receive(_: CGEventTapProxy, kind: CGEventType, event: NonNull<CGEvent>, info: *mut c_void) -> *mut CGEvent {
    let context = unsafe { &*(info as *const Context) };
    let original = event.as_ptr();
    if kind.0 >= u32::MAX - 1 {
        context.fail("Focus protection event tap was disabled; stopped");
        return original;
    }
    if context.failure.lock().map(|failure| failure.is_some()).unwrap_or(true) {
        return original;
    }
    let value = unsafe { event.as_ref() };
    let field = |id| CGEvent::integer_value_field(Some(value), id);
    let source = i32::try_from(field(CGEventField::EventSourceUnixProcessID)).unwrap_or(-1);
    let destination = i32::try_from(field(CGEventField::EventTargetUnixProcessID)).unwrap_or(-1);
    let Ok(mut scope) = context.scope.lock() else {
        context.fail("Focus protection state is unavailable; stopped");
        return original;
    };
    if crate::cancellation::cancelled() {
        scope.yield_to_user();
    }
    let decision = if kind.0 == PROCESS_NOTIFICATION {
        scope.notification(
            destination,
            field(NOTIFICATION_SUBTYPE),
            i32::try_from(field(FOCUS_SUBJECT_PID)).unwrap_or(-1),
            field(FOCUS_THEFT_ID),
        )
    } else {
        scope.user_event(kind.0, source, destination)
    };
    match decision {
        Decision::Pass => original,
        Decision::Suppress => std::ptr::null_mut(),
        Decision::Redirect(pid) => {
            CGEvent::set_integer_value_field(Some(value), CGEventField::EventTargetUnixProcessID, i64::from(pid));
            CGEvent::post_to_pid(pid, Some(value));
            std::ptr::null_mut()
        }
        Decision::Release(id) => {
            let status = unsafe { (context.release)(id) };
            scope.released(status == 0);
            if status != 0 {
                context.fail(format!("Releasing target key-focus lease failed (status {status}); stopped"));
            }
            original
        }
        Decision::Stop(message) => {
            context.fail(message);
            original
        }
        Decision::Intervened => {
            context.fail("User interacted with the target or requested an app switch; stopped");
            original
        }
    }
}

pub fn include_target(pid: i32) {
    if let Ok(active) = ACTIVE.lock() {
        if let Some(context) = active.as_ref() {
            if let Ok(mut scope) = context.scope.lock() {
                scope.include(pid);
            }
        }
    }
}

pub struct Intervention {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    context: Arc<Context>,
}

impl Intervention {
    pub fn begin(target: i32, foreground: i32, keyboard_owner: i32) -> Result<Self, Failure> {
        let pointer = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"CPSReleaseKeyFocusWithID".as_ptr()) };
        if pointer.is_null() {
            return Err(Failure::new(ErrorCode::ActionFailed, "Key-focus lease release is unavailable; input was not started"));
        }
        let release = unsafe { std::mem::transmute::<*mut c_void, ReleaseKeyFocus>(pointer) };
        let context = Arc::new(Context {
            scope: Mutex::new(Scope::new(std::process::id() as i32, foreground, keyboard_owner, target)),
            failure: Mutex::new(None),
            release,
        });
        let stop = Arc::new(AtomicBool::new(false));
        let quit = Arc::clone(&stop);
        let callback_context = Arc::clone(&context);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let thread = thread::spawn(move || {
            let mask = (1 << PROCESS_NOTIFICATION) | (1 << 1) | (1 << 3) | (1 << 25) | (1 << 10) | (1 << 11) | (1 << 12);
            let tap = unsafe {
                CGEvent::tap_create(
                    CGEventTapLocation::AnnotatedSessionEventTap,
                    CGEventTapPlacement::TailAppendEventTap,
                    CGEventTapOptions::Default,
                    mask,
                    Some(receive),
                    Arc::as_ptr(&callback_context) as *mut c_void,
                )
            };
            let Some(tap) = tap else {
                let _ = ready_tx.send(Err("Could not create the focus-protection event tap"));
                return;
            };
            let port = unsafe { CFMachPort::wrap_under_get_rule((&*tap as *const objc2_core_foundation::CFMachPort).cast_mut().cast()) };
            let Ok(source) = port.create_runloop_source(0) else {
                let _ = ready_tx.send(Err("Could not create the focus-protection run-loop source"));
                return;
            };
            let runloop = CFRunLoop::get_current();
            runloop.add_source(&source, unsafe { kCFRunLoopDefaultMode });
            CGEvent::tap_enable(&tap, true);
            if ready_tx.send(Ok(())).is_ok() {
                while !quit.load(Ordering::Acquire) {
                    CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, Duration::from_millis(30), false);
                }
            }
            CGEvent::tap_enable(&tap, false);
            runloop.remove_source(&source, unsafe { kCFRunLoopDefaultMode });
        });
        let ready = ready_rx.recv_timeout(Duration::from_millis(350));
        if matches!(ready, Ok(Ok(()))) {
            if let Ok(mut active) = ACTIVE.lock() {
                *active = Some(Arc::clone(&context));
            }
            return Ok(Self { stop, thread: Some(thread), context });
        }
        stop.store(true, Ordering::Release);
        let message = match ready {
            Ok(Err(message)) => message,
            Err(mpsc::RecvTimeoutError::Timeout) => "Focus protection did not start within 350 ms",
            _ => "Focus protection stopped before initialization",
        };
        Err(Failure::new(ErrorCode::ActionFailed, message))
    }

    pub fn check(&self) -> Result<(), Failure> {
        let failure = self
            .context
            .failure
            .lock()
            .map_err(|_| Failure::new(ErrorCode::ActionFailed, "Focus protection state is unavailable; stopped"))?;
        if let Some(message) = failure.as_ref() {
            return Err(Failure::new(ErrorCode::ActionFailed, message.clone()));
        }
        Ok(())
    }
}

pub fn check_current() -> Result<(), Failure> {
    let active = ACTIVE.lock().map_err(|_| Failure::new(ErrorCode::ActionFailed, "Focus protection state is unavailable; stopped"))?;
    if let Some(context) = active.as_ref() {
        let failure =
            context.failure.lock().map_err(|_| Failure::new(ErrorCode::ActionFailed, "Focus protection state is unavailable; stopped"))?;
        if let Some(message) = failure.as_ref() {
            return Err(Failure::new(ErrorCode::ActionFailed, message.clone()));
        }
    }
    Ok(())
}

impl Drop for Intervention {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        if let Ok(mut active) = ACTIVE.lock() {
            *active = None;
        }
    }
}
