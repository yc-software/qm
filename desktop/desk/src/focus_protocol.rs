use std::collections::HashSet;

pub const PROCESS_NOTIFICATION: u32 = 21;
pub const KEY_FOCUS_TAKEN: i64 = 0x4000;
pub const KEY_FOCUS_RETURNED: i64 = 0x8000;
pub const KEY_FOCUS_CHANGED: i64 = 0xf102;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Pass,
    Suppress,
    Release(u32),
    Redirect(i32),
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
    leases: Vec<Lease>,
    yielded: bool,
    activation: Option<i32>,
}

impl Scope {
    pub fn new(owner: i32, foreground: i32, keyboard_owner: i32, target: i32) -> Self {
        Self { owner, foreground, keyboard_owner, targets: HashSet::from([target]), leases: Vec::new(), yielded: false, activation: None }
    }

    pub fn begin_activation(&mut self, target: i32) -> bool {
        if self.yielded || self.activation.is_some() || !self.targets.contains(&target) {
            return false;
        }
        self.activation = Some(target);
        true
    }

    pub fn keyboard_owner(&self) -> i32 {
        self.keyboard_owner
    }

    pub fn end_activation(&mut self) {
        self.activation = None;
    }

    pub fn activation_event(&self, destination: i32, kind: u32, subtype: i64) -> Decision {
        if !self.yielded
            && self.activation.is_some_and(|target| destination == target || destination == self.foreground)
            && (kind == 19 || (kind == 13 && matches!(subtype, 2 | 22 | 23)))
        {
            Decision::Suppress
        } else {
            Decision::Pass
        }
    }

    pub fn include(&mut self, pid: i32) {
        if pid > 0 && pid != self.foreground && pid != self.keyboard_owner {
            self.targets.insert(pid);
        }
    }

    pub fn yield_to_user(&mut self) {
        self.yielded = true;
        self.leases.clear();
    }

    pub fn notification(&mut self, destination: i32, subtype: i64, subject: i32, theft_id: i64) -> Decision {
        if self.yielded {
            return Decision::Pass;
        }
        match subtype {
            KEY_FOCUS_TAKEN
                if subject != destination
                    && self.targets.contains(&subject)
                    && (destination == self.keyboard_owner || self.leases.last().is_some_and(|lease| lease.thief == destination)) =>
            {
                self.leases.push(Lease { thief: subject, victim: destination, released: false, returned: false });
                Decision::Suppress
            }
            KEY_FOCUS_CHANGED => {
                if let Some(lease) = self.leases.last() {
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
                if self.leases.last().is_some_and(|lease| destination == lease.victim && lease.released && !lease.returned) {
                    self.leases.pop();
                    Decision::Suppress
                } else {
                    Decision::Pass
                }
            }
            _ => Decision::Pass,
        }
    }

    pub fn released(&mut self, success: bool) {
        if let Some(lease) = self.leases.last_mut() {
            lease.released = success;
        }
        if !success {
            self.yield_to_user();
        }
    }

    pub fn keyboard(&mut self, source: i32, destination: i32) -> Decision {
        if self.activation == Some(destination) && source != self.owner && !self.yielded {
            return Decision::Redirect(self.keyboard_owner);
        }
        if !self.yielded && source != self.owner {
            if let Some(lease) = self.leases.last().copied() {
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

    #[test]
    fn foreground_and_human_input_continue() {
        let mut scope = Scope::new(100, 200, 200, 300);
        assert!(scope.begin_activation(300));
        assert_eq!(scope.keyboard(0, 300), Decision::Redirect(200));
        assert_eq!(scope.notification(200, 2, 400, 0), Decision::Pass);
        scope.end_activation();
        assert!(scope.begin_activation(300));
    }

    #[test]
    fn human_keys_keep_the_original_owner_during_activation() {
        let mut scope = Scope::new(100, 200, 200, 300);
        assert!(scope.begin_activation(300));
        assert_eq!(scope.keyboard(0, 200), Decision::Pass);
        assert_eq!(scope.keyboard(0, 300), Decision::Redirect(200));
        scope.end_activation();
        assert!(scope.begin_activation(300));
    }

    #[test]
    fn sequential_leases_keep_their_paired_returns() {
        let mut scope = Scope::new(100, 200, 200, 300);
        for id in [7, 8] {
            assert_eq!(scope.notification(200, KEY_FOCUS_TAKEN, 300, 0), Decision::Suppress);
            assert_eq!(scope.notification(400, KEY_FOCUS_CHANGED, 300, id), Decision::Release(id as u32));
            scope.released(true);
            assert_eq!(scope.notification(200, KEY_FOCUS_RETURNED, 0, 0), Decision::Suppress);
            assert_eq!(scope.notification(200, KEY_FOCUS_RETURNED, 0, 0), Decision::Pass);
        }
    }

    #[test]
    fn invalid_lease_id_still_stops() {
        let mut scope = Scope::new(100, 200, 200, 300);
        scope.notification(200, KEY_FOCUS_TAKEN, 300, 0);
        assert!(matches!(scope.notification(400, KEY_FOCUS_CHANGED, 300, -1), Decision::Stop(_)));
        assert_eq!(scope.keyboard(0, 300), Decision::Pass);
    }

    #[test]
    fn nested_leases_release_inner_first() {
        let mut scope = Scope::new(100, 200, 200, 300);
        scope.include(301);
        assert_eq!(scope.notification(200, KEY_FOCUS_TAKEN, 300, 0), Decision::Suppress);
        assert_eq!(scope.notification(300, KEY_FOCUS_TAKEN, 301, 0), Decision::Suppress);
        assert_eq!(scope.notification(400, KEY_FOCUS_CHANGED, 301, 8), Decision::Release(8));
        scope.released(true);
        assert_eq!(scope.notification(300, KEY_FOCUS_RETURNED, 0, 0), Decision::Suppress);
        assert_eq!(scope.notification(400, KEY_FOCUS_CHANGED, 300, 7), Decision::Release(7));
        scope.released(true);
        assert_eq!(scope.notification(200, KEY_FOCUS_RETURNED, 0, 0), Decision::Suppress);
    }
}
