use std::collections::HashSet;

pub const PROCESS_NOTIFICATION: u32 = 21;
pub const NEW_FRONT: i64 = 2;
pub const KEY_FOCUS_TAKEN: i64 = 0x4000;
pub const KEY_FOCUS_RETURNED: i64 = 0x8000;
pub const KEY_FOCUS_CHANGED: i64 = 0xf102;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Pass,
    Suppress,
    Release(u32),
    Redirect(i32),
    Intervened,
    Stop(&'static str),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Lease {
    thief: i32,
    victim: i32,
    released: bool,
    returned: bool,
}

pub struct Scope {
    owner: i32,
    foreground: i32,
    keyboard_owner: i32,
    targets: HashSet<i32>,
    lease: Option<Lease>,
    yielded: bool,
}

impl Scope {
    pub fn new(owner: i32, foreground: i32, keyboard_owner: i32, target: i32) -> Self {
        Self { owner, foreground, keyboard_owner, targets: HashSet::from([target]), lease: None, yielded: false }
    }

    pub fn include(&mut self, pid: i32) {
        if pid > 0 && pid != self.foreground && pid != self.keyboard_owner {
            self.targets.insert(pid);
        }
    }

    pub fn yield_to_user(&mut self) {
        self.yielded = true;
        self.lease = None;
    }

    pub fn notification(&mut self, destination: i32, subtype: i64, subject: i32, theft_id: i64) -> Decision {
        if self.yielded {
            return Decision::Pass;
        }
        match subtype {
            KEY_FOCUS_TAKEN if destination == self.keyboard_owner && subject != destination && self.targets.contains(&subject) => {
                if self.lease.is_none_or(|lease| lease.returned) {
                    self.lease = Some(Lease { thief: subject, victim: destination, released: false, returned: false });
                    Decision::Suppress
                } else {
                    self.yield_to_user();
                    Decision::Stop("Nested target key-focus lease is unsupported; stopped")
                }
            }
            KEY_FOCUS_CHANGED => {
                if let Some(lease) = self.lease {
                    if subject == lease.thief && !lease.released {
                        if let Ok(id) = u32::try_from(theft_id) {
                            return Decision::Release(id);
                        }
                        self.yield_to_user();
                        return Decision::Stop("Target key-focus notification has no valid theft ID; stopped");
                    }
                }
                Decision::Pass
            }
            KEY_FOCUS_RETURNED => {
                if let Some(lease) = self.lease.as_mut() {
                    if destination == lease.victim && lease.released && !lease.returned {
                        lease.returned = true;
                        return Decision::Suppress;
                    }
                }
                Decision::Pass
            }
            NEW_FRONT => {
                if subject > 0 && subject != self.foreground {
                    self.yield_to_user();
                    return Decision::Stop("System focus changed during protected input; stopped");
                }
                Decision::Pass
            }
            _ => Decision::Pass,
        }
    }

    pub fn released(&mut self, success: bool) {
        if let Some(lease) = self.lease.as_mut() {
            lease.released = success;
        }
        if !success {
            self.yield_to_user();
        }
    }

    pub fn user_event(&mut self, kind: u32, source: i32, destination: i32) -> Decision {
        if source == self.owner || self.yielded {
            return Decision::Pass;
        }
        if (matches!(kind, 1 | 3 | 25) && destination != self.keyboard_owner) || (kind == 22 && self.targets.contains(&destination)) {
            self.yield_to_user();
            return Decision::Intervened;
        }
        if matches!(kind, 10..=12) {
            let decision = self.keyboard(source, destination);
            if decision != Decision::Pass {
                return decision;
            }
            if self.targets.contains(&destination) {
                self.yield_to_user();
                return Decision::Intervened;
            }
        }
        Decision::Pass
    }

    pub fn observe_user_event(&mut self, kind: u32, source: i32, destination: i32) -> Decision {
        match self.user_event(kind, source, destination) {
            Decision::Redirect(_) => Decision::Pass,
            decision => decision,
        }
    }

    pub fn keyboard(&self, source: i32, destination: i32) -> Decision {
        if !self.yielded && source != self.owner {
            if let Some(lease) = self.lease {
                if destination == lease.thief {
                    return Decision::Redirect(lease.victim);
                }
            }
        }
        Decision::Pass
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> Scope {
        Scope::new(100, 200, 200, 300)
    }

    #[test]
    fn global_observer_preserves_keys_for_process_local_forwarding() {
        let mut s = scope();
        s.notification(200, KEY_FOCUS_TAKEN, 300, 0);
        for kind in 10..=12 {
            assert_eq!(s.observe_user_event(kind, 0, 300), Decision::Pass);
            assert_eq!(s.keyboard(0, 300), Decision::Redirect(200));
            assert_eq!(s.observe_user_event(kind, 0, 200), Decision::Pass);
            assert_eq!(s.keyboard(0, 200), Decision::Pass);
            assert_eq!(s.keyboard(100, 300), Decision::Pass);
        }
        assert_eq!(s.observe_user_event(1, 0, 300), Decision::Intervened);
        assert_eq!(s.keyboard(0, 300), Decision::Pass);
    }

    #[test]
    fn nonactivating_panel_keeps_keyboard_ownership_separate_from_foreground() {
        let mut s = Scope::new(100, 200, 250, 300);
        assert_eq!(s.notification(200, KEY_FOCUS_TAKEN, 300, 0), Decision::Pass);
        assert_eq!(s.notification(250, KEY_FOCUS_TAKEN, 300, 0), Decision::Suppress);
        assert_eq!(s.notification(400, KEY_FOCUS_CHANGED, 300, 7), Decision::Release(7));
        s.released(true);
        assert_eq!(s.notification(250, KEY_FOCUS_RETURNED, 0, 0), Decision::Suppress);
        assert_eq!(s.user_event(10, 0, 300), Decision::Redirect(250));
        assert_eq!(s.user_event(1, 0, 250), Decision::Pass);
        assert_eq!(s.notification(200, NEW_FRONT, 200, 0), Decision::Pass);
        assert!(matches!(s.notification(250, NEW_FRONT, 250, 0), Decision::Stop(_)));
    }

    #[test]
    fn completed_pairs_allow_the_next_background_action() {
        let mut s = scope();
        for id in [7, 8, 9] {
            assert_eq!(s.notification(200, KEY_FOCUS_TAKEN, 300, 0), Decision::Suppress);
            assert_eq!(s.notification(400, KEY_FOCUS_CHANGED, 300, id), Decision::Release(id as u32));
            s.released(true);
            assert_eq!(s.notification(200, KEY_FOCUS_RETURNED, 0, 0), Decision::Suppress);
            assert_eq!(s.keyboard(0, 300), Decision::Redirect(200));
        }
    }

    #[test]
    fn nested_leases_stop_and_a_forwarded_key_cannot_loop() {
        let mut s = scope();
        s.notification(200, KEY_FOCUS_TAKEN, 300, 0);
        let Decision::Redirect(destination) = s.user_event(10, 0, 300) else { panic!() };
        assert_eq!(s.user_event(10, 0, destination), Decision::Pass);
        assert!(matches!(s.notification(200, KEY_FOCUS_TAKEN, 300, 0), Decision::Stop(_)));
        assert_eq!(s.keyboard(0, 300), Decision::Pass);
    }

    #[test]
    fn app_switching_and_direct_target_input_yield_without_consuming_events() {
        let mut s = scope();
        s.notification(200, KEY_FOCUS_TAKEN, 300, 0);
        assert_eq!(s.user_event(10, 0, 300), Decision::Redirect(200));
        assert_eq!(s.user_event(11, 0, 300), Decision::Redirect(200));
        assert_eq!(s.user_event(10, 100, 300), Decision::Pass);
        assert_eq!(s.user_event(10, 0, 200), Decision::Pass);
        assert_eq!(s.user_event(1, 0, 300), Decision::Intervened);
        assert_eq!(s.user_event(10, 0, 300), Decision::Pass);
        assert_eq!(scope().user_event(1, 0, 300), Decision::Intervened);
        assert_eq!(scope().user_event(10, 0, 300), Decision::Intervened);
        assert_eq!(scope().user_event(10, 0, 200), Decision::Pass);
    }

    #[test]
    fn physical_scroll_on_target_yields_without_consuming_the_event() {
        let mut s = scope();
        s.include(301);
        assert_eq!(s.user_event(22, 100, 300), Decision::Pass);
        assert_eq!(s.user_event(22, 0, 200), Decision::Pass);
        assert_eq!(s.user_event(22, 0, 900), Decision::Pass);
        assert_eq!(s.user_event(22, 0, 301), Decision::Intervened);
        assert_eq!(s.notification(200, KEY_FOCUS_TAKEN, 300, 0), Decision::Pass);
        assert_eq!(scope().user_event(22, 0, 300), Decision::Intervened);
    }

    #[test]
    fn release_is_tied_to_an_observed_target_lease() {
        let mut s = scope();
        assert_eq!(s.notification(400, KEY_FOCUS_CHANGED, 300, 7), Decision::Pass);
        assert_eq!(s.notification(200, KEY_FOCUS_TAKEN, 300, 0), Decision::Suppress);
        assert_eq!(s.notification(400, KEY_FOCUS_CHANGED, 900, 7), Decision::Pass);
        assert_eq!(s.notification(400, KEY_FOCUS_CHANGED, 300, 7), Decision::Release(7));
        s.released(true);
        assert_eq!(s.notification(400, KEY_FOCUS_CHANGED, 300, 7), Decision::Pass);
        assert_eq!(s.notification(200, KEY_FOCUS_RETURNED, 0, 0), Decision::Suppress);
        assert_eq!(s.notification(200, KEY_FOCUS_RETURNED, 0, 0), Decision::Pass);
    }

    #[test]
    fn only_misrouted_external_keys_are_forwarded() {
        let mut s = scope();
        assert_eq!(s.keyboard(0, 300), Decision::Pass);
        s.notification(200, KEY_FOCUS_TAKEN, 300, 0);
        assert_eq!(s.keyboard(0, 300), Decision::Redirect(200));
        assert_eq!(s.keyboard(100, 300), Decision::Pass);
        assert_eq!(s.keyboard(0, 200), Decision::Pass);
        assert_eq!(s.keyboard(0, 900), Decision::Pass);
        s.yield_to_user();
        assert_eq!(s.keyboard(0, 300), Decision::Pass);
    }

    #[test]
    fn unrelated_notifications_pass() {
        let mut s = scope();
        for (destination, subject) in [(900, 300), (200, 900)] {
            assert_eq!(s.notification(destination, KEY_FOCUS_TAKEN, subject, 1), Decision::Pass);
        }
        assert_eq!(s.notification(200, 99, 300, 1), Decision::Pass);
    }

    #[test]
    fn genuine_activation_is_never_suppressed() {
        let mut s = scope();
        s.notification(200, KEY_FOCUS_TAKEN, 300, 0);
        assert!(matches!(s.notification(200, NEW_FRONT, 300, 0), Decision::Stop(_)));
        assert_eq!(s.keyboard(0, 300), Decision::Pass);
        assert_eq!(s.notification(400, KEY_FOCUS_CHANGED, 300, 7), Decision::Pass);
    }

    #[test]
    fn delegated_processes_require_explicit_registration() {
        let mut s = scope();
        assert_eq!(s.notification(200, KEY_FOCUS_TAKEN, 301, 0), Decision::Pass);
        s.include(301);
        assert_eq!(s.notification(200, KEY_FOCUS_TAKEN, 301, 0), Decision::Suppress);
        assert_eq!(s.keyboard(0, 301), Decision::Redirect(200));
    }

    #[test]
    fn invalid_ids_and_failed_release_do_not_repeat() {
        let mut s = scope();
        s.notification(200, KEY_FOCUS_TAKEN, 300, 0);
        assert!(matches!(s.notification(400, KEY_FOCUS_CHANGED, 300, -1), Decision::Stop(_)));
        assert_eq!(s.notification(400, KEY_FOCUS_CHANGED, 300, i64::MAX), Decision::Pass);
        s.released(false);
        assert_eq!(s.keyboard(0, 300), Decision::Pass);
    }
}
