use super::*;

impl Desk {
    pub(super) fn condition(&self, app: &App, condition: &Condition) -> Result<outcome::Check, Failure> {
        let pid = app.pid;
        let live = |index: u32| -> Result<Option<El>, Failure> {
            let observed = self
                .cache
                .get(&pid)
                .and_then(|s| s.elements.iter().find(|(id, _)| *id == index).map(|(_, e)| e.clone()))
                .ok_or_else(|| fail(ErrorCode::BadIndex, format!("no element {index} in the latest observation; observe again")))?;
            match self.element(pid, index) {
                Ok(e) => Ok(Some(e)),
                Err(e) if e.code == ErrorCode::BadIndex && !cancellation::cancelled() && dead(&observed) => Ok(None),
                Err(e) => Err(e),
            }
        };
        let gone = |index: u32| outcome::Check::new(false, format!("element {index} is gone"));
        Ok(match condition {
            Condition::Gone { index } => match live(*index)? {
                None => outcome::Check::new(true, format!("element {index} is gone")),
                Some(_) => outcome::Check::new(false, format!("element {index} is still present")),
            },
            Condition::Value { index, equals } => match live(*index)? {
                None => gone(*index),
                Some(e) if secure_element(&e) => {
                    return Err(fail(
                        ErrorCode::ActionFailed,
                        format!("element {index} is a password field; its value is never read, so it cannot be checked"),
                    ))
                }
                Some(e) => match attr(&e, "AXValue").as_ref().and_then(held) {
                    Some(value) => outcome::Check::new(
                        text::reads(&value, equals),
                        format!("element {index} reads {:?}", tree::clip(&value.shown(), 80)),
                    ),
                    None => outcome::Check::new(false, format!("element {index}'s value cannot be read")),
                },
            },
            Condition::Window { title, open } => {
                let needle = title.to_lowercase();
                let found = windows::titles(&app_element(pid))?.into_iter().find(|t| t.to_lowercase().contains(&needle));
                match (found, *open) {
                    (Some(t), true) => outcome::Check::new(true, format!("window {:?} is open", tree::clip(&t, 80))),
                    (None, true) => outcome::Check::new(false, format!("no window titled {title:?} is open")),
                    (None, false) => outcome::Check::new(true, format!("no window titled {title:?} is open")),
                    (Some(t), false) => outcome::Check::new(false, format!("window {:?} is still open", tree::clip(&t, 80))),
                }
            }
        })
    }
}
