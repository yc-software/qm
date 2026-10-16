use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, LazyLock,
};
use std::time::{Duration, Instant};

static CANCELLED: LazyLock<Arc<AtomicBool>> = LazyLock::new(|| Arc::new(AtomicBool::new(false)));

pub fn install() -> Result<(), String> {
    for signal in [signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT] {
        signal_hook::flag::register(signal, Arc::clone(&CANCELLED)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn cancelled() -> bool {
    CANCELLED.load(Ordering::Relaxed)
}

pub fn wait(duration: Duration) {
    let until = Instant::now() + duration;
    while !cancelled() {
        let remaining = until.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        std::thread::sleep(remaining.min(Duration::from_millis(10)));
    }
}
