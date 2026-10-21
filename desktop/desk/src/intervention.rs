use crate::focus_protocol::{Decision, Scope, PROCESS_NOTIFICATION};
use crate::protocol::{ErrorCode, Failure};
use core_foundation::base::TCFType;
use core_foundation::mach_port::CFMachPort;
use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop, CFRunLoopSource};
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventTapProxy, CGEventType,
};
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

type ReleaseKeyFocus = unsafe extern "C" fn(u32) -> i32;
type GetKeyFocus = unsafe extern "C" fn(*mut ProcessSerialNumber, *mut u8) -> i32;
type GetProcessPid = unsafe extern "C" fn(*const ProcessSerialNumber, *mut i32) -> i32;

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn IsSecureEventInputEnabled() -> u8;
}

fn check_secure_input() -> Result<(), Failure> {
    if unsafe { IsSecureEventInputEnabled() } != 0 {
        return Err(Failure::new(
            ErrorCode::ActionFailed,
            "macOS Secure Input is active; keyboard protection is unavailable, so computer input was stopped",
        ));
    }
    Ok(())
}

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
    let status = unsafe { query(&mut process, &mut flags) };
    if status != 0 {
        return Err(Failure::new(
            ErrorCode::ActionFailed,
            format!("CPSGetKeyFocusProcess failed (status {status}); input was not started"),
        ));
    }
    let status = unsafe { resolve(&process, &mut pid) };
    if status != 0 {
        return Err(Failure::new(ErrorCode::ActionFailed, format!("GetProcessPID failed (status {status}); input was not started")));
    }
    if pid <= 0 {
        return Err(Failure::new(
            ErrorCode::ActionFailed,
            format!("Keyboard-focus lookup returned invalid PID {pid}; input was not started"),
        ));
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
    registered: Mutex<HashSet<i32>>,
    registrations: mpsc::Sender<(i32, mpsc::SyncSender<Result<(), String>>)>,
}

#[derive(Clone, Copy)]
enum TapKind {
    Notifications,
    Intervention,
    Keyboard(i32),
    Retained(i32),
}

struct TapContext {
    context: Option<Arc<Context>>,
    retained: Option<Arc<RetainedState>>,
    kind: TapKind,
}

struct Tap {
    port: objc2_core_foundation::CFRetained<objc2_core_foundation::CFMachPort>,
    source: CFRunLoopSource,
    runloop: CFRunLoop,
    _context: Box<TapContext>,
}

impl Tap {
    fn new(context: Arc<Context>, kind: TapKind) -> Result<Self, String> {
        Self::create(TapContext { context: Some(context), retained: None, kind })
    }

    fn create(callback: TapContext) -> Result<Self, String> {
        let mut callback = Box::new(callback);
        let kind = callback.kind;
        let info = (&mut *callback as *mut TapContext).cast();
        let keys = (1 << 10) | (1 << 11) | (1 << 12);
        let port = unsafe {
            match kind {
                TapKind::Keyboard(pid) | TapKind::Retained(pid) => CGEvent::tap_create_for_pid(
                    pid,
                    CGEventTapPlacement::TailAppendEventTap,
                    CGEventTapOptions::Default,
                    if matches!(kind, TapKind::Retained(_)) {
                        [1, 2, 6, 3, 4, 7, 25, 26, 27, 13, 19, 20].into_iter().fold(0, |mask, kind| mask | (1 << kind))
                    } else {
                        keys | (1 << 13) | (1 << 19) | (1 << 20)
                    },
                    Some(receive),
                    info,
                ),
                _ => CGEvent::tap_create(
                    CGEventTapLocation::AnnotatedSessionEventTap,
                    CGEventTapPlacement::TailAppendEventTap,
                    if matches!(kind, TapKind::Intervention) { CGEventTapOptions::ListenOnly } else { CGEventTapOptions::Default },
                    if matches!(kind, TapKind::Notifications) {
                        1 << PROCESS_NOTIFICATION
                    } else {
                        keys | (1 << 1) | (1 << 3) | (1 << 25) | (1 << 22)
                    },
                    Some(receive),
                    info,
                ),
            }
        }
        .ok_or_else(|| "Could not create a focus-protection event tap".to_string())?;
        let legacy = unsafe { CFMachPort::wrap_under_get_rule((&*port as *const objc2_core_foundation::CFMachPort).cast_mut().cast()) };
        let source = match legacy.create_runloop_source(0) {
            Ok(source) => source,
            Err(()) => {
                port.invalidate();
                return Err("Could not create the focus-protection run-loop source".into());
            }
        };
        let runloop = CFRunLoop::get_current();
        runloop.add_source(&source, unsafe { kCFRunLoopDefaultMode });
        CGEvent::tap_enable(&port, true);
        let tap = Self { port, source, runloop, _context: callback };
        if !CGEvent::tap_is_enabled(&tap.port) {
            return Err("Focus-protection event tap did not become enabled".into());
        }
        Ok(tap)
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        CGEvent::tap_enable(&self.port, false);
        self.runloop.remove_source(&self.source, unsafe { kCFRunLoopDefaultMode });
        self.port.invalidate();
    }
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
    let callback = unsafe { &*(info as *const TapContext) };
    if let Some(retained) = &callback.retained {
        return retained.receive(callback.kind, kind, unsafe { event.as_ref() }, event.as_ptr());
    }
    let context = callback.context.as_ref().unwrap();
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
    let decision = if matches!(callback.kind, TapKind::Notifications) && kind.0 == PROCESS_NOTIFICATION {
        scope.notification(
            destination,
            field(NOTIFICATION_SUBTYPE),
            i32::try_from(field(FOCUS_SUBJECT_PID)).unwrap_or(-1),
            field(FOCUS_THEFT_ID),
        )
    } else if matches!(callback.kind, TapKind::Intervention) {
        scope.observe_user_event(kind.0, source, destination)
    } else if matches!(callback.kind, TapKind::Keyboard(pid) if pid == destination) {
        if matches!(kind.0, 10..=12) {
            scope.keyboard(source, destination)
        } else {
            scope.activation_event(destination, kind.0, field(CGEventField(83)))
        }
    } else {
        Decision::Pass
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
    let context = ACTIVE.lock().ok().and_then(|active| active.clone());
    let Some(context) = context else { return };
    if context.registered.lock().map(|registered| registered.contains(&pid)).unwrap_or(false) {
        return;
    }
    let (send, receive) = mpsc::sync_channel(1);
    if context.registrations.send((pid, send)).is_err() {
        context.fail("Focus protection stopped before target registration");
        return;
    }
    match receive.recv_timeout(Duration::from_millis(350)) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => context.fail(error),
        Err(_) => context.fail("Focus protection target registration did not complete within 350 ms"),
    }
}

pub struct ActivationTransition {
    context: Arc<Context>,
}

impl ActivationTransition {
    pub fn verify_keyboard_owner(&self) -> Result<(), Failure> {
        let expected = self
            .context
            .scope
            .lock()
            .map_err(|_| Failure::new(ErrorCode::ActionFailed, "Focus protection state is unavailable"))?
            .keyboard_owner();
        if keyboard_focus_pid()? != expected {
            return Err(Failure::new(ErrorCode::ActionFailed, "Original keyboard owner was not restored after activation"));
        }
        Ok(())
    }

    pub fn begin(target: i32, original: i32) -> Result<Self, Failure> {
        include_target(target);
        include_target(original);
        check_current()?;
        let context = ACTIVE
            .lock()
            .ok()
            .and_then(|active| active.clone())
            .ok_or_else(|| Failure::new(ErrorCode::ActionFailed, "Activation protection is unavailable"))?;
        let allowed = context.scope.lock().map(|mut scope| scope.begin_activation(target)).unwrap_or(false);
        if !allowed {
            return Err(Failure::new(
                ErrorCode::ActionFailed,
                "Activation protection cannot start after interruption or during another transition",
            ));
        }
        Ok(Self { context })
    }
}

impl Drop for ActivationTransition {
    fn drop(&mut self) {
        if let Ok(mut scope) = self.context.scope.lock() {
            scope.end_activation();
            if scope.interrupted() {
                self.context.fail("User typed during activation; input was returned to its original owner and automation stopped");
            }
        }
    }
}

pub fn permits_foreground(pid: i32) -> bool {
    ACTIVE
        .lock()
        .ok()
        .and_then(|active| active.clone())
        .and_then(|context| context.scope.lock().ok().map(|scope| scope.permits_foreground(pid)))
        .unwrap_or(false)
}

pub struct Intervention {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    context: Arc<Context>,
}

impl Intervention {
    pub fn begin(target: i32, foreground: i32, keyboard_owner: i32) -> Result<Self, Failure> {
        check_secure_input()?;
        let pointer = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"CPSReleaseKeyFocusWithID".as_ptr()) };
        if pointer.is_null() {
            return Err(Failure::new(ErrorCode::ActionFailed, "Key-focus lease release is unavailable; input was not started"));
        }
        let release = unsafe { std::mem::transmute::<*mut c_void, ReleaseKeyFocus>(pointer) };
        let (registrations, requests) = mpsc::channel();
        let context = Arc::new(Context {
            scope: Mutex::new(Scope::new(std::process::id() as i32, foreground, keyboard_owner, target)),
            failure: Mutex::new(None),
            release,
            registered: Mutex::new(HashSet::new()),
            registrations,
        });
        let stop = Arc::new(AtomicBool::new(false));
        let quit = Arc::clone(&stop);
        let callback_context = Arc::clone(&context);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let thread = thread::spawn(move || {
            let mut taps = Vec::new();
            for kind in [TapKind::Notifications, TapKind::Intervention, TapKind::Keyboard(target)] {
                match Tap::new(Arc::clone(&callback_context), kind) {
                    Ok(tap) => taps.push(tap),
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                }
            }
            if let Ok(mut registered) = callback_context.registered.lock() {
                registered.insert(target);
            }
            if ready_tx.send(Ok(())).is_ok() {
                while !quit.load(Ordering::Acquire) {
                    while let Ok((pid, acknowledgement)) = requests.try_recv() {
                        let result: Result<(), String> = (|| {
                            let mut registered =
                                callback_context.registered.lock().map_err(|_| "Focus target state is unavailable".to_string())?;
                            if registered.contains(&pid) {
                                return Ok(());
                            }
                            if pid <= 0 || registered.len() >= 32 {
                                return Err("Focus target registration limit reached or PID invalid".into());
                            }
                            let tap = Tap::new(Arc::clone(&callback_context), TapKind::Keyboard(pid))?;
                            callback_context.scope.lock().map_err(|_| "Focus protection state is unavailable".to_string())?.include(pid);
                            registered.insert(pid);
                            taps.push(tap);
                            Ok(())
                        })();
                        if let Err(error) = &result {
                            callback_context.fail(error.clone());
                        }
                        let _ = acknowledgement.send(result);
                    }
                    CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, Duration::from_millis(30), false);
                }
            }
        });
        let ready = ready_rx.recv_timeout(Duration::from_millis(350));
        if matches!(ready, Ok(Ok(()))) {
            if let Ok(mut active) = ACTIVE.lock() {
                *active = Some(Arc::clone(&context));
            }
            return Ok(Self { stop, thread: Some(thread), context });
        }
        stop.store(true, Ordering::Release);
        let _ = thread.join();
        let message = match ready {
            Ok(Err(message)) => message,
            Err(mpsc::RecvTimeoutError::Timeout) => "Focus protection did not start within 350 ms".into(),
            _ => "Focus protection stopped before initialization".into(),
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
        check_secure_input()
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
    check_secure_input()
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

fn process_identity(pid: i32) -> Option<Option<f64>> {
    objc2::rc::autoreleasepool(|_| {
        objc2_app_kit::NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
            .filter(|app| !app.isTerminated())
            .map(|app| app.launchDate().map(|date| date.timeIntervalSinceReferenceDate()))
    })
}

#[derive(Default)]
struct LocalActivation {
    focused: bool,
    window: u32,
}

impl LocalActivation {
    fn event(&mut self, kind: u32, subtype: i64) {
        match (kind, subtype) {
            (20, _) | (13, 1) => self.focused = true,
            (19, _) | (13, 2) => self.focused = false,
            _ => {}
        }
    }
}

pub struct RetainedState {
    pid: i32,
    launched: Option<f64>,
    owners: Mutex<HashMap<i32, Option<f64>>>,
    activation: Mutex<LocalActivation>,
    menu: AtomicI32,
    failure: Mutex<Option<String>>,
    registrations: mpsc::Sender<(i32, mpsc::SyncSender<Result<(), String>>)>,
    runloop: Mutex<Option<CFRunLoop>>,
}

impl RetainedState {
    fn wake(&self) {
        if let Ok(runloop) = self.runloop.lock() {
            if let Some(runloop) = runloop.as_ref() {
                runloop.stop();
            }
        }
    }

    pub fn same_process(&self) -> bool {
        objc2::rc::autoreleasepool(|_| {
            objc2_app_kit::NSRunningApplication::runningApplicationWithProcessIdentifier(self.pid)
                .filter(|app| !app.isTerminated())
                .is_some_and(|app| app.launchDate().map(|d| d.timeIntervalSinceReferenceDate()) == self.launched)
        })
    }

    pub fn ready(&self, window: u32) -> Result<bool, Failure> {
        self.check()?;
        Ok(self.activation.lock().map(|state| state.focused && state.window == window).unwrap_or(false))
    }

    pub fn activated(&self, window: u32) {
        if let Ok(mut state) = self.activation.lock() {
            state.window = window;
        }
    }

    pub fn focused(&self) -> bool {
        self.activation.lock().map(|state| state.focused).unwrap_or(false)
    }

    pub fn menu(&self, owner: Option<i32>) {
        self.menu.store(0, Ordering::Release);
        let Some(owner) = owner else { return };
        if owner != self.pid {
            self.menu.store(-owner, Ordering::Release);
            let (send, _) = mpsc::sync_channel(1);
            if self.registrations.send((owner, send)).is_err() {
                if let Ok(mut failure) = self.failure.lock() {
                    failure.get_or_insert_with(|| "Menu protection stopped".into());
                }
            }
            self.wake();
        } else {
            self.menu.store(owner, Ordering::Release);
        }
    }

    pub fn check(&self) -> Result<(), Failure> {
        if !self.same_process() {
            return Err(Failure::new(ErrorCode::ActionFailed, "Retained target process changed; observe again"));
        }
        match self.failure.lock() {
            Ok(error) => error.as_ref().map_or(Ok(()), |e| Err(Failure::new(ErrorCode::ActionFailed, e.clone()))),
            Err(_) => Err(Failure::new(ErrorCode::ActionFailed, "Retained app protection is unavailable")),
        }
    }

    fn receive(&self, tap: TapKind, kind: CGEventType, event: &CGEvent, original: *mut CGEvent) -> *mut CGEvent {
        if !self.same_process() {
            return original;
        }
        let TapKind::Retained(pid) = tap else {
            return original;
        };
        let identity = process_identity(pid);
        if identity.is_none() || self.owners.lock().ok().and_then(|owners| owners.get(&pid).copied()) != identity {
            return original;
        }
        if kind.0 >= u32::MAX - 1 {
            if let Ok(mut failure) = self.failure.lock() {
                failure.get_or_insert_with(|| "Retained app event tap was disabled".into());
            }
            return original;
        }
        let destination = CGEvent::integer_value_field(Some(event), CGEventField::EventTargetUnixProcessID) as i32;
        if destination == self.pid {
            let subtype = CGEvent::integer_value_field(Some(event), CGEventField(83));
            let suppressed = ACTIVE.lock().ok().and_then(|active| active.clone()).is_some_and(|context| {
                context
                    .scope
                    .lock()
                    .map(|scope| {
                        !crate::cancellation::cancelled()
                            && context.failure.lock().map(|failure| failure.is_none()).unwrap_or(false)
                            && scope.activation_event(destination, kind.0, subtype) == Decision::Suppress
                    })
                    .unwrap_or(false)
            });
            if !suppressed {
                if let Ok(mut state) = self.activation.lock() {
                    state.event(kind.0, subtype);
                }
            }
        }
        let menu = self.menu.load(Ordering::Acquire);
        if menu > 0
            && self.failure.lock().map(|failure| failure.is_none()).unwrap_or(false)
            && !crate::cancellation::cancelled()
            && matches!(kind.0, 1 | 2 | 6 | 3 | 4 | 7 | 25 | 26 | 27)
        {
            let window = CGEvent::integer_value_field(Some(event), CGEventField(51));
            if let Some((owner, _)) = u32::try_from(window).ok().filter(|id| *id != 0).and_then(crate::mac::input_window_geometry) {
                if owner != self.pid && owner != menu {
                    return std::ptr::null_mut();
                }
            }
        }
        original
    }
}

fn stop_retained(stop: &AtomicBool, state: &RetainedState, thread: JoinHandle<()>) {
    stop.store(true, Ordering::Release);
    while !thread.is_finished() {
        state.wake();
        std::thread::sleep(Duration::from_millis(1));
    }
    let _ = thread.join();
}

pub struct Retained {
    pub state: Arc<RetainedState>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Retained {
    pub fn begin(pid: i32) -> Result<Self, Failure> {
        let (registrations, requests) = mpsc::channel();
        let launched = objc2_app_kit::NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
            .filter(|app| !app.isTerminated())
            .ok_or_else(|| Failure::new(ErrorCode::ActionFailed, "Target process exited"))?
            .launchDate()
            .map(|d| d.timeIntervalSinceReferenceDate());
        let state = Arc::new(RetainedState {
            pid,
            launched,
            owners: Mutex::new(HashMap::from([(pid, launched)])),
            activation: Mutex::new(LocalActivation::default()),
            menu: AtomicI32::new(0),
            failure: Mutex::new(None),
            registrations,
            runloop: Mutex::new(None),
        });
        let callback = Arc::clone(&state);
        let stop = Arc::new(AtomicBool::new(false));
        let quit = Arc::clone(&stop);
        let (send, ready) = mpsc::sync_channel(1);
        let thread = thread::spawn(move || {
            if let Ok(mut runloop) = callback.runloop.lock() {
                *runloop = Some(CFRunLoop::get_current());
            }
            let create =
                |pid| Tap::create(TapContext { context: None, retained: Some(Arc::clone(&callback)), kind: TapKind::Retained(pid) });
            let Some(_observer) = crate::mac::menu_observer(pid, Arc::clone(&callback)) else {
                let _ = send.send(Err("Cannot observe target menu lifecycle".to_string()));
                return;
            };
            let mut taps = match create(pid) {
                Ok(tap) => {
                    let _ = send.send(Ok(()));
                    vec![tap]
                }
                Err(error) => {
                    let _ = send.send(Err(error));
                    return;
                }
            };
            let mut registered = HashSet::from([pid]);
            while !quit.load(Ordering::Acquire) && !crate::cancellation::cancelled() && callback.same_process() {
                while let Ok((owner, ack)) = requests.try_recv() {
                    let result = if registered.contains(&owner) {
                        Ok(())
                    } else if owner <= 0 || registered.len() >= 32 {
                        Err("Menu target registration limit reached".into())
                    } else {
                        process_identity(owner).ok_or_else(|| "Menu target exited".to_string()).and_then(|identity| {
                            create(owner).map(|tap| {
                                if let Ok(mut owners) = callback.owners.lock() {
                                    owners.insert(owner, identity);
                                }
                                registered.insert(owner);
                                taps.push(tap);
                            })
                        })
                    };
                    if let Err(error) = &result {
                        if let Ok(mut failure) = callback.failure.lock() {
                            failure.get_or_insert_with(|| error.clone());
                        }
                    } else {
                        let _ = callback.menu.compare_exchange(-owner, owner, Ordering::AcqRel, Ordering::Acquire);
                    }
                    let _ = ack.send(result);
                }
                CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, Duration::from_secs(1), true);
            }
            if let Ok(mut failure) = callback.failure.lock() {
                if failure.is_none() {
                    *failure = Some("Retained app protection stopped".into());
                }
            }
        });
        let result = ready.recv_timeout(Duration::from_millis(350)).map_err(|e| e.to_string()).and_then(|result| result);
        if let Err(error) = result {
            stop_retained(&stop, &state, thread);
            return Err(Failure::new(ErrorCode::ActionFailed, error));
        }
        Ok(Self { state, stop, thread: Some(thread) })
    }
}

impl Drop for Retained {
    fn drop(&mut self) {
        self.state.menu(None);
        if let Some(thread) = self.thread.take() {
            stop_retained(&self.stop, &self.state, thread);
        }
    }
}

#[cfg(test)]
mod retained_tests {
    use super::*;

    #[test]
    fn local_focus_survives_command_boundaries_and_tracks_delivered_activation() {
        let mut state = LocalActivation::default();
        state.event(13, 1);
        state.window = 42;
        assert!(state.focused);
        state.event(10, 0);
        state.event(13, 23);
        assert!(state.focused);
        assert_eq!(state.window, 42);
        state.event(19, 0);
        assert!(!state.focused);
        state.event(20, 0);
        assert!(state.focused);
        state.event(13, 2);
        assert!(!state.focused);
    }
}
