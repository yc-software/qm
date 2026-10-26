use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const QUIET: Duration = Duration::from_secs(5);
const CAP: Duration = Duration::from_secs(100);

#[derive(Default)]
pub struct Registry {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    sessions: HashSet<i32>,
    events: HashMap<i32, Instant>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Gate {
    Ready,
    Wait(Duration),
    Changed,
    Busy(Duration),
}

impl Registry {
    pub fn session(&self, pid: i32, active: bool) {
        if let Ok(mut state) = self.state.lock() {
            if active {
                state.sessions.insert(pid);
            } else {
                state.sessions.remove(&pid);
                state.events.remove(&pid);
            }
        }
    }

    pub fn record(&self, pid: i32, now: Instant) {
        if let Ok(mut state) = self.state.lock() {
            if state.sessions.contains(&pid) {
                state.events.insert(pid, now);
            }
        }
    }

    pub fn gate(&self, pid: i32, start: Instant, now: Instant) -> Gate {
        let Ok(state) = self.state.lock() else { return Gate::Changed };
        let Some(last) = state.events.get(&pid) else { return Gate::Ready };
        let elapsed = now.saturating_duration_since(*last);
        if elapsed >= QUIET {
            return Gate::Changed;
        }
        let left = CAP.saturating_sub(now.saturating_duration_since(start));
        if left.is_zero() {
            Gate::Busy(QUIET.saturating_sub(elapsed))
        } else {
            Gate::Wait(QUIET.saturating_sub(elapsed).min(left).min(Duration::from_millis(250)))
        }
    }

    pub fn clear(&self, pid: i32, observed_at: Instant) {
        if let Ok(mut state) = self.state.lock() {
            if state.events.get(&pid).is_some_and(|last| *last <= observed_at) {
                state.events.remove(&pid);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_restarts_and_observation_clears() {
        let registry = Registry::default();
        let start = Instant::now();
        registry.record(3, start);
        assert_eq!(registry.gate(3, start, start), Gate::Ready);
        registry.session(3, true);
        registry.record(3, start);
        assert_eq!(registry.gate(3, start, start), Gate::Wait(Duration::from_millis(250)));
        registry.record(3, start + Duration::from_secs(4));
        assert!(matches!(registry.gate(3, start, start + Duration::from_secs(6)), Gate::Wait(_)));
        assert_eq!(registry.gate(3, start, start + Duration::from_secs(9)), Gate::Changed);
        registry.clear(3, start + Duration::from_secs(9));
        assert_eq!(registry.gate(3, start, start + Duration::from_secs(9)), Gate::Ready);
    }

    #[test]
    fn observation_preserves_input_received_during_capture() {
        let registry = Registry::default();
        let start = Instant::now();
        registry.session(3, true);
        registry.record(3, start);
        let observed_at = start + Duration::from_secs(5);
        registry.record(3, observed_at + Duration::from_millis(1));
        registry.clear(3, observed_at);
        assert!(matches!(registry.gate(3, start, observed_at), Gate::Wait(_)));
        assert_eq!(registry.gate(4, start, observed_at), Gate::Ready);
    }

    #[test]
    fn cap_fails_before_a_continually_busy_app_quiets() {
        let registry = Registry::default();
        let start = Instant::now();
        registry.session(3, true);
        registry.record(3, start + Duration::from_secs(99));
        assert_eq!(registry.gate(3, start, start + Duration::from_secs(100)), Gate::Busy(Duration::from_secs(4)));
        registry.session(3, false);
        assert_eq!(registry.gate(3, start, start + Duration::from_secs(100)), Gate::Ready);
    }
}
