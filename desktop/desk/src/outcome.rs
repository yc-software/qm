use crate::protocol::{Failure, Outcome, OutcomeStatus};
use std::time::{Duration, Instant};

pub const DEFAULT_TIMEOUT_MS: u32 = 2_000;
const POLL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, PartialEq)]
pub struct Check {
    pub met: bool,
    pub state: String,
}

impl Check {
    pub fn new(met: bool, state: impl Into<String>) -> Check {
        Check { met, state: state.into() }
    }
}

pub fn before(check: Check) -> Option<Outcome> {
    check.met.then(|| Outcome { status: OutcomeStatus::Already, detail: format!("{} before the action, so it was not sent", check.state) })
}

pub fn after(
    mut check: impl FnMut() -> Result<Check, Failure>,
    timeout_ms: u32,
    mut sleep: impl FnMut(Duration),
    cancelled: impl Fn() -> bool,
) -> Result<Outcome, Failure> {
    let limit = Duration::from_millis(u64::from(timeout_ms));
    let start = Instant::now();
    loop {
        let current = check()?;
        if current.met {
            return Ok(Outcome { status: OutcomeStatus::Verified, detail: current.state });
        }
        let elapsed = start.elapsed();
        if elapsed >= limit || cancelled() {
            return Ok(Outcome {
                status: OutcomeStatus::Unmet,
                detail: format!("after {} ms, {}", elapsed.as_millis().min(u128::from(timeout_ms)), current.state),
            });
        }
        sleep(POLL.min(limit - elapsed));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ErrorCode;

    #[test]
    fn a_condition_already_met_skips_the_action() {
        assert_eq!(before(Check::new(false, "element 4 is still present")), None);
        let outcome = before(Check::new(true, "element 4 is gone")).unwrap();
        assert_eq!(outcome.status, OutcomeStatus::Already);
        assert_eq!(outcome.detail, "element 4 is gone before the action, so it was not sent");
    }

    #[test]
    fn verifies_once_the_condition_holds() {
        let mut polls = 0;
        let outcome = after(
            || {
                polls += 1;
                Ok(if polls < 3 { Check::new(false, "element 4 is still present") } else { Check::new(true, "element 4 is gone") })
            },
            2_000,
            |_| {},
            || false,
        )
        .unwrap();
        assert_eq!(polls, 3);
        assert_eq!(outcome, Outcome { status: OutcomeStatus::Verified, detail: "element 4 is gone".into() });
    }

    #[test]
    fn reports_the_last_state_when_the_condition_never_holds() {
        let mut slept = Duration::ZERO;
        let outcome = after(
            || Ok(Check::new(false, "element 4 is still present")),
            30,
            |d| {
                slept += d;
                std::thread::sleep(d);
            },
            || false,
        )
        .unwrap();
        assert_eq!(outcome.status, OutcomeStatus::Unmet);
        assert!(outcome.detail.starts_with("after "), "{}", outcome.detail);
        assert!(outcome.detail.ends_with(" ms, element 4 is still present"), "{}", outcome.detail);
        assert!(slept <= Duration::from_millis(30));
    }

    #[test]
    fn cancellation_and_errors_stop_polling() {
        let outcome = after(|| Ok(Check::new(false, "no window titled \"Save\" is open")), 10_000, |_| panic!("slept"), || true).unwrap();
        assert_eq!(outcome.status, OutcomeStatus::Unmet);
        let error = after(|| Err(Failure::new(ErrorCode::BadIndex, "gone")), 10_000, |_| {}, || false).unwrap_err();
        assert_eq!(error.code, ErrorCode::BadIndex);
    }
}
