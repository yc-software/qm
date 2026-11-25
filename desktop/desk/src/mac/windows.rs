use super::*;

pub(super) fn all(ax: &El) -> Vec<(El, u32, Option<u32>)> {
    let mut out: Vec<(El, u32, Option<u32>)> = vec![];
    let tops =
        attr(ax, "AXWindows").map(list).unwrap_or_default().into_iter().chain(attr(ax, "AXFocusedWindow")).chain(attr(ax, "AXMainWindow"));
    for w in tops {
        let id = window_id(&w);
        if id == 0 || out.iter().any(|(_, seen, _)| *seen == id) {
            continue;
        }
        let sheets = attr(&w, "AXSheets").map(list).unwrap_or_default();
        out.push((w, id, None));
        for sheet in sheets {
            let sheet_id = window_id(&sheet);
            if sheet_id != 0 && !out.iter().any(|(_, seen, _)| *seen == sheet_id) {
                out.push((sheet, sheet_id, Some(id)));
            }
        }
    }
    out
}

pub(super) fn titles(ax: &El) -> Result<Vec<String>, Failure> {
    let unreadable = |what: &str, status: i32| fail(ErrorCode::ActionFailed, format!("reading the app's {what} failed (AXError {status})"));
    let windows = match attr_status(ax, "AXWindows") {
        Ok(windows) => list(windows),
        Err(NO_VALUE) => vec![],
        Err(status) => return Err(unreadable("windows", status)),
    };
    let mut out = vec![];
    for w in windows {
        let sheets = match attr_status(&w, "AXSheets") {
            Ok(sheets) => list(sheets),
            Err(NO_VALUE | ATTRIBUTE_UNSUPPORTED | INVALID_ELEMENT) => vec![],
            Err(status) => return Err(unreadable("sheets", status)),
        };
        for e in std::iter::once(w).chain(sheets) {
            if bool_attr(&e, "AXMinimized") == Some(true) {
                continue;
            }
            match attr_status(&e, "AXTitle") {
                Ok(title) => out.extend(text_of(&title)),
                Err(NO_VALUE | ATTRIBUTE_UNSUPPORTED | INVALID_ELEMENT) => {}
                Err(status) => return Err(unreadable("window titles", status)),
            }
        }
    }
    Ok(out)
}

pub(super) fn reply(query: &str) -> Result<Reply, Failure> {
    let app = resolve(query, |a| {
        if all(&app_element(a.pid)).is_empty() {
            Err(fail(ErrorCode::NoWindow, format!("{} has no open window", a.name)))
        } else {
            Ok(())
        }
    })?;
    let ax = app_element(app.pid);
    unsafe { AXUIElementSetMessagingTimeout(ax.as_CFTypeRef(), 1.5) };
    let focused = attr(&ax, "AXFocusedWindow").map(|w| window_id(&w));
    let main = attr(&ax, "AXMainWindow").map(|w| window_id(&w));
    let windows = all(&ax)
        .into_iter()
        .map(|(w, id, parent)| WindowInfo {
            id,
            title: str_attr(&w, "AXTitle").unwrap_or_default(),
            role: str_attr(&w, "AXRole").unwrap_or_default(),
            subrole: str_attr(&w, "AXSubrole"),
            frame: frame(&w),
            focused: focused == Some(id),
            main: main == Some(id),
            minimized: bool_attr(&w, "AXMinimized") == Some(true),
            parent,
        })
        .collect();
    Ok(Reply::Windows { windows })
}
