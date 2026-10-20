use super::*;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXTextMarkerGetTypeID() -> usize;
    fn AXTextMarkerRangeGetTypeID() -> usize;
    fn AXTextMarkerRangeCreate(allocator: CFTypeRef, start: CFTypeRef, end: CFTypeRef) -> CFTypeRef;
}

pub(super) enum Read {
    Text { range: El, raw: String, attributed: CFAttributedString },
    Omitted(usize),
}

fn parameter(e: &El, name: &str, argument: &El) -> Option<CFType> {
    if cancellation::cancelled() {
        return None;
    }
    let mut value = std::ptr::null();
    let status = unsafe {
        AXUIElementCopyParameterizedAttributeValue(e.as_CFTypeRef(), cfs(name).as_concrete_TypeRef(), argument.as_CFTypeRef(), &mut value)
    };
    if value.is_null() {
        return None;
    }
    let value = unsafe { CFType::wrap_under_create_rule(value) };
    (status == 0).then_some(value)
}

fn bounded(range: El, mut query: impl FnMut(&str, &El) -> Option<CFType>) -> Option<Read> {
    if range.type_of() != unsafe { AXTextMarkerRangeGetTypeID() } || cancellation::cancelled() {
        return None;
    }
    let length = query("AXLengthForTextMarkerRange", &range)?.downcast::<CFNumber>()?.to_i64()?;
    let length = usize::try_from(length).ok().filter(|length| *length > 0)?;
    if length > tree::MAX_TEXT {
        return Some(Read::Omitted(length));
    }
    if cancellation::cancelled() {
        return None;
    }
    let attributed = query("AXAttributedStringForTextMarkerRange", &range)?.downcast::<CFAttributedString>()?;
    if usize::try_from(attributed.char_len()).ok()? != length {
        return None;
    }
    let raw = unsafe { CFString::wrap_under_get_rule(CFAttributedStringGetString(attributed.as_concrete_TypeRef())) }.to_string();
    Some(Read::Text { range, raw, attributed })
}

fn attribute(e: &El, name: &str) -> Option<El> {
    if cancellation::cancelled() {
        None
    } else {
        attr(e, name)
    }
}

pub(super) fn read(e: &El) -> Option<Read> {
    let start = attribute(e, "AXStartTextMarker")?;
    let end = attribute(e, "AXEndTextMarker")?;
    let marker_type = unsafe { AXTextMarkerGetTypeID() };
    if start.type_of() != marker_type || end.type_of() != marker_type {
        return None;
    }
    let range = unsafe { AXTextMarkerRangeCreate(std::ptr::null(), start.as_CFTypeRef(), end.as_CFTypeRef()) };
    if range.is_null() {
        return None;
    }
    let result = bounded(unsafe { CFType::wrap_under_create_rule(range) }, |name, range| parameter(e, name, range))?;
    if cancellation::cancelled()
        || attribute(e, "AXStartTextMarker").as_ref() != Some(&start)
        || attribute(e, "AXEndTextMarker").as_ref() != Some(&end)
    {
        return None;
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    extern "C" {
        fn AXTextMarkerCreate(allocator: CFTypeRef, bytes: *const u8, length: isize) -> CFTypeRef;
    }

    fn range() -> El {
        let start = unsafe { CFType::wrap_under_create_rule(AXTextMarkerCreate(std::ptr::null(), b"a".as_ptr(), 1)) };
        let end = unsafe { CFType::wrap_under_create_rule(AXTextMarkerCreate(std::ptr::null(), b"b".as_ptr(), 1)) };
        unsafe { CFType::wrap_under_create_rule(AXTextMarkerRangeCreate(std::ptr::null(), start.as_CFTypeRef(), end.as_CFTypeRef())) }
    }

    #[test]
    fn marker_observation_never_reads_unbounded_ranges() {
        for length in [-1, 0, 1001, i64::MAX] {
            let mut calls = vec![];
            let result = bounded(range(), |name, _| {
                calls.push(name.to_string());
                Some(CFNumber::from(length).as_CFType())
            });
            assert_eq!(calls, ["AXLengthForTextMarkerRange"]);
            assert_eq!(matches!(result, Some(Read::Omitted(_))), length > 1000);
        }
    }

    #[test]
    fn marker_observation_retains_exact_text_and_opaque_range() {
        let range = range();
        let result = bounded(range.clone(), |name, _| match name {
            "AXLengthForTextMarkerRange" => Some(CFNumber::from(5).as_CFType()),
            "AXAttributedStringForTextMarkerRange" => Some(CFAttributedString::new(&cfs(" 😀x ")).as_CFType()),
            _ => None,
        });
        let Some(Read::Text { range: retained, raw, .. }) = result else { panic!() };
        assert_eq!(retained, range);
        assert_eq!(raw, " 😀x ");
        assert!(bounded(range, |name, _| match name {
            "AXLengthForTextMarkerRange" => Some(CFNumber::from(4).as_CFType()),
            _ => Some(CFAttributedString::new(&cfs("changed")).as_CFType()),
        })
        .is_none());
    }
}
