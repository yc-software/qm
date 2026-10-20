use super::*;
use crate::tree::clip;
use core_graphics::window::{create_description_from_array, kCGWindowBounds, kCGWindowOwnerPID};

const MENU_ITEMS: &[&str] = &["AXMenuItem", "AXMenuBarItem"];
const SELECTS: &[&str] = &["AXRow", "AXCell", "AXOutlineRow", "AXListItem"];
const TEXT_ROLES: &[&str] = &["AXTextField", "AXTextArea", "AXComboBox"];

fn element_at(root: &El, p: CGPoint) -> Option<El> {
    let mut v: CFTypeRef = std::ptr::null();
    let status = unsafe { AXUIElementCopyElementAtPosition(root.as_CFTypeRef(), p.x as f32, p.y as f32, &mut v) };
    ax_result(status, v)
}

pub(super) fn within(e: &El, ancestor: &El) -> bool {
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

fn clickable_point<T>(
    visible: Rect,
    mut hit: impl FnMut(CGPoint) -> Option<T>,
    mut is_target: impl FnMut(&T) -> bool,
) -> Result<CGPoint, Option<T>> {
    let mut obstruction = None;
    for (fx, fy) in [(0.5, 0.5), (0.25, 0.5), (0.75, 0.5), (0.5, 0.25), (0.5, 0.75)] {
        let p = pt(visible.x + visible.w * fx, visible.y + visible.h * fy);
        if let Some(element) = hit(p) {
            if is_target(&element) {
                return Ok(p);
            }
            obstruction.get_or_insert(element);
        }
    }
    Err(obstruction)
}

pub(super) fn clickable(ax: &El, e: &El, index: u32, visible: Rect) -> Result<CGPoint, Failure> {
    clickable_point(visible, |p| element_at(ax, p), |hit| within(hit, e)).map_err(|hit| {
        let detail = hit.map(|element| format!("; hit testing found {} instead", describe(&element))).unwrap_or_default();
        fail(ErrorCode::ActionFailed, format!("Cannot verify a clickable point for element {index}{detail}; reveal it and observe again"))
    })
}

pub(super) fn window_geometry(id: u32) -> Option<(i32, Rect)> {
    if id == 0 {
        return None;
    }
    let windows = create_description_from_array(CFArray::from_copyable(&[id]))?;
    let window = windows.get(0)?;
    let owner = window.find(unsafe { CFString::wrap_under_get_rule(kCGWindowOwnerPID) })?.downcast::<CFNumber>()?.to_i64()?;
    let owner = i32::try_from(owner).ok().filter(|pid| *pid > 0)?;
    let bounds = window.find(unsafe { CFString::wrap_under_get_rule(kCGWindowBounds) })?.downcast::<CFDictionary>()?;
    let bounds = core_graphics::geometry::CGRect::from_dict_representation(&bounds)?;
    Some((owner, Rect { x: bounds.origin.x, y: bounds.origin.y, w: bounds.size.width, h: bounds.size.height }))
}

pub(super) fn resolved_window(host: &El, element: &El) -> Result<(i32, u32, Rect), Failure> {
    if !within(element, host) {
        return Err(fail(ErrorCode::ActionFailed, "The input target is no longer linked to this app; observe again"));
    }
    let id = window_id(element);
    let (owner, bounds) =
        window_geometry(id).ok_or_else(|| fail(ErrorCode::NoWindow, "Input window ownership is unavailable; observe again"))?;
    Ok((owner, id, bounds))
}

pub(super) fn register_target(host: &El, element: &El) -> Result<i32, Failure> {
    let (owner, _, _) = resolved_window(host, element)?;
    crate::intervention::include_target(owner);
    active()?;
    Ok(owner)
}

pub(super) fn register_action_target(host: &El, element: &El) -> Result<(), Failure> {
    if window_id(element) == 0 && is_menu_item(element) && within(element, host) {
        if let Some(owner) = pid_of(host).filter(|owner| pid_of(element) == Some(*owner)) {
            crate::intervention::include_target(owner);
            return active();
        }
    }
    register_target(host, element).map(|_| ())
}

fn inside(inner: Rect, outer: Rect) -> bool {
    const SLACK: f64 = 4.0;
    inner.x >= outer.x - SLACK
        && inner.y >= outer.y - SLACK
        && inner.x + inner.w <= outer.x + outer.w + SLACK
        && inner.y + inner.h <= outer.y + outer.h + SLACK
}

pub(super) fn service_at(ax: &El, p: CGPoint) -> Result<(i32, El, u32, Rect), Failure> {
    let element = element_at(ax, p).ok_or_else(|| fail(ErrorCode::ActionFailed, "Cannot identify the input target; observe again"))?;
    let (owner, id, bounds) = resolved_window(ax, &element)?;
    Ok((owner, element, id, bounds))
}

pub(super) fn related_windows(pid: i32, window: &El, outer: Rect, extras: &[El]) -> Vec<u32> {
    let own = window_id(window);
    let mut found = vec![];
    let mut visited = 0;
    for (root, contained) in extras.iter().map(|root| (root, false)).chain(std::iter::once((window, true))) {
        let mut checked = HashSet::from([own]);
        let mut queue = std::collections::VecDeque::from([(root.clone(), 0)]);
        while let Some((element, depth)) = queue.pop_front() {
            visited += 1;
            if visited > 400 || cancellation::cancelled() {
                return found;
            }
            let id = window_id(&element);
            if !found.contains(&id) && checked.insert(id) {
                if let Ok((owner, id, bounds)) = resolved_window(root, &element) {
                    if !contained || (owner != pid && inside(bounds, outer)) {
                        found.push(id);
                    }
                }
            }
            if depth < MAX_DEPTH {
                queue.extend(attr(&element, "AXChildren").map(list).unwrap_or_default().into_iter().map(|child| (child, depth + 1)));
            }
        }
    }
    found
}

pub(super) fn keyboard_target(ax: &El) -> Result<(i32, El), Failure> {
    let focused = attr(ax, "AXFocusedUIElement")
        .or_else(|| window_of(ax))
        .ok_or_else(|| fail(ErrorCode::NoWindow, "Cannot identify the keyboard target; observe again"))?;
    Ok((register_target(ax, &focused)?, ax.clone()))
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

pub(super) fn scroll_pixels(amount: Amount, direction: Direction, viewport: Option<Rect>, fallback: Rect) -> i32 {
    let view = viewport.unwrap_or(fallback);
    match amount {
        Amount::Pixels(n) => n as i32,
        Amount::Pages(n) => {
            let extent = if matches!(direction, Direction::Up | Direction::Down) { view.h } else { view.w };
            (n.clamp(0.0, 20.0) * 0.85 * extent) as i32
        }
    }
}

pub(super) fn scroll_pages(host: &El, area: &El, direction: Direction, pages: f64) -> Result<bool, Failure> {
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
            perform(host, area, action)?;
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
    register_target(host, &bar)?;
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
    let host = app_element(pid);
    let texty = has_role(e, TEXT_ROLES);
    let require_focus = || {
        if bool_attr(e, "AXFocused") == Some(true) {
            Ok(())
        } else {
            Err(fail(ErrorCode::ActionFailed, format!("element {index} does not have keyboard focus; observe it before continuing")))
        }
    };
    register_target(&host, e)?;
    if texty {
        let status = set_attr(e, "AXFocused", &CFBoolean::true_value().as_CFType());
        if status != 0 {
            return Err(fail(
                ErrorCode::ActionFailed,
                format!("focusing element {index} failed (AXError {status}); its value was not changed"),
            ));
        }
        require_focus()?;
    }
    active()?;
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
    if submit == Some(true) {
        if actions(e).iter().any(|a| a == "AXConfirm") {
            perform(&host, e, "AXConfirm")?;
        } else {
            let target = register_target(&host, e)?;
            require_focus()?;
            key(target, chord("return")?.0, CGEventFlags::empty(), None, 0)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_click_requires_a_positive_target_hit() {
        let rect = Rect { x: 10.0, y: 20.0, w: 100.0, h: 80.0 };
        for hits in [vec![None; 5], vec![Some("ancestor"); 5], vec![None, Some("cover"), Some("ancestor"), None, Some("cover")]] {
            let mut hits = hits.into_iter();
            assert!(clickable_point(rect, |_| hits.next().flatten(), |hit| *hit == "target" || *hit == "descendant").is_err());
        }
        let mut hits = [Some("cover"), None, Some("descendant")].into_iter();
        let descendant = clickable_point(rect, |_| hits.next().flatten(), |hit| *hit == "target" || *hit == "descendant").unwrap();
        assert_eq!((descendant.x, descendant.y), (85.0, 60.0));
        let target = clickable_point(rect, |_| Some("target"), |hit| *hit == "target").unwrap();
        assert_eq!((target.x, target.y), (60.0, 60.0));
    }

    #[test]
    fn page_wheel_fallback_uses_the_scroll_pane_viewport() {
        let pane = Rect { x: 0.0, y: 0.0, w: 200.0, h: 400.0 };
        let row = Rect { x: 0.0, y: 0.0, w: 150.0, h: 20.0 };
        let window = Rect { x: 0.0, y: 0.0, w: 800.0, h: 1000.0 };
        assert_eq!(scroll_pixels(Amount::Pages(1.0), Direction::Down, Some(pane), row), 340);
        assert_eq!(scroll_pixels(Amount::Pages(0.5), Direction::Right, Some(pane), window), 85);
        assert_eq!(scroll_pixels(Amount::Pages(0.5), Direction::Up, None, window), 425);
        assert_eq!(scroll_pixels(Amount::Pixels(17), Direction::Down, Some(pane), row), 17);
    }
}
