pub const SHIFT: u64 = 1 << 17;
pub const CONTROL: u64 = 1 << 18;
pub const OPTION: u64 = 1 << 19;
pub const COMMAND: u64 = 1 << 20;
pub const KEYPAD: u64 = 1 << 21;
pub const FUNCTION: u64 = 1 << 23;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chord {
    pub code: u16,
    pub flags: u64,
    pub character: Option<char>,
    pub modifiers: Vec<u16>,
}

impl Chord {
    pub fn remap(&mut self, stroke: crate::text::Stroke) {
        self.code = stroke.code;
        if !self.modifiers.iter().any(|code| modifier(*code) == Some(SHIFT)) {
            self.flags &= !SHIFT;
        }
        if stroke.shift {
            self.flags |= SHIFT;
        }
        if stroke.option {
            self.flags |= OPTION;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Event {
    pub code: u16,
    pub flags: u64,
    pub down: bool,
    pub modifier: bool,
    pub release: bool,
}

#[derive(Default)]
pub struct Pressed(Vec<u16>);

impl Pressed {
    pub fn record(&mut self, event: Event) -> bool {
        if event.release {
            let Some(at) = self.0.iter().position(|code| *code == event.code) else { return false };
            self.0.remove(at);
        } else {
            self.0.push(event.code);
        }
        true
    }
}

fn modifier(code: u16) -> Option<u64> {
    match code {
        54 | 55 => Some(COMMAND),
        56 | 60 => Some(SHIFT),
        58 | 61 => Some(OPTION),
        59 | 62 => Some(CONTROL),
        63 => Some(FUNCTION),
        _ => None,
    }
}

fn modifier_code(name: &str) -> Option<u16> {
    match name {
        "cmd" | "command" | "meta" | "super" | "super_l" | "meta_l" => Some(55),
        "super_r" | "meta_r" | "rightcommand" => Some(54),
        "shift" | "shift_l" => Some(56),
        "shift_r" | "rightshift" => Some(60),
        "opt" | "option" | "alt" | "alt_l" => Some(58),
        "alt_r" | "rightoption" => Some(61),
        "ctrl" | "control" | "control_l" => Some(59),
        "control_r" | "rightcontrol" => Some(62),
        "fn" | "function" => Some(63),
        _ => None,
    }
}

pub fn parse(input: &str) -> Option<Chord> {
    let (mods, last) = match input.rsplit_once('+') {
        Some((m, "")) => (m.strip_suffix('+').unwrap_or(m), "+"),
        Some((m, last)) => (m, last),
        None => ("", input),
    };
    let mut flags = 0;
    let mut modifiers = Vec::new();
    for name in mods.split('+').filter(|m| !m.is_empty()) {
        let code = modifier_code(&name.to_ascii_lowercase())?;
        let flag = modifier(code)?;
        if flags & flag == 0 {
            modifiers.push(code);
        }
        flags |= flag;
    }
    let name = last.to_ascii_lowercase();
    if let Some(code) = modifier_code(&name) {
        return Some(Chord { code, flags, character: None, modifiers });
    }
    let single = (last.chars().count() == 1).then(|| last.chars().next().unwrap()).or_else(|| symbol(&name));
    let symbol = single.and_then(|c| "~!@#$%^&*()_+{}|:\"<>?".chars().position(|x| x == c));
    let normalized = if let Some(i) = symbol {
        flags |= SHIFT;
        "`1234567890-=[]\\;',./".chars().nth(i)?.to_string()
    } else {
        name.clone()
    };
    let code = code(&single.filter(|_| symbol.is_none()).map(|c| c.to_ascii_lowercase().to_string()).unwrap_or(normalized))?;
    if name.starts_with("kp_") || name.starts_with("keypad") {
        flags |= KEYPAD;
    }
    Some(Chord { code, flags, character: single.filter(|c| c.is_ascii() && !c.is_control()), modifiers })
}

pub fn events(code: u16, flags: u64) -> Vec<Event> {
    events_with_modifiers(code, flags, &[])
}

pub fn events_with_modifiers(code: u16, flags: u64, requested: &[u16]) -> Vec<Event> {
    let modifiers = [(59, CONTROL), (58, OPTION), (56, SHIFT), (55, COMMAND), (63, FUNCTION)];
    let key_modifier = modifier(code);
    let held: Vec<_> = modifiers
        .into_iter()
        .filter(|(_, f)| flags & f != 0 && Some(*f) != key_modifier)
        .map(|(default, flag)| (requested.iter().copied().find(|c| modifier(*c) == Some(flag)).unwrap_or(default), flag))
        .collect();
    let mut active = 0;
    let mut out = Vec::new();
    for &(code, flag) in &held {
        active |= flag;
        out.push(Event { code, flags: active, down: true, modifier: true, release: false });
    }
    out.push(Event { code, flags: flags | key_modifier.unwrap_or(0), down: true, modifier: key_modifier.is_some(), release: false });
    out.push(Event { code, flags: flags & !key_modifier.unwrap_or(0), down: false, modifier: key_modifier.is_some(), release: true });
    for &(code, flag) in held.iter().rev() {
        active &= !flag;
        out.push(Event { code, flags: active, down: false, modifier: true, release: true });
    }
    out
}

const SYMBOLS: &[(&str, char)] = &[
    ("comma", ','),
    ("period", '.'),
    ("slash", '/'),
    ("backslash", '\\'),
    ("semicolon", ';'),
    ("colon", ':'),
    ("apostrophe", '\''),
    ("quoteright", '\''),
    ("quotedbl", '"'),
    ("grave", '`'),
    ("quoteleft", '`'),
    ("asciitilde", '~'),
    ("minus", '-'),
    ("underscore", '_'),
    ("equal", '='),
    ("plus", '+'),
    ("bracketleft", '['),
    ("bracketright", ']'),
    ("braceleft", '{'),
    ("braceright", '}'),
    ("parenleft", '('),
    ("parenright", ')'),
    ("less", '<'),
    ("greater", '>'),
    ("question", '?'),
    ("exclam", '!'),
    ("at", '@'),
    ("numbersign", '#'),
    ("dollar", '$'),
    ("percent", '%'),
    ("asciicircum", '^'),
    ("ampersand", '&'),
    ("asterisk", '*'),
    ("bar", '|'),
];
fn symbol(name: &str) -> Option<char> {
    SYMBOLS.iter().find(|(n, _)| *n == name).map(|(_, c)| *c)
}

fn code(k: &str) -> Option<u16> {
    const KEYS: &[(&str, u16)] = &[
        ("a", 0),
        ("s", 1),
        ("d", 2),
        ("f", 3),
        ("h", 4),
        ("g", 5),
        ("z", 6),
        ("x", 7),
        ("c", 8),
        ("v", 9),
        ("b", 11),
        ("q", 12),
        ("w", 13),
        ("e", 14),
        ("r", 15),
        ("y", 16),
        ("t", 17),
        ("1", 18),
        ("2", 19),
        ("3", 20),
        ("4", 21),
        ("6", 22),
        ("5", 23),
        ("=", 24),
        ("9", 25),
        ("7", 26),
        ("-", 27),
        ("8", 28),
        ("0", 29),
        ("]", 30),
        ("o", 31),
        ("u", 32),
        ("[", 33),
        ("i", 34),
        ("p", 35),
        ("return", 36),
        ("enter", 36),
        ("l", 37),
        ("j", 38),
        ("'", 39),
        ("k", 40),
        (";", 41),
        ("\\", 42),
        (",", 43),
        ("/", 44),
        ("n", 45),
        ("m", 46),
        (".", 47),
        ("tab", 48),
        ("space", 49),
        ("`", 50),
        ("delete", 51),
        ("backspace", 51),
        ("escape", 53),
        ("esc", 53),
        ("f5", 96),
        ("f6", 97),
        ("f7", 98),
        ("f3", 99),
        ("f8", 100),
        ("f9", 101),
        ("f11", 103),
        ("f10", 109),
        ("f12", 111),
        ("home", 115),
        ("pageup", 116),
        ("forwarddelete", 117),
        ("f4", 118),
        ("end", 119),
        ("f2", 120),
        ("pagedown", 121),
        ("f1", 122),
        ("left", 123),
        ("right", 124),
        ("down", 125),
        ("up", 126),
    ];
    let extra = match k {
        "f13" => 105,
        "f14" => 107,
        "f15" => 113,
        "f16" => 106,
        "f17" => 64,
        "f18" => 79,
        "f19" => 80,
        "f20" => 90,
        "kp_decimal" | "kp_separator" | "keypaddecimal" => 65,
        "kp_multiply" | "keypadmultiply" => 67,
        "kp_add" | "keypadadd" => 69,
        "kp_clear" | "clear" | "numlock" | "num_lock" => 71,
        "kp_divide" | "keypaddivide" => 75,
        "kp_enter" | "keypadenter" => 76,
        "kp_subtract" | "keypadsubtract" => 78,
        "kp_equal" | "keypadequal" => 81,
        "kp_0" | "kp_insert" | "keypad0" => 82,
        "kp_1" | "kp_end" | "keypad1" => 83,
        "kp_2" | "kp_down" | "keypad2" => 84,
        "kp_3" | "kp_next" | "keypad3" => 85,
        "kp_4" | "kp_left" | "keypad4" => 86,
        "kp_5" | "kp_begin" | "keypad5" => 87,
        "kp_6" | "kp_right" | "keypad6" => 88,
        "kp_7" | "kp_home" | "keypad7" => 89,
        "kp_8" | "kp_up" | "keypad8" => 91,
        "kp_9" | "kp_prior" | "keypad9" => 92,
        "linefeed" => 36,
        "prior" | "page_up" => 116,
        "next" | "page_down" => 121,
        "forward_delete" | "kp_delete" => 117,
        "help" | "insert" => 114,
        "minus" => 27,
        "equal" => 24,
        "bracketleft" => 33,
        "bracketright" => 30,
        "backslash" => 42,
        "semicolon" => 41,
        "apostrophe" => 39,
        "comma" => 43,
        "period" => 47,
        "slash" => 44,
        "grave" => 50,
        _ => return KEYS.iter().find(|(n, _)| *n == k).map(|(_, c)| *c),
    };
    Some(extra)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupted_chords_release_only_posted_down_events() {
        let events = events(17, COMMAND | SHIFT);
        for (downs, expected) in [(0, vec![]), (1, vec![56, 56]), (2, vec![56, 55, 55, 56]), (3, vec![56, 55, 17, 17, 55, 56])] {
            let mut pressed = Pressed::default();
            let sent: Vec<_> = events
                .iter()
                .filter(|event| !event.release)
                .take(downs)
                .chain(events.iter().filter(|event| event.release))
                .filter(|event| pressed.record(**event))
                .collect();
            assert_eq!(sent.iter().map(|event| event.code).collect::<Vec<_>>(), expected);
            assert_eq!(sent.iter().filter(|event| event.down).count(), sent.iter().filter(|event| !event.down).count());
            assert!(sent.last().is_none_or(|event| event.flags == 0));
        }
    }

    #[test]
    fn named_key_coverage() {
        for (key, code) in [("F13", 105), ("f20", 90), ("KP_Enter", 76), ("KP_9", 92), ("Page_Down", 121), ("BackSpace", 51)] {
            assert_eq!(parse(key).unwrap().code, code);
        }
        assert_eq!(parse("KP_Enter").unwrap().flags, KEYPAD);
        assert!(parse("f21").is_none());
        assert!(parse("hyper+a").is_none());
    }

    #[test]
    fn punctuation_and_modifier_aliases() {
        assert_eq!(parse("ctrl+alt+Delete").unwrap().flags, CONTROL | OPTION);
        assert_eq!(parse("cmd++").unwrap(), Chord { code: 24, flags: COMMAND | SHIFT, character: Some('+'), modifiers: vec![55] });
        assert_eq!(parse("+").unwrap().code, 24);
        assert_eq!(parse("?").unwrap().code, 44);
        assert_eq!(parse("cmd+plus").unwrap().flags, COMMAND | SHIFT);
        assert_eq!(parse("question").unwrap().code, 44);
        let right = parse("Control_R+a").unwrap();
        assert_eq!(events_with_modifiers(right.code, right.flags, &right.modifiers)[0].code, 62);
        assert_eq!(parse("Super_L+Shift_L+t").unwrap().flags, COMMAND | SHIFT);
        assert_eq!(parse("Control_R").unwrap().code, 62);
    }

    #[test]
    fn layout_mapping_replaces_implicit_shift_but_preserves_explicit_modifiers() {
        let stroke = crate::text::Stroke { code: 30, shift: false, option: false };
        let mut chord = parse("cmd+plus").unwrap();
        chord.remap(stroke);
        let events = events_with_modifiers(chord.code, chord.flags, &chord.modifiers);
        assert_eq!(events.iter().map(|event| event.code).collect::<Vec<_>>(), [55, 30, 30, 55]);
        assert_eq!(events.iter().map(|event| event.flags).collect::<Vec<_>>(), [COMMAND, COMMAND, COMMAND, 0]);
        let mut explicit = parse("cmd+Shift_R+plus").unwrap();
        explicit.remap(stroke);
        let events = events_with_modifiers(explicit.code, explicit.flags, &explicit.modifiers);
        assert_eq!(events[0].code, 60);
        assert_eq!(events[2].flags, COMMAND | SHIFT);
        let mut option = parse("cmd+numbersign").unwrap();
        option.remap(crate::text::Stroke { code: 20, shift: false, option: true });
        assert_eq!(option.flags, COMMAND | OPTION);
    }

    #[test]
    fn chords_press_and_release_modifiers_in_reverse_order() {
        let events = events(17, COMMAND | SHIFT);
        assert_eq!(events.iter().map(|e| e.code).collect::<Vec<_>>(), [56, 55, 17, 17, 55, 56]);
        assert_eq!(
            events.iter().map(|e| e.flags).collect::<Vec<_>>(),
            [SHIFT, SHIFT | COMMAND, SHIFT | COMMAND, SHIFT | COMMAND, SHIFT, 0]
        );
        assert!(events[..2].iter().all(|e| e.modifier && e.down && !e.release));
        assert!(events[3..].iter().all(|e| e.release));
    }

    #[test]
    fn standalone_modifier_is_a_flags_pair() {
        let events = events(62, 0);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].flags, CONTROL);
        assert_eq!(events[1].flags, 0);
        assert!(events.iter().all(|e| e.modifier));
    }
}
