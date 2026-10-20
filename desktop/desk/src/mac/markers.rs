use super::*;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXTextMarkerRangeGetTypeID() -> usize;
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
    ax_result(status, value)
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

fn read_element(e: &El, mut query: impl FnMut(&str, &El) -> Option<CFType>) -> Option<Read> {
    if cancellation::cancelled() {
        return None;
    }
    let range = query("AXTextMarkerRangeForUIElement", e)?;
    let result = bounded(range.clone(), &mut query)?;
    if cancellation::cancelled() || query("AXTextMarkerRangeForUIElement", e).as_ref() != Some(&range) {
        return None;
    }
    Some(result)
}

pub(super) fn read(e: &El) -> Option<Read> {
    read_element(e, |name, argument| parameter(e, name, argument))
}

#[cfg(test)]
mod tests {
    use super::*;

    extern "C" {
        fn AXTextMarkerRangeCreate(allocator: CFTypeRef, start: CFTypeRef, end: CFTypeRef) -> CFTypeRef;
        fn AXTextMarkerCreate(allocator: CFTypeRef, bytes: *const u8, length: isize) -> CFTypeRef;
    }

    fn range() -> El {
        range_ending_at(b"b")
    }

    fn range_ending_at(bytes: &[u8]) -> El {
        let start = unsafe { CFType::wrap_under_create_rule(AXTextMarkerCreate(std::ptr::null(), b"a".as_ptr(), 1)) };
        let end = unsafe { CFType::wrap_under_create_rule(AXTextMarkerCreate(std::ptr::null(), bytes.as_ptr(), bytes.len() as isize)) };
        unsafe { CFType::wrap_under_create_rule(AXTextMarkerRangeCreate(std::ptr::null(), start.as_CFTypeRef(), end.as_CFTypeRef())) }
    }

    #[test]
    fn marker_observation_uses_exact_element_range_and_rechecks_it() {
        let element = cfs("leaf").as_CFType();
        let expected_range = range();
        assert_eq!(expected_range, range());
        let mut calls = vec![];
        let result = read_element(&element, |name, argument| {
            calls.push(name.to_string());
            match name {
                "AXTextMarkerRangeForUIElement" => {
                    assert_eq!(argument, &element);
                    Some(range())
                }
                "AXLengthForTextMarkerRange" => {
                    assert_eq!(argument, &expected_range);
                    Some(CFNumber::from(4).as_CFType())
                }
                "AXAttributedStringForTextMarkerRange" => {
                    assert_eq!(argument, &expected_range);
                    Some(CFAttributedString::new(&cfs("leaf")).as_CFType())
                }
                _ => panic!("unexpected range query"),
            }
        });
        assert!(matches!(result, Some(Read::Text { raw, .. }) if raw == "leaf"));
        assert_eq!(
            calls,
            [
                "AXTextMarkerRangeForUIElement",
                "AXLengthForTextMarkerRange",
                "AXAttributedStringForTextMarkerRange",
                "AXTextMarkerRangeForUIElement"
            ]
        );
        let mut range_reads = 0;
        assert!(read_element(&element, |name, _| match name {
            "AXTextMarkerRangeForUIElement" => {
                range_reads += 1;
                Some(if range_reads == 1 { range() } else { range_ending_at(b"c") })
            }
            "AXLengthForTextMarkerRange" => Some(CFNumber::from(4).as_CFType()),
            _ => Some(CFAttributedString::new(&cfs("leaf")).as_CFType()),
        })
        .is_none());
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
