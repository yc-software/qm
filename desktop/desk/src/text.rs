use crate::protocol::{PasteFormat, Selection};
use std::collections::HashMap;

const KEYPAD: &[u16] = &[65, 67, 69, 71, 75, 76, 78, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stroke {
    pub code: u16,
    pub shift: bool,
    pub option: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    Return,
    Tab,
    Mapped(char, Stroke),
    Unicode(char),
}

pub fn layout(translate: impl Fn(u16, bool, bool) -> Option<char>) -> HashMap<char, Stroke> {
    let mut map = HashMap::new();
    for (shift, option) in [(false, false), (true, false), (false, true), (true, true)] {
        for code in 0..128u16 {
            if KEYPAD.contains(&code) {
                continue;
            }
            if let Some(c) = translate(code, shift, option).filter(|c| !c.is_control() && !('\u{f700}'..='\u{f8ff}').contains(c)) {
                map.entry(c).or_insert(Stroke { code, shift, option });
            }
        }
    }
    map
}

pub fn plan(text: &str, layout: &HashMap<char, Stroke>) -> Vec<Key> {
    let mut keys = vec![];
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        keys.push(match c {
            '\r' => {
                chars.next_if_eq(&'\n');
                Key::Return
            }
            '\n' => Key::Return,
            '\t' => Key::Tab,
            c => layout.get(&c).map_or(Key::Unicode(c), |s| Key::Mapped(c, *s)),
        });
    }
    keys
}

pub fn payload(text: &str, format: PasteFormat) -> (String, Option<String>) {
    match format {
        PasteFormat::Text => (text.to_string(), None),
        PasteFormat::Markdown => {
            let mut html = String::from("<meta charset=\"utf-8\">");
            pulldown_cmark::html::push_html(&mut html, pulldown_cmark::Parser::new_ext(text, pulldown_cmark::Options::all()));
            (text.to_string(), Some(html))
        }
        PasteFormat::Html => (strip_html(text), Some(format!("<meta charset=\"utf-8\">{text}"))),
    }
}

pub fn flag(s: &str) -> Option<bool> {
    match s.trim().to_ascii_lowercase().as_str() {
        "true" | "yes" | "on" | "1" | "checked" => Some(true),
        "false" | "no" | "off" | "0" | "unchecked" => Some(false),
        _ => None,
    }
}

pub fn number(s: &str) -> Option<f64> {
    s.trim().parse::<f64>().ok().filter(|n| n.is_finite()).or_else(|| flag(s).map(|b| if b { 1.0 } else { 0.0 }))
}

pub fn expected(text: &str, format: PasteFormat) -> Vec<String> {
    let (plain, html) = payload(text, format);
    let rendered = html.map(|h| strip_html(&h)).filter(|r| *r != plain);
    std::iter::once(plain).chain(rendered).collect()
}

fn norm(s: &[u16]) -> String {
    String::from_utf16_lossy(s).replace("\r\n", "\n").replace(['\r', '\u{2028}', '\u{2029}'], "\n").replace('\u{a0}', " ")
}

fn insertion(before: &[char], pasted: &[char], after: &[char]) -> bool {
    if after.len() != before.len() + pasted.len() {
        return false;
    }
    let common = before.iter().zip(after).take_while(|(x, y)| x == y).count();
    (common.saturating_sub(pasted.len())..=common)
        .any(|i| after[..i] == before[..i] && after[i..i + pasted.len()] == *pasted && after[i + pasted.len()..] == before[i..])
}

pub fn inserted(before: &str, selection: Option<(usize, usize)>, after: &str, pasted: &str) -> bool {
    let b: Vec<u16> = before.encode_utf16().collect();
    let after = norm(&after.encode_utf16().collect::<Vec<_>>());
    let pasted = norm(&pasted.encode_utf16().collect::<Vec<_>>());
    if pasted.is_empty() || norm(&b) == after {
        return false;
    }
    match selection {
        Some((start, len)) if start + len <= b.len() => format!("{}{pasted}{}", norm(&b[..start]), norm(&b[start + len..])) == after,
        Some(_) => false,
        None => {
            let chars = |s: &str| s.chars().collect::<Vec<_>>();
            insertion(&chars(&norm(&b)), &chars(&pasted), &chars(&after))
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct VisibleText {
    pub text: String,
    pub start: usize,
    pub end: usize,
    pub shown_end: usize,
    pub total: usize,
}

pub fn visible_text(value: &str, range: [isize; 2], limit: usize) -> Option<VisibleText> {
    let start = usize::try_from(range[0]).ok()?;
    let end = start.checked_add(usize::try_from(range[1]).ok()?)?;
    let mut offset = 0;
    let mut start_byte = None;
    let mut end_byte = None;
    for (byte, c) in value.char_indices().chain(std::iter::once((value.len(), '\0'))) {
        if offset == start {
            start_byte = Some(byte);
        }
        if offset == end {
            end_byte = Some(byte);
        }
        if byte < value.len() {
            offset += c.len_utf16();
        }
    }
    let text: String = value[start_byte?..end_byte?].chars().take(limit).collect();
    let shown_end = start + text.encode_utf16().count();
    Some(VisibleText { text, start, end, shown_end, total: offset })
}

pub fn selection_range(value: &str, text: &str, prefix: &str, suffix: &str, selection: Selection) -> Result<[isize; 2], &'static str> {
    if text.is_empty() {
        return Err("Selection text must not be empty");
    }
    let mut matches = value
        .char_indices()
        .map(|(i, _)| i)
        .filter(|&i| value[i..].starts_with(text) && value[..i].ends_with(prefix) && value[i + text.len()..].starts_with(suffix));
    let at = matches.next().ok_or("The requested text and context were not found in the element's value")?;
    if matches.next().is_some() {
        return Err("The requested text matches more than once; provide prefix or suffix to identify one occurrence");
    }
    let start = value[..at].encode_utf16().count() as isize;
    let len = text.encode_utf16().count() as isize;
    Ok(match selection {
        Selection::Text => [start, len],
        Selection::CursorBefore => [start, 0],
        Selection::CursorAfter => [start + len, 0],
    })
}

fn strip_html(html: &str) -> String {
    html2text::config::plain_no_decorate()
        .string_from_read(html.as_bytes(), usize::MAX / 2)
        .map(|t| t.trim().to_string())
        .unwrap_or_else(|_| html.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn us(code: u16, shift: bool, option: bool) -> Option<char> {
        let base = match code {
            0 => 'a',
            9 => 'v',
            18 => '1',
            29 => '0',
            24 => '=',
            49 => ' ',
            83 => '1',
            14 if option => return None,
            14 => 'e',
            _ => return None,
        };
        Some(match (base, shift, option) {
            ('1', true, false) => '!',
            ('=', true, false) => '+',
            ('a', false, true) => 'å',
            ('a', true, true) => 'Å',
            (c, true, false) => c.to_ascii_uppercase(),
            (c, _, _) => c,
        })
    }

    #[test]
    fn layout_prefers_fewest_modifiers_and_main_keys() {
        let map = layout(us);
        assert_eq!(map[&'a'], Stroke { code: 0, shift: false, option: false });
        assert_eq!(map[&'A'], Stroke { code: 0, shift: true, option: false });
        assert_eq!(map[&'!'], Stroke { code: 18, shift: true, option: false });
        assert_eq!(map[&'å'], Stroke { code: 0, shift: false, option: true });
        assert_eq!(map[&'1'].code, 18, "the main-row 1, not the keypad 1");
        assert_eq!(map[&'+'], Stroke { code: 24, shift: true, option: false });
        assert!(!map.values().any(|s| s.code == 14 && s.option), "dead keys are never used");
    }

    #[test]
    fn plan_uses_real_keys_and_presses_return_and_tab() {
        let map = layout(us);
        let keys = plan("Ab\tA\r\n!\n😀", &map);
        assert_eq!(
            keys,
            vec![
                Key::Mapped('A', Stroke { code: 0, shift: true, option: false }),
                Key::Unicode('b'),
                Key::Tab,
                Key::Mapped('A', Stroke { code: 0, shift: true, option: false }),
                Key::Return,
                Key::Mapped('!', Stroke { code: 18, shift: true, option: false }),
                Key::Return,
                Key::Unicode('😀'),
            ]
        );
        assert_eq!(plan("a\r\rb", &map).iter().filter(|k| **k == Key::Return).count(), 2);
        assert_eq!(plan("x", &HashMap::new()), vec![Key::Unicode('x')], "an unreadable layout falls back to text");
    }

    #[test]
    fn payload_formats() {
        assert_eq!(payload("a\nb", PasteFormat::Text), ("a\nb".into(), None));
        let (plain, html) = payload("**hi** there", PasteFormat::Markdown);
        assert_eq!(plain, "**hi** there");
        assert!(html.unwrap().contains("<strong>hi</strong> there"));
        let (plain, html) = payload("<p>One &amp; <b>two</b></p><p>three<br>four</p>", PasteFormat::Html);
        assert_eq!(plain, "One & two\n\nthree\nfour");
        assert!(html.unwrap().ends_with("<p>One &amp; <b>two</b></p><p>three<br>four</p>"));
    }

    #[test]
    fn paste_format_defaults_to_text() {
        let a: crate::protocol::Action = serde_json::from_str(r#"{"type":"paste","text":"x"}"#).unwrap();
        assert!(matches!(a, crate::protocol::Action::Paste { format: PasteFormat::Text, .. }));
    }
    #[test]
    fn insertion_must_match_the_pasted_text_at_the_selection() {
        assert!(inserted("ab", Some((1, 0)), "aXYb", "XY"));
        assert!(inserted("a old b", Some((2, 3)), "a new b", "new"), "replaces the selection");
        assert!(inserted("ab", None, "aXYb", "XY"), "unknown selection: anywhere");
        assert!(inserted("", Some((0, 0)), "line1\rline2", "line1\nline2"), "line endings normalised");
        assert!(inserted("a", Some((1, 0)), "a ", " "), "a whitespace paste");
        assert!(!inserted("x", Some((1, 0)), "x one\n two", "one two"), "whitespace must match");
        assert!(!inserted("ab", Some((1, 0)), "ab", "XY"), "nothing changed");
        assert!(!inserted("ab", Some((1, 0)), "aZb", "XY"), "something else changed");
        assert!(!inserted("ab", Some((0, 0)), "aXYb", "XY"), "inserted at the wrong place");
        assert!(!inserted("aXb", Some((1, 1)), "aXb", "X"), "replacing a selection with itself is no evidence");
        assert!(!inserted("ab", None, "aXYbZ", "XY"), "unknown selection still needs nothing else to change");
        assert!(!inserted("ab", Some((5, 0)), "aXYb", "XY"), "stale selection");
        assert!(!inserted("ab", Some((1, 0)), "ab", ""), "nothing expected");
        assert!(inserted("é", Some((1, 0)), "é😀", "😀"), "UTF-16 offsets");
        assert_eq!(expected("**hi** there", PasteFormat::Markdown), vec!["**hi** there".to_string(), "hi there".to_string()]);
        assert_eq!(expected("plain", PasteFormat::Text), vec!["plain".to_string()]);
    }

    #[test]
    fn selection_requires_unique_context_including_overlapping_matches() {
        assert!(selection_range("aaa", "aa", "", "", Selection::Text).is_err());
        assert_eq!(selection_range("aaa", "aa", "a", "", Selection::Text), Ok([1, 2]));
        assert_eq!(selection_range("one cat; two cat!", "cat", "two ", "!", Selection::Text), Ok([13, 3]));
        assert!(selection_range("one cat", "cat", "two ", "", Selection::Text).is_err());
    }

    #[test]
    fn selection_and_carets_use_utf16_offsets() {
        let value = "é😀a界!";
        assert_eq!(selection_range(value, "a界", "😀", "!", Selection::Text), Ok([3, 2]));
        assert_eq!(selection_range(value, "a界", "", "", Selection::CursorBefore), Ok([3, 0]));
        assert_eq!(selection_range(value, "a界", "", "", Selection::CursorAfter), Ok([5, 0]));
        assert_eq!(selection_range(value, "😀", "", "", Selection::Text), Ok([1, 2]));
        assert!(selection_range(value, "", "", "", Selection::CursorAfter).is_err());
        assert!(selection_range(value, "", "!", "", Selection::CursorAfter).is_err());
    }

    #[test]
    fn set_value_conversions() {
        assert_eq!(flag(" Yes "), Some(true));
        assert_eq!(flag("0"), Some(false));
        assert_eq!(flag("maybe"), None);
        assert_eq!(number("2.5"), Some(2.5));
        assert_eq!(number("true"), Some(1.0));
        assert_eq!(number("NaN"), None);
        assert_eq!(number("ten"), None);
    }
}
