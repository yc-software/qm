use super::*;
use crate::tree::clip;
use objc2_app_kit::NSRunningApplication;

const VIEW_SERVICES: &[&str] = &["com.apple.appkit.xpc.openAndSavePanelService"];
const MENU_ITEMS: &[&str] = &["AXMenuItem", "AXMenuBarItem"];
const SELECTS: &[&str] = &["AXRow", "AXCell", "AXOutlineRow", "AXListItem"];
const TEXT_ROLES: &[&str] = &["AXTextField", "AXTextArea", "AXComboBox"];

fn element_at(root: &El, p: CGPoint) -> Option<El> {
    let mut v: CFTypeRef = std::ptr::null();
    let status = unsafe { AXUIElementCopyElementAtPosition(root.as_CFTypeRef(), p.x as f32, p.y as f32, &mut v) };
    (status == 0 && !v.is_null()).then(|| unsafe { CFType::wrap_under_create_rule(v) })
}

fn within(e: &El, ancestor: &El) -> bool {
    let mut cur = Some(e.clone());
    for _ in 0..MAX_DEPTH {
        match cur {
            Some(c) if c == *ancestor => return true,
            Some(c) => cur = attr(&c, "AXParent"),
            None => return false,
        }
    }
    false
}

fn has_role(e: &El, roles: &[&str]) -> bool {
    str_attr(e, "AXRole").is_some_and(|r| roles.contains(&r.as_str()))
}

fn describe(e: &El) -> String {
    let role = str_attr(e, "AXRole").unwrap_or_default();
    let name = str_attr(e, "AXTitle").or_else(|| str_attr(e, "AXDescription")).or_else(|| str_attr(e, "AXValue"));
    match name {
        Some(n) => format!("{} \"{}\"", role.trim_start_matches("AX"), clip(&n, 40)),
        None => role.trim_start_matches("AX").to_string(),
    }
}

pub(super) fn clickable(ax: &El, e: &El, index: u32, visible: Rect) -> Result<CGPoint, Failure> {
    let mut fallback = None;
    let mut cover = None;
    for (fx, fy) in [(0.5, 0.5), (0.25, 0.5), (0.75, 0.5), (0.5, 0.25), (0.5, 0.75)] {
        let p = pt(visible.x + visible.w * fx, visible.y + visible.h * fy);
        match element_at(ax, p) {
            Some(h) if within(&h, e) => return Ok(p),
            Some(h) if within(e, &h) => {
                fallback.get_or_insert(p);
            }
            Some(h) => {
                cover.get_or_insert(h);
            }
            None => {
                fallback.get_or_insert(p);
            }
        }
    }
    fallback.ok_or_else(|| {
        let by = cover.map(|c| describe(&c)).unwrap_or_default();
        fail(ErrorCode::ActionFailed, format!("element {index} is covered by {by}; close or move what covers it, or observe again"))
    })
}

fn view_service(pid: i32) -> bool {
    NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .and_then(|a| a.bundleIdentifier())
        .is_some_and(|b| VIEW_SERVICES.contains(&b.to_string().as_str()))
}

fn inside(inner: Rect, outer: Rect) -> bool {
    const SLACK: f64 = 4.0;
    inner.x >= outer.x - SLACK
        && inner.y >= outer.y - SLACK
        && inner.x + inner.w <= outer.x + outer.w + SLACK
        && inner.y + inner.h <= outer.y + outer.h + SLACK
}

pub(super) fn service_at(app_pid: i32, ax: &El, window: Option<Rect>, p: CGPoint) -> Option<(i32, El, u32)> {
    let pid = pid_of(&element_at(ax, p)?)?;
    if pid == app_pid || !view_service(pid) {
        return None;
    }
    let service = app_element(pid);
    let (w, _) = hit(&service, p)?;
    let id = window_id(&w);
    (id != 0 && frame(&w).zip(window).is_some_and(|(f, outer)| inside(f, outer))).then_some((pid, service, id))
}

pub(super) fn service_panels(pid: i32, window: &El, outer: Rect) -> Vec<u32> {
    let own = window_id(window);
    let mut found = vec![];
    let mut level = vec![window.clone()];
    let mut visited = 0;
    for _ in 0..4 {
        let mut next = vec![];
        for e in level.iter().flat_map(|e| attr(e, "AXChildren").map(list).unwrap_or_default()) {
            visited += 1;
            if visited > 400 {
                return found;
            }
            match pid_of(&e) {
                Some(p) if p != pid && view_service(p) => {
                    let id = window_id(&e);
                    if id != 0 && id != own && !found.contains(&id) && frame(&e).is_some_and(|f| inside(f, outer)) {
                        found.push(id);
                    }
                }
                _ => next.push(e),
            }
        }
        level = next;
    }
    found
}

pub(super) fn keyboard_target(app_pid: i32, ax: &El) -> (i32, El) {
    match attr(ax, "AXFocusedUIElement").and_then(|f| pid_of(&f)) {
        Some(pid) if pid != app_pid && view_service(pid) => (pid, app_element(pid)),
        _ => (app_pid, ax.clone()),
    }
}

pub(super) fn menu_open(ax: &El) -> bool {
    let kids = |e: &El| attr(e, "AXChildren").map(list).unwrap_or_default();
    kids(ax).iter().any(|c| has_role(c, &["AXMenu"]))
        || attr(ax, "AXMenuBar").is_some_and(|bar| kids(&bar).iter().any(|item| bool_attr(item, "AXSelected") == Some(true)))
}

pub(super) const MENU_OPEN: &str =
    "A menu is open, and pointer input inside or around it is unreliable. Click a menu item by its id, or press Escape to close the menu, then observe again.";

pub(super) fn is_menu_item(e: &El) -> bool {
    has_role(e, MENU_ITEMS)
}

fn in_web(e: &El) -> bool {
    let mut cur = Some(e.clone());
    for _ in 0..MAX_DEPTH {
        let Some(c) = cur else { return false };
        match str_attr(&c, "AXRole").as_deref() {
            Some("AXWebArea") => return true,
            Some("AXWindow") | Some("AXApplication") => return false,
            _ => cur = attr(&c, "AXParent"),
        }
    }
    false
}

pub(super) fn simulate(e: &El) -> bool {
    if is_menu_item(e) {
        return false;
    }
    if !actions(e).iter().any(|a| a == "AXPress") {
        return true;
    }
    has_role(e, SELECTS) || in_web(e)
}

pub(super) fn scroll_area(e: &El) -> Option<El> {
    let mut cur = Some(e.clone());
    for _ in 0..MAX_DEPTH {
        let c = cur?;
        if has_role(&c, &["AXScrollArea"]) {
            return Some(c);
        }
        if has_role(&c, &["AXWindow", "AXApplication"]) {
            return None;
        }
        cur = attr(&c, "AXParent");
    }
    None
}

pub(super) fn area_at(ax: &El, p: CGPoint) -> Option<El> {
    scroll_area(&element_at(ax, p)?)
}

fn number(e: &El, name: &str) -> Option<f64> {
    attr(e, name)?.downcast::<CFNumber>()?.to_f64()
}

pub(super) fn scroll_pages(area: &El, direction: Direction, pages: f64) -> Result<bool, Failure> {
    if pages.is_nan() || pages <= 0.0 {
        return Ok(false);
    }
    let (action, bar, sign) = match direction {
        Direction::Up => ("AXScrollUpByPage", "AXVerticalScrollBar", -1.0),
        Direction::Down => ("AXScrollDownByPage", "AXVerticalScrollBar", 1.0),
        Direction::Left => ("AXScrollLeftByPage", "AXHorizontalScrollBar", -1.0),
        Direction::Right => ("AXScrollRightByPage", "AXHorizontalScrollBar", 1.0),
    };
    let whole = pages.fract() == 0.0 && pages <= 20.0;
    if whole && actions(area).iter().any(|a| a == action) {
        for _ in 0..pages as u32 {
            active()?;
            perform(area, action)?;
        }
        return Ok(true);
    }
    let Some(bar) = attr(area, bar).filter(|b| settable(b, "AXValue")) else { return Ok(false) };
    let (Some(value), Some(track)) = (number(&bar, "AXValue"), frame(&bar)) else { return Ok(false) };
    let knob = attr(&bar, "AXChildren").map(list).unwrap_or_default().into_iter().find(|c| has_role(c, &["AXValueIndicator"]));
    let Some(knob) = knob.and_then(|k| frame(&k)) else { return Ok(false) };
    let vertical = matches!(direction, Direction::Up | Direction::Down);
    let shown = if vertical { knob.h / track.h } else { knob.w / track.w };
    if !(shown > 0.0 && shown < 1.0) {
        return Ok(false);
    }
    let target = (value + sign * pages.min(20.0) * 0.85 * shown / (1.0 - shown)).clamp(0.0, 1.0);
    if (target - value).abs() < 1e-6 {
        return Ok(true);
    }
    active()?;
    let status = set_attr(&bar, "AXValue", &CFNumber::from(target).as_CFType());
    if status == 0 {
        Ok(true)
    } else {
        Err(fail(ErrorCode::ActionFailed, format!("setting the scroll position failed (AXError {status})")))
    }
}

pub(super) fn set_value(pid: i32, e: &El, index: u32, value: &str, submit: Option<bool>) -> Result<(), Failure> {
    if !settable(e, "AXValue") {
        return Err(fail(
            ErrorCode::ActionFailed,
            format!("element {index}'s value cannot be set; click it and use typeText or paste, or use its controls"),
        ));
    }
    let before = attr(e, "AXValue");
    let bad = |kind: &str| fail(ErrorCode::ActionFailed, format!("element {index} holds a {kind}, and {value:?} is not one"));
    let new = match &before {
        Some(v) if v.downcast::<CFBoolean>().is_some() => {
            CFBoolean::from(text::flag(value).ok_or_else(|| bad("true/false value"))?).as_CFType()
        }
        Some(v) if v.downcast::<CFNumber>().is_some() => {
            let n = text::number(value).ok_or_else(|| bad("number"))?;
            if n.fract() == 0.0 && n.abs() < 9e15 {
                CFNumber::from(n as i64).as_CFType()
            } else {
                CFNumber::from(n).as_CFType()
            }
        }
        Some(v) if v.downcast::<core_foundation::date::CFDate>().is_some() => {
            return Err(fail(ErrorCode::ActionFailed, format!("element {index} holds a date; type it or use its controls")))
        }
        _ => cfs(value).as_CFType(),
    };
    let texty = has_role(e, TEXT_ROLES);
    if texty {
        let status = set_attr(e, "AXFocused", &CFBoolean::true_value().as_CFType());
        if status != 0 {
            return Err(fail(
                ErrorCode::ActionFailed,
                format!("focusing element {index} failed (AXError {status}); its value was not changed"),
            ));
        }
    }
    match set_attr(e, "AXValue", &new) {
        0 => {}
        n => return Err(fail(ErrorCode::ActionFailed, format!("setting element {index}'s value failed (AXError {n})"))),
    }
    let old = before.as_ref().and_then(text_of);
    let now = attr(e, "AXValue").as_ref().and_then(text_of);
    if texty && now.as_deref() != Some(value) && now.is_some() && now == old {
        return Err(fail(
            ErrorCode::ActionFailed,
            format!(
                "element {index} did not take the value (it still reads {:?}); click it and use typeText or paste",
                clip(&now.unwrap_or_default(), 80)
            ),
        ));
    }
    let search = str_attr(e, "AXSubrole").as_deref() == Some("AXSearchField");
    if submit.unwrap_or(search) {
        if actions(e).iter().any(|a| a == "AXConfirm") {
            perform(e, "AXConfirm")?;
        } else {
            let target = pid_of(e).unwrap_or(pid);
            key(target, chord("return")?.0, CGEventFlags::empty(), None, 0)?;
        }
    }
    Ok(())
}
