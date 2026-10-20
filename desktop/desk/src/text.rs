use crate::protocol::{PasteFormat, Selection};
use sha2::{Digest, Sha256};
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

fn insertion(before: &str, pasted: &str, after: &str) -> bool {
    if after.len() != before.len() + pasted.len() {
        return false;
    }
    let prefix = before.bytes().zip(after.bytes()).take_while(|(x, y)| x == y).count();
    let suffix = before.bytes().rev().zip(after.bytes().rev()).take_while(|(x, y)| x == y).count();
    let mut start = before.len() - suffix;
    while start <= prefix && !after.is_char_boundary(start) {
        start += 1;
    }
    start <= prefix && after[start..].find(pasted).is_some_and(|offset| start + offset <= prefix)
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
        None => insertion(&norm(&b), &pasted, &after),
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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TextStyle {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub link: Option<String>,
    pub list_prefix: Option<String>,
    pub list_level: usize,
}

#[derive(Debug, Clone, Default)]
pub struct RenderedText {
    pub markdown: String,
    spans: Vec<(std::ops::Range<usize>, Option<std::ops::Range<usize>>)>,
}

impl RenderedText {
    pub fn retained_bytes(&self) -> usize {
        self.markdown.capacity() * 2
            + self.spans.capacity() * std::mem::size_of::<(std::ops::Range<usize>, Option<std::ops::Range<usize>>)>()
            + 2 * std::mem::size_of::<ObservedText>()
    }

    pub fn syntax(&mut self, value: &str) {
        if !value.is_empty() {
            let start = self.markdown.len();
            self.markdown.push_str(value);
            self.spans.push((start..self.markdown.len(), None));
        }
    }

    fn native(&mut self, value: &str, escaped: bool, at: &mut usize) {
        for c in value.chars() {
            let start = self.markdown.len();
            if escaped && c.is_ascii_punctuation() {
                self.markdown.push('\\');
            }
            self.markdown.push(c);
            let end = *at + c.len_utf16();
            self.spans.push((start..self.markdown.len(), Some(*at..end)));
            *at = end;
        }
    }

    fn append(&mut self, other: Self) {
        let offset = self.markdown.len();
        self.markdown += &other.markdown;
        self.spans.extend(other.spans.into_iter().map(|(range, native)| (range.start + offset..range.end + offset, native)));
    }

    fn wrap(self, open: &str, close: &str) -> Self {
        let mut result = Self::default();
        result.syntax(open);
        result.append(self);
        result.syntax(close);
        result
    }

    pub fn offset(&mut self, offset: usize) {
        for (_, native) in &mut self.spans {
            if let Some(native) = native {
                native.start += offset;
                native.end += offset;
            }
        }
    }

    fn native_range(&self, start: usize, end: usize) -> Option<[isize; 2]> {
        let spans: Vec<_> = self.spans.iter().filter(|(span, _)| span.start < end && span.end > start).collect();
        if spans.first()?.0.start != start || spans.last()?.0.end != end {
            return None;
        }
        let mut native = spans.iter().filter_map(|(_, native)| native.as_ref());
        let first = native.next()?;
        let mut end = first.end;
        for next in native {
            if next.start != end {
                return None;
            }
            end = next.end;
        }
        Some([isize::try_from(first.start).ok()?, isize::try_from(end - first.start).ok()?])
    }
}

#[derive(Debug, Clone)]
pub struct ObservedText {
    fingerprint: [u8; 32],
    pub rendered: RenderedText,
}

impl ObservedText {
    pub fn new(value: &str, rendered: RenderedText) -> Self {
        Self { fingerprint: Sha256::digest(value.as_bytes()).into(), rendered }
    }

    fn matches(&self, value: &str) -> bool {
        self.fingerprint == <[u8; 32]>::from(Sha256::digest(value.as_bytes()))
    }
}

#[cfg(test)]
pub fn attributed_markdown(runs: &[(String, TextStyle)], starts_line: bool) -> Option<String> {
    attributed_text(runs, starts_line).map(|rendered| rendered.markdown)
}

pub fn attributed_text(runs: &[(String, TextStyle)], starts_line: bool) -> Option<RenderedText> {
    if runs.iter().all(|(_, style)| *style == TextStyle::default()) {
        return None;
    }
    let mut merged: Vec<(String, &TextStyle)> = vec![];
    for (text, style) in runs {
        if let Some((previous, _)) = merged.last_mut().filter(|(_, previous_style)| *previous_style == style) {
            previous.push_str(text);
        } else {
            merged.push((text.clone(), style));
        }
    }
    let mut out = RenderedText::default();
    let mut native_at = 0;
    let mut line_start = starts_line;
    for (text, style) in merged {
        for line in text.split_inclusive('\n') {
            if line_start && !line.trim().is_empty() {
                if let Some(prefix) = &style.list_prefix {
                    let marker = prefix.trim();
                    let ordered = marker
                        .strip_suffix('.')
                        .or_else(|| marker.strip_suffix(')'))
                        .filter(|digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()));
                    let marker = ordered.map_or_else(|| "-".to_string(), |digits| format!("{digits}."));
                    out.syntax(&format!("{}{marker} ", "  ".repeat(style.list_level.min(20))));
                }
            }
            let body = line.trim();
            let leading = line.len() - line.trim_start().len();
            out.native(&line[..leading], false, &mut native_at);
            if !body.is_empty() {
                let mut rendered = RenderedText::default();
                rendered.native(body, true, &mut native_at);
                let html_emphasis = out.markdown.ends_with('*')
                    || body.starts_with(|c: char| !c.is_alphanumeric())
                    || body.ends_with(|c: char| !c.is_alphanumeric());
                let (bold_open, bold_close, italic_open, italic_close) =
                    if html_emphasis { ("<strong>", "</strong>", "<em>", "</em>") } else { ("**", "**", "*", "*") };
                for (enabled, open, close) in [
                    (style.bold, bold_open, bold_close),
                    (style.italic, italic_open, italic_close),
                    (style.strike, "~~", "~~"),
                    (style.underline, "<u>", "</u>"),
                ] {
                    if enabled {
                        rendered = rendered.wrap(open, close);
                    }
                }
                if let Some(url) = &style.link {
                    let url = url
                        .bytes()
                        .map(|b| if b <= 32 || b >= 127 || b"<>\\".contains(&b) { format!("%{b:02X}") } else { (b as char).to_string() })
                        .collect::<String>();
                    rendered = rendered.wrap("[", &format!("](<{url}>)"));
                }
                out.append(rendered);
                out.native(&line[line.trim_end().len()..], false, &mut native_at);
            }
            line_start = line.ends_with('\n');
        }
    }
    Some(out)
}

fn matches<'a>(value: &'a str, text: &'a str, prefix: &'a str, suffix: &'a str) -> impl Iterator<Item = usize> + 'a {
    value
        .char_indices()
        .map(|(i, _)| i)
        .filter(move |&i| value[i..].starts_with(text) && value[..i].ends_with(prefix) && value[i + text.len()..].starts_with(suffix))
}

#[cfg(test)]
pub fn selection_range(value: &str, text: &str, prefix: &str, suffix: &str, selection: Selection) -> Result<[isize; 2], &'static str> {
    observed_selection_range(value, None, text, prefix, suffix, selection)
}

pub fn observed_selection_range(
    value: &str,
    observed: Option<&ObservedText>,
    text: &str,
    prefix: &str,
    suffix: &str,
    selection: Selection,
) -> Result<[isize; 2], &'static str> {
    if text.is_empty() {
        return Err("Selection text must not be empty");
    }
    if observed.is_some_and(|observed| !observed.matches(value)) {
        return Err("The element's text changed since its observation; observe it again before selecting");
    }
    let mut ranges: Vec<_> = matches(value, text, prefix, suffix)
        .take(2)
        .map(|at| [value[..at].encode_utf16().count() as isize, text.encode_utf16().count() as isize])
        .collect();
    if let Some(observed) = observed {
        ranges.extend(
            matches(&observed.rendered.markdown, text, prefix, suffix).filter_map(|at| observed.rendered.native_range(at, at + text.len())),
        );
    }
    ranges.sort_unstable();
    ranges.dedup();
    let [start, len] = match ranges.as_slice() {
        [range] => *range,
        [] => return Err("The requested text and context were not found in the element's value or observed Markdown"),
        _ => return Err("The requested text matches more than once; provide prefix or suffix to identify one occurrence"),
    };
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
    fn observed(runs: Vec<(String, TextStyle)>) -> (String, ObservedText) {
        let value: String = runs.iter().map(|(text, _)| text.as_str()).collect();
        let observed = ObservedText::new(&value, attributed_text(&runs, true).unwrap());
        (value, observed)
    }

    #[test]
    fn observed_selection_freshness_retains_no_full_value() {
        let rendered = attributed_text(&[("hello".into(), TextStyle { bold: true, ..Default::default() })], true).unwrap();
        let small_cost = ObservedText::new("hello", rendered.clone()).rendered.retained_bytes();
        let mut large = "hello".to_string() + &"x".repeat(2 * 1024 * 1024);
        let observed = ObservedText::new(&large, rendered);
        assert_eq!(observed.rendered.retained_bytes(), small_cost);
        assert_eq!(observed_selection_range(&large, Some(&observed), "**hello**", "", "", Selection::Text).unwrap(), [0, 5]);
        large.pop();
        large.push('y');
        assert!(observed_selection_range(&large, Some(&observed), "**hello**", "", "", Selection::Text).is_err());
    }

    #[test]
    fn observed_selection_maps_escaped_unicode_and_link_labels() {
        let (value, observed) = observed(vec![
            ("😀 ".into(), TextStyle::default()),
            ("[label]".into(), TextStyle { link: Some("https://example.test/target".into()), ..Default::default() }),
        ]);
        let choose = |text, selection| observed_selection_range(&value, Some(&observed), text, "", "", selection);
        assert_eq!(choose("[\\[label\\]](<https://example.test/target>)", Selection::Text).unwrap(), [3, 7]);
        assert_eq!(choose("\\[label\\]", Selection::CursorAfter).unwrap(), [10, 0]);
        assert_eq!(choose("label", Selection::Text).unwrap(), [4, 5]);
        assert!(choose("https://example.test/target", Selection::Text).is_err());
        assert!(choose("[label\\]", Selection::Text).is_err());
    }

    #[test]
    fn observed_selection_disambiguates_formatting_without_guessing_literal_markup() {
        let bold = TextStyle { bold: true, ..Default::default() };
        let (value, observed) = observed(vec![("foo ".into(), TextStyle::default()), ("foo".into(), bold.clone())]);
        assert!(observed_selection_range(&value, Some(&observed), "foo", "", "", Selection::Text).is_err());
        assert_eq!(observed_selection_range(&value, Some(&observed), "**foo**", "", "", Selection::Text).unwrap(), [4, 3]);
        assert_eq!(observed_selection_range(&value, Some(&observed), "foo", "**", "**", Selection::Text).unwrap(), [4, 3]);
        let (literal_value, literal) = self::observed(vec![("**foo** ".into(), TextStyle::default()), ("foo".into(), bold)]);
        assert!(observed_selection_range(&literal_value, Some(&literal), "**foo**", "", "", Selection::Text).is_err());
        assert_eq!(observed_selection_range(&literal_value, Some(&literal), "**foo**", " ", "", Selection::Text).unwrap(), [8, 3]);
    }

    #[test]
    fn observed_selection_uses_visible_offsets_and_rejects_stale_text_and_notices() {
        let (_, mut observed) = observed(vec![("😀bold".into(), TextStyle { bold: true, ..Default::default() })]);
        observed.rendered.offset(7);
        observed.rendered.syntax("\n… text truncated");
        let value = "prefix 😀bold tail";
        let observed = ObservedText::new(value, observed.rendered);
        assert_eq!(observed_selection_range(value, Some(&observed), "😀bold", "", "", Selection::Text).unwrap(), [7, 6]);
        assert!(observed_selection_range(value, Some(&observed), "text truncated", "", "", Selection::Text).is_err());
        assert!(observed_selection_range("changed 😀bold tail", Some(&observed), "😀bold", "", "", Selection::Text).is_err());
    }

    #[test]
    fn attributed_observation_preserves_paragraphs_lists_and_escaped_links() {
        let runs = vec![
            ("first\n\n".into(), TextStyle { bold: true, ..Default::default() }),
            ("item".into(), TextStyle { italic: true, list_prefix: Some("•".into()), list_level: 1, ..Default::default() }),
            (" more\n".into(), TextStyle { list_prefix: Some("•".into()), list_level: 1, ..Default::default() }),
            ("[link]".into(), TextStyle { link: Some("https://example.test/é>a b".into()), ..Default::default() }),
        ];
        assert_eq!(
            attributed_markdown(&runs, true).unwrap(),
            "**first**\n\n  - *item* more\n[\\[link\\]](<https://example.test/%C3%A9%3Ea%20b>)"
        );
        assert_eq!(attributed_markdown(&runs[1..2], false).unwrap(), "*item*");
        assert!(attributed_markdown(&[("plain".into(), TextStyle::default())], true).is_none());
    }

    #[test]
    fn attributed_observation_emphasizes_inside_words() {
        let runs = vec![
            ("a".into(), TextStyle::default()),
            ("b".into(), TextStyle { italic: true, ..Default::default() }),
            ("c".into(), TextStyle::default()),
        ];
        let markdown = attributed_markdown(&runs, true).unwrap();
        let mut html = String::new();
        pulldown_cmark::html::push_html(&mut html, pulldown_cmark::Parser::new(&markdown));
        assert_eq!(html, "<p>a<em>b</em>c</p>\n");
        for (middle, suffix, expected) in [
            ("(", TextStyle::default(), "<p>a<em>(</em>c</p>\n"),
            ("b", TextStyle { bold: true, ..Default::default() }, "<p>a<em>b</em><strong>c</strong></p>\n"),
        ] {
            let runs = vec![
                ("a".into(), TextStyle::default()),
                (middle.into(), TextStyle { italic: true, ..Default::default() }),
                ("c".into(), suffix),
            ];
            let markdown = attributed_markdown(&runs, true).unwrap();
            let mut html = String::new();
            pulldown_cmark::html::push_html(&mut html, pulldown_cmark::Parser::new(&markdown));
            assert_eq!(html, expected);
        }
    }

    #[test]
    fn attributed_observation_coalesces_equivalent_runs() {
        let style = TextStyle { bold: true, strike: true, underline: true, ..Default::default() };
        let runs = vec![("bo".into(), style.clone()), ("ld".into(), style)];
        assert_eq!(attributed_markdown(&runs, true).unwrap(), "<u>~~**bold**~~</u>");
    }

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
        assert!(inserted("aba", None, "ababa", "ab"));
        assert!(inserted("éé", None, "é😀é", "😀"));
        assert!(inserted("é", None, "éXĩ", "Xĩ"));
        assert!(!inserted("éé", None, "éêé", "😀"));
        assert_eq!(expected("**hi** there", PasteFormat::Markdown), vec!["**hi** there".to_string(), "hi there".to_string()]);
        assert_eq!(expected("plain", PasteFormat::Text), vec!["plain".to_string()]);
    }

    #[test]
    fn long_paste_confirmation_without_selection_finishes_promptly() {
        let before = "a".repeat(2_097_152);
        let pasted = "b".repeat(262_144);
        let after = format!("{before}{pasted}");
        let started = std::time::Instant::now();
        assert!(inserted(&before, None, &after, &pasted));
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
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
