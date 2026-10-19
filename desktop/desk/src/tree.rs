use crate::protocol::Rect;
use std::collections::{HashMap, HashSet};

const EDGE: f64 = 1.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Key {
    Element(u32),
    Note(u32, u32),
    Section(u32),
    Info(u32),
}

pub const ROOT: u32 = u32::MAX;

pub fn intersect(a: Rect, b: Rect) -> Option<Rect> {
    let (x, y) = (a.x.max(b.x), a.y.max(b.y));
    let (right, bottom) = ((a.x + a.w).min(b.x + b.w), (a.y + a.h).min(b.y + b.h));
    (right > x && bottom > y).then_some(Rect { x, y, w: right - x, h: bottom - y })
}

pub fn visible(f: Rect, clip: Rect) -> Option<Rect> {
    if f.w > 0.0 && f.h > 0.0 {
        return intersect(f, clip);
    }
    let inside = f.x >= clip.x && f.x <= clip.x + clip.w && f.y > clip.y + EDGE && f.y < clip.y + clip.h - EDGE;
    inside.then_some(f)
}

pub struct Rendered {
    pub tree: String,
    pub diffed: bool,
    pub removed: Vec<u32>,
}

pub fn render(lines: &[(Key, String)], base: Option<&HashMap<Key, String>>, moved: &HashSet<u32>) -> Rendered {
    let full = || Rendered { tree: lines.iter().map(|(_, l)| format!("{l}\n")).collect(), diffed: false, removed: vec![] };
    let Some(base) = base else { return full() };
    let mut tree = String::new();
    let mut changed = 0;
    for (key, line) in lines {
        let rebound = matches!(key, Key::Element(id) if moved.contains(id));
        let mark = match base.get(key) {
            Some(old) if old == line && !rebound => continue,
            Some(_) => "~",
            None => "+",
        };
        changed += 1;
        tree += &format!("{mark} {line}\n");
    }
    if changed * 5 > lines.len() * 3 {
        return full();
    }
    let present: HashSet<&Key> = lines.iter().map(|(k, _)| k).collect();
    let mut removed: Vec<u32> = base
        .keys()
        .filter(|k| !present.contains(k))
        .filter_map(|k| match k {
            Key::Element(id) => Some(*id),
            _ => None,
        })
        .collect();
    removed.sort_unstable();
    Rendered { tree, diffed: true, removed }
}

const TEXT_ROLES: &[&str] = &["AXStaticText", "AXTextArea", "AXTextField", "AXHeading"];
const TOGGLES: &[&str] = &["AXCheckBox", "AXRadioButton", "AXSwitch", "AXToggle", "AXMenuItem"];
const QUIET_SUBROLES: &[&str] = &["AXUnknown", "AXStandardWindow", "AXTextAttachment"];
pub const MAX_TEXT: usize = 1000;
const FOLDS: &[&str] = &["AXHeading", "AXLink"];

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Props {
    pub role: String,
    pub subrole: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub label: Option<String>,
    pub value: Option<String>,
    pub placeholder: Option<String>,
    pub url: Option<String>,
    pub identifier: Option<String>,
    pub expanded: Option<bool>,
    pub focused: bool,
    pub disabled: bool,
    pub selected: bool,
    pub settable: bool,
    pub actions: Vec<String>,
    pub list_item: bool,
}

pub fn clip(s: &str, n: usize) -> String {
    let s = s.replace('\n', "⏎");
    if s.chars().count() > n {
        format!("{}…", s.chars().take(n).collect::<String>())
    } else {
        s
    }
}

fn short(role: &str) -> &str {
    role.strip_prefix("AX").unwrap_or(role)
}

impl Props {
    pub fn name(&self) -> Option<&str> {
        self.title.as_deref().or(self.label.as_deref())
    }

    fn toggle(&self) -> Option<&'static str> {
        if !TOGGLES.contains(&self.role.as_str()) && self.subrole.as_deref() != Some("AXSwitch") {
            return None;
        }
        match self.value.as_deref() {
            Some("1") => Some("checked"),
            Some("2") => Some("mixed"),
            Some("0") if self.role != "AXMenuItem" => Some("unchecked"),
            _ => None,
        }
    }

    fn heading_level(&self) -> Option<usize> {
        let level = self.value.as_deref()?.parse::<usize>().ok()?;
        (self.role == "AXHeading" && (1..=6).contains(&level)).then_some(level)
    }

    pub fn folds_text(&self) -> bool {
        (self.list_item || FOLDS.contains(&self.role.as_str())) && self.title.is_none() && self.label.is_none()
    }

    pub fn content_list(&self) -> bool {
        self.role == "AXList" && self.subrole.as_deref() == Some("AXContentList")
    }

    pub fn plain_text(&self) -> bool {
        self.role == "AXStaticText" && self.actions.is_empty() && !self.focused && !self.selected && self.text().is_some()
    }

    pub fn text(&self) -> Option<&str> {
        self.value.as_deref().or(self.title.as_deref()).or(self.description.as_deref())
    }

    pub fn describe(&self) -> (String, bool) {
        let toggle = self.toggle();
        let name = self.name();
        let value = self.value.as_deref().filter(|v| Some(*v) != name && toggle.is_none() && self.heading_level().is_none());
        let description = self.description.as_deref().filter(|d| Some(*d) != name);
        let placeholder = self.placeholder.as_deref().filter(|_| value.is_none());
        let keep = self.list_item
            || name.is_some()
            || description.is_some()
            || value.is_some()
            || placeholder.is_some()
            || self.url.is_some()
            || toggle.is_some()
            || self.expanded.is_some()
            || self.focused
            || self.selected
            || self.settable
            || !self.actions.is_empty();
        let level = self.heading_level().filter(|_| name.is_some());
        let bullet = self.list_item && self.role == "AXGroup";
        let markdown = level.is_some() || bullet;
        let mut s = match (level, bullet) {
            (Some(l), _) => format!("{} {}", "#".repeat(l), clip(name.unwrap_or_default(), MAX_TEXT)),
            (None, true) => name.map_or("-".to_string(), |n| format!("- {}", clip(n, MAX_TEXT))),
            _ => short(&self.role).to_string(),
        };
        if let Some(sub) = self.subrole.as_deref().filter(|s| !QUIET_SUBROLES.contains(s) && !markdown) {
            s += &format!(":{}", short(sub));
        }
        if let Some(n) = name.filter(|_| !markdown) {
            s += &format!(" \"{}\"", clip(n, 80));
        }
        if let Some(d) = description {
            s += &format!(" ({})", clip(d, 80));
        }
        if let Some(v) = value {
            let n = if TEXT_ROLES.contains(&self.role.as_str()) { MAX_TEXT } else { 120 };
            s += &format!(" = \"{}\"", clip(v, n));
        }
        if let Some(p) = placeholder {
            s += &format!(" placeholder \"{}\"", clip(p, 80));
        }
        if let Some(u) = &self.url {
            s += &format!(" url \"{}\"", clip(u, 160));
        }
        let mut tags = vec![];
        if self.focused {
            tags.push("focused");
        }
        if self.disabled {
            tags.push("disabled");
        }
        if self.selected {
            tags.push("selected");
        }
        tags.extend(toggle);
        match self.expanded {
            Some(true) => tags.push("expanded"),
            Some(false) => tags.push("collapsed"),
            None => {}
        }
        if self.settable {
            tags.push("settable");
        }
        if !tags.is_empty() {
            s += &format!(" [{}]", tags.join(" "));
        }
        let secondary: Vec<&str> = self.actions.iter().filter(|a| a.as_str() != "AXPress").map(|a| short(a)).collect();
        if !secondary.is_empty() {
            s += &format!(" <{}>", secondary.join(","));
        }
        (s, keep)
    }
}

pub fn joined_text(parts: &[(String, Option<Rect>)]) -> String {
    let mut out = String::new();
    let mut last: Option<Rect> = None;
    for (text, f) in parts {
        let wrapped = matches!((last, f), (Some(a), Some(b)) if b.y >= a.y + a.h - EDGE);
        if wrapped && !out.is_empty() && !out.ends_with(char::is_whitespace) && !text.starts_with(char::is_whitespace) {
            out.push('\n');
        }
        out += text;
        last = f.or(last);
    }
    out.trim().to_string()
}

pub fn merged_text(parts: &[(String, Option<Rect>)]) -> String {
    format!("StaticText = \"{}\"", clip(&joined_text(parts), MAX_TEXT))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    pub key: Key,
    pub text: String,
    pub kids: Vec<Item>,
}

impl Item {
    pub fn leaf(key: Key, text: String) -> Item {
        Item { key, text, kids: vec![] }
    }
}

const MAX_INDENT: usize = 50;
const CUT_NOTE: usize = 80;

fn indent(depth: usize) -> String {
    "  ".repeat(depth.min(MAX_INDENT))
}

impl Item {
    fn line(&self, depth: usize) -> String {
        match self.key {
            Key::Element(id) => format!("{}[{id}] {}", indent(depth), self.text),
            _ => format!("{}{}", indent(depth), self.text),
        }
    }

    pub fn renumber(&mut self, moved: &HashMap<u32, u32>) {
        if let Key::Element(id) = self.key {
            self.key = Key::Element(*moved.get(&id).unwrap_or(&id));
        }
        if let Key::Note(a, n) = self.key {
            self.key = Key::Note(*moved.get(&a).unwrap_or(&a), n);
        }
        self.kids.iter_mut().for_each(|k| k.renumber(moved));
    }
}

fn own(it: &Item, depth: usize) -> usize {
    it.line(depth).len() + 1
}

fn size(it: &Item, depth: usize) -> usize {
    own(it, depth) + it.kids.iter().map(|k| size(k, depth + 1)).sum::<usize>()
}

fn anchor_of(key: Key, parent: u32) -> u32 {
    match key {
        Key::Element(id) => id,
        _ => parent,
    }
}

fn emit(it: &Item, depth: usize, out: &mut Vec<(Key, String)>) {
    out.push((it.key, it.line(depth)));
    for k in &it.kids {
        emit(k, depth + 1, out);
    }
}

fn cut_note(anchor: u32, depth: usize, n: usize, out: &mut Vec<(Key, String)>) {
    out.push((Key::Note(anchor, u32::MAX), format!("{}… {n} more not shown; the observation size limit was reached", indent(depth))));
}

fn fit(items: &[Item], depth: usize, anchor: u32, budget: usize, out: &mut Vec<(Key, String)>) -> bool {
    let sizes: Vec<usize> = items.iter().map(|i| size(i, depth)).collect();
    if sizes.iter().sum::<usize>() <= budget {
        items.iter().for_each(|i| emit(i, depth, out));
        return false;
    }
    let floor: Vec<usize> =
        items.iter().map(|i| own(i, depth) + if i.kids.is_empty() { 0 } else { indent(depth + 1).len() + CUT_NOTE }).collect();
    if floor.iter().sum::<usize>() > budget {
        let room = budget.saturating_sub(indent(depth).len() + CUT_NOTE);
        let mut used = 0;
        let mut shown = 0;
        for (i, it) in items.iter().enumerate() {
            if used + floor[i] > room {
                break;
            }
            used += floor[i];
            shown += 1;
            out.push((it.key, it.line(depth)));
            if !it.kids.is_empty() {
                cut_note(anchor_of(it.key, anchor), depth + 1, it.kids.len(), out);
            }
        }
        cut_note(anchor, depth, items.len() - shown, out);
        return true;
    }
    let allowance = |cap: usize| -> Vec<usize> { sizes.iter().zip(&floor).map(|(&s, &f)| s.min(cap).max(f)).collect() };
    let (mut lo, mut hi) = (0, *sizes.iter().max().unwrap_or(&0));
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if allowance(mid).iter().sum::<usize>() <= budget {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    for (it, give) in items.iter().zip(allowance(lo)) {
        if size(it, depth) <= give {
            emit(it, depth, out);
        } else {
            out.push((it.key, it.line(depth)));
            fit(&it.kids, depth + 1, anchor_of(it.key, anchor), give - own(it, depth), out);
        }
    }
    true
}

pub fn layout(items: &[Item], budget: usize) -> (Vec<(Key, String)>, bool) {
    let mut out = vec![];
    let cut = fit(items, 0, ROOT, budget, &mut out);
    (out, cut)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Locator {
    hash: u64,
    pub rebindable: bool,
}

const COLLECTIONS: &[&str] = &["AXRow", "AXOutlineRow", "AXCell", "AXList", "AXTable", "AXOutline", "AXBrowser", "AXGrid"];

impl Locator {
    pub const ROOT: Locator = Locator { hash: 0xcbf2_9ce4_8422_2325, rebindable: true };

    pub fn child(self, p: &Props) -> Locator {
        let mut h = self.hash;
        let mut eat = |s: &str| {
            for b in s.bytes().chain([0xff]) {
                h ^= b as u64;
                h = h.wrapping_mul(0x0100_0000_01b3);
            }
        };
        eat(&p.role);
        eat(p.subrole.as_deref().unwrap_or(""));
        eat(p.identifier.as_deref().unwrap_or(""));
        eat(p.name().unwrap_or(""));
        if p.name().is_none() && p.identifier.is_none() {
            eat(p.description.as_deref().unwrap_or(""));
        }
        Locator { hash: h, rebindable: self.rebindable && !COLLECTIONS.contains(&p.role.as_str()) }
    }
}

const PARK_OBSERVATIONS: u32 = 30;
const MAX_PARKED: usize = 5000;

struct Entry<T> {
    id: u32,
    el: T,
    hash: usize,
    locator: Locator,
    idle: u32,
    now: bool,
}

pub struct Ids<T> {
    known: Vec<Entry<T>>,
    by_hash: HashMap<usize, Vec<usize>>,
    by_locator: HashMap<Locator, Vec<usize>>,
    taken: HashSet<u32>,
    fresh: Vec<(u32, Locator)>,
    pub next: u32,
}

impl<T: PartialEq + Clone> Ids<T> {
    pub fn new() -> Self {
        Ids { known: vec![], by_hash: HashMap::new(), by_locator: HashMap::new(), taken: HashSet::new(), fresh: vec![], next: 0 }
    }

    fn add(&mut self, e: Entry<T>) {
        let i = self.known.len();
        self.by_hash.entry(e.hash).or_default().push(i);
        self.by_locator.entry(e.locator).or_default().push(i);
        self.known.push(e);
    }

    pub fn assign(&mut self, el: &T, hash: usize, locator: Locator) -> u32 {
        let same = self.by_hash.get(&hash).and_then(|c| {
            c.iter().copied().find(|&i| {
                !self.known[i].now && !self.taken.contains(&self.known[i].id) && self.known[i].el == *el && self.known[i].locator == locator
            })
        });
        let id = match same {
            Some(i) => self.known[i].id,
            None => {
                self.next += 1;
                self.fresh.push((self.next - 1, locator));
                self.next - 1
            }
        };
        self.taken.insert(id);
        self.add(Entry { id, el: el.clone(), hash, locator, idle: 0, now: true });
        id
    }

    pub fn rebind(&mut self, dead: impl Fn(&T) -> bool) -> HashMap<u32, u32> {
        let mut count: HashMap<Locator, usize> = HashMap::new();
        for entry in self.known.iter().filter(|entry| entry.now) {
            *count.entry(entry.locator).or_default() += 1;
        }
        let mut moved = HashMap::new();
        for (new, locator) in std::mem::take(&mut self.fresh) {
            if count[&locator] != 1 || !locator.rebindable {
                continue;
            }
            let old: HashSet<u32> = self.by_locator[&locator]
                .iter()
                .map(|&i| &self.known[i])
                .filter(|e| !e.now && !self.taken.contains(&e.id))
                .map(|e| e.id)
                .collect();
            let [id] = old.into_iter().collect::<Vec<_>>()[..] else { continue };
            let gone = self.by_locator[&locator].iter().filter(|&&i| self.known[i].id == id).all(|&i| dead(&self.known[i].el));
            if !gone {
                continue;
            }
            for &i in &self.by_locator[&locator] {
                if self.known[i].id == new && self.known[i].now {
                    self.known[i].id = id;
                }
            }
            self.taken.remove(&new);
            self.taken.insert(id);
            moved.insert(new, id);
        }
        moved
    }

    pub fn seen(&self, el: &T, hash: usize) -> bool {
        self.by_hash.get(&hash).is_some_and(|c| c.iter().any(|&i| self.known[i].now && self.known[i].el == *el))
    }

    pub fn carry(self) -> Ids<T> {
        let mut next = Ids::new();
        next.next = self.next;
        let mut seen = HashSet::new();
        let (fresh, old): (Vec<_>, Vec<_>) = self.known.into_iter().partition(|e| e.now);
        for mut e in fresh {
            e.now = false;
            if seen.insert(e.id) {
                next.add(e);
            }
        }
        for mut e in old {
            if next.known.len() >= MAX_PARKED {
                break;
            }
            if self.taken.contains(&e.id) || !seen.insert(e.id) || e.idle >= PARK_OBSERVATIONS {
                continue;
            }
            e.idle += 1;
            next.add(e);
        }
        next
    }

    pub fn locator(&self, id: u32) -> Option<Locator> {
        self.known.iter().find(|e| e.id == id).map(|e| e.locator)
    }
}

impl<T: PartialEq + Clone> Default for Ids<T> {
    fn default() -> Self {
        Self::new()
    }
}

pub fn sparse(region: Rect, window: Rect, lines_inside: usize) -> bool {
    let area = |r: Rect| r.w.max(0.0) * r.h.max(0.0);
    lines_inside == 0 && area(window) > 0.0 && area(region) >= 0.4 * area(window)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, w, h }
    }

    const VIEW: Rect = Rect { x: 0.0, y: 100.0, w: 800.0, h: 500.0 };

    fn shown(x: f64, y: f64, w: f64, h: f64) -> bool {
        visible(r(x, y, w, h), VIEW).is_some()
    }

    #[test]
    fn primary_click_action_is_implicit_but_keeps_unnamed_controls() {
        let mut p = Props { role: "AXButton".into(), actions: vec!["AXPress".into()], ..Props::default() };
        assert_eq!(p.describe(), ("Button".into(), true));
        p.actions.push("AXShowMenu".into());
        assert_eq!(p.describe(), ("Button <ShowMenu>".into(), true));
    }

    #[test]
    fn finds_the_visible_part_of_a_frame() {
        assert!(shown(10.0, 120.0, 50.0, 20.0));
        let part = visible(r(10.0, 590.0, 50.0, 40.0), VIEW).unwrap();
        assert_eq!((part.y, part.h), (590.0, 10.0), "partly visible");
        assert!(!shown(10.0, 700.0, 50.0, 20.0));
        assert!(!shown(10.0, 20.0, 50.0, 20.0));
        assert!(!shown(900.0, 120.0, 50.0, 20.0));
    }

    #[test]
    fn zero_size_frames_on_the_viewport_edge_are_offscreen() {
        assert!(!shown(10.0, 600.0, 120.0, 0.0), "Chromium below the fold");
        assert!(!shown(10.0, 100.0, 120.0, 0.0), "Chromium above the fold");
        assert_eq!(visible(r(10.0, 300.0, 0.0, 0.0), VIEW).map(|v| (v.x, v.y)), Some((10.0, 300.0)), "layout wrapper inside the view");
        assert!(shown(0.0, 300.0, 800.0, 0.0), "zero-height wrapper at left edge");
    }

    #[test]
    fn intersects_rectangles() {
        let i = intersect(r(0.0, 0.0, 100.0, 100.0), r(50.0, 50.0, 100.0, 100.0)).unwrap();
        assert_eq!((i.x, i.y, i.w, i.h), (50.0, 50.0, 50.0, 50.0));
        assert!(intersect(r(0.0, 0.0, 10.0, 10.0), r(10.0, 0.0, 10.0, 10.0)).is_none(), "touching edges");
    }

    fn lines(items: &[(Key, &str)]) -> Vec<(Key, String)> {
        items.iter().map(|(k, l)| (*k, l.to_string())).collect()
    }

    #[test]
    fn renders_the_whole_tree_without_a_base() {
        let out = render(&lines(&[(Key::Element(0), "[0] Button \"OK\"")]), None, &HashSet::new());
        assert_eq!(out.tree, "[0] Button \"OK\"\n");
        assert!(!out.diffed);
    }

    #[test]
    fn marks_added_and_changed_lines_and_lists_removed_ids() {
        let before = lines(&[
            (Key::Element(0), "[0] A"),
            (Key::Element(1), "[1] B"),
            (Key::Element(2), "[2] C"),
            (Key::Element(3), "[3] D"),
            (Key::Element(4), "[4] E"),
            (Key::Note(ROOT, 0), "… 3 offscreen"),
        ]);
        let base: HashMap<Key, String> = before.into_iter().collect();
        let after = lines(&[
            (Key::Element(0), "[0] A"),
            (Key::Element(1), "[1] B changed"),
            (Key::Element(2), "[2] C"),
            (Key::Element(4), "[4] E"),
            (Key::Element(5), "  [5] F"),
        ]);
        let out = render(&after, Some(&base), &HashSet::new());
        assert!(out.diffed);
        assert_eq!(out.tree, "~ [1] B changed\n+   [5] F\n");
        assert_eq!(out.removed, vec![3]);
    }

    #[test]
    fn falls_back_to_the_whole_tree_when_most_lines_changed() {
        let base: HashMap<Key, String> = lines(&[(Key::Element(0), "[0] A"), (Key::Element(1), "[1] B")]).into_iter().collect();
        let after = lines(&[(Key::Element(0), "[0] A2"), (Key::Element(1), "[1] B2"), (Key::Element(2), "[2] C")]);
        let out = render(&after, Some(&base), &HashSet::new());
        assert!(!out.diffed);
        assert_eq!(out.tree, "[0] A2\n[1] B2\n[2] C\n");
        assert!(out.removed.is_empty());
    }

    #[test]
    fn reports_no_change_as_an_empty_diff() {
        let after = lines(&[(Key::Element(0), "[0] A")]);
        let base: HashMap<Key, String> = after.iter().cloned().collect();
        let out = render(&after, Some(&base), &HashSet::new());
        assert!(out.diffed);
        assert_eq!(out.tree, "");
    }

    fn item(id: u32, text: &str, kids: Vec<Item>) -> Item {
        Item { key: Key::Element(id), text: text.into(), kids }
    }

    fn texts(out: &[(Key, String)]) -> Vec<&str> {
        out.iter().map(|(_, l)| l.as_str()).collect()
    }

    #[test]
    fn lays_out_everything_within_budget() {
        let tree = vec![item(0, "A", vec![item(1, "B", vec![])]), item(2, "C", vec![])];
        let (out, cut) = layout(&tree, 1000);
        assert!(!cut);
        assert_eq!(texts(&out), vec!["[0] A", "  [1] B", "[2] C"]);
    }

    #[test]
    fn shares_the_budget_between_siblings() {
        let rows = |base: u32| (0..200).map(|i| item(base + i, &format!("Row {}", "x".repeat(20)), vec![])).collect();
        let tree = vec![item(1000, "Sidebar", rows(0)), item(2000, "Content", rows(300)), item(3000, "Footer", vec![])];
        let (out, cut) = layout(&tree, 4000);
        assert!(cut);
        let total: usize = out.iter().map(|(_, l)| l.len() + 1).sum();
        assert!(total <= 4000 + CUT_NOTE, "{total}");
        let lines = texts(&out);
        assert!(lines.contains(&"[3000] Footer"), "a later sibling is not starved");
        let count = |r: std::ops::Range<u32>| out.iter().filter(|(k, _)| matches!(k, Key::Element(i) if r.contains(i))).count();
        let (sidebar, content) = (count(0..200), count(300..500));
        assert!(sidebar > 20 && content > 20, "{sidebar} {content}");
        assert!(out
            .iter()
            .any(|(k, l)| *k == Key::Note(1000, u32::MAX) && l.ends_with("more not shown; the observation size limit was reached")));
        assert!(out.iter().any(|(k, _)| *k == Key::Note(2000, u32::MAX)));
    }

    #[test]
    fn stays_within_budget_on_wide_deep_trees() {
        let tree: Vec<Item> = (0..300)
            .map(|i| {
                let leaves: Vec<Item> = (0..20)
                    .map(|j| {
                        let mut deep: Vec<Item> =
                            (0..20).map(|k| item(100_000 + i * 400 + j * 20 + k, &"z".repeat(30 + k as usize), vec![])).collect();
                        deep.push(Item::leaf(Key::Note(10_000 + i * 20 + j, 0), "… 12345 more offscreen; scroll to reveal".into()));
                        Item { key: Key::Element(10_000 + i * 20 + j), text: "Row".into(), kids: deep }
                    })
                    .collect();
                Item { key: Key::Element(i), text: format!("Section {i}"), kids: leaves }
            })
            .collect();
        for budget in [300, 2_000, 20_000, 60_000] {
            let (out, cut) = layout(&tree, budget);
            let total: usize = out.iter().map(|(_, l)| l.len() + 1).sum();
            assert!(cut);
            assert!(total <= budget, "budget {budget}: {total}");
            assert!(out.iter().any(|(k, _)| matches!(k, Key::Note(_, u32::MAX))));
        }
    }

    #[test]
    fn keeps_a_prefix_when_even_single_lines_do_not_fit() {
        let tree: Vec<Item> = (0..50).map(|i| item(i, &"y".repeat(40), vec![])).collect();
        let (out, cut) = layout(&tree, 500);
        assert!(cut);
        assert_eq!(out.first().unwrap().0, Key::Element(0));
        let (key, last) = out.last().unwrap();
        assert_eq!(*key, Key::Note(ROOT, u32::MAX));
        assert!(last.starts_with(&format!("… {} more", 50 - (out.len() - 1))));
    }

    #[test]
    fn writes_headings_as_markdown() {
        let mut h = props("AXHeading");
        h.title = Some("Getting started".into());
        h.value = Some("2".into());
        assert_eq!(h.describe().0, "## Getting started");
        h.actions = vec!["AXPress".into()];
        assert_eq!(h.describe().0, "## Getting started");
        let mut bare = props("AXHeading");
        bare.value = Some("2".into());
        assert!(bare.folds_text());
        assert_eq!(bare.describe(), ("Heading".into(), false), "no text: folded away");
    }

    #[test]
    fn writes_web_list_items_as_bullets() {
        let mut list = props("AXList");
        list.subrole = Some("AXContentList".into());
        assert!(list.content_list());
        let mut item = props("AXGroup");
        item.list_item = true;
        assert!(item.folds_text());
        assert_eq!(item.describe(), ("-".into(), true), "item with structured children");
        item.title = Some("Milk".into());
        assert_eq!(item.describe().0, "- Milk");
        let mut link = props("AXLink");
        link.list_item = true;
        link.title = Some("Docs".into());
        assert_eq!(link.describe().0, "Link \"Docs\"", "non-group items keep their role");
    }

    fn props(role: &str) -> Props {
        Props { role: role.into(), ..Default::default() }
    }

    #[test]
    fn describes_richer_element_state() {
        let mut field = props("AXTextField");
        field.subrole = Some("AXSearchField".into());
        field.label = Some("Search mail".into());
        field.placeholder = Some("Search".into());
        field.settable = true;
        field.focused = true;
        assert_eq!(field.describe(), ("TextField:SearchField \"Search mail\" placeholder \"Search\" [focused settable]".into(), true));

        let mut link = props("AXLink");
        link.title = Some("Docs".into());
        link.url = Some("https://example.com/docs".into());
        link.actions = vec!["AXPress".into()];
        assert_eq!(link.describe().0, "Link \"Docs\" url \"https://example.com/docs\"");

        let mut check = props("AXCheckBox");
        check.title = Some("Remember me".into());
        check.value = Some("1".into());
        assert_eq!(check.describe().0, "CheckBox \"Remember me\" [checked]");
        check.value = Some("0".into());
        assert_eq!(check.describe().0, "CheckBox \"Remember me\" [unchecked]");

        let mut disclosure = props("AXDisclosureTriangle");
        disclosure.expanded = Some(false);
        disclosure.disabled = true;
        assert_eq!(disclosure.describe(), ("DisclosureTriangle [disabled collapsed]".into(), true));

        let mut window = props("AXWindow");
        window.subrole = Some("AXStandardWindow".into());
        assert_eq!(window.describe(), ("Window".into(), false), "unremarkable containers fold away");
    }

    #[test]
    fn keeps_long_text_values() {
        let mut text = props("AXStaticText");
        text.value = Some("x".repeat(500));
        assert_eq!(text.describe().0.len(), "StaticText = \"\"".len() + 500);
        let mut button = props("AXPopUpButton");
        button.value = Some("y".repeat(500));
        assert!(button.describe().0.ends_with("…\""), "short limit for non-text roles");
    }

    #[test]
    fn placeholder_only_shows_when_empty() {
        let mut field = props("AXTextField");
        field.value = Some("hello".into());
        field.placeholder = Some("Type here".into());
        assert_eq!(field.describe().0, "TextField = \"hello\"");
    }

    #[test]
    fn merges_neighbouring_text_runs() {
        let line = |y: f64| Some(r(0.0, y, 50.0, 20.0));
        let parts: Vec<(String, Option<Rect>)> =
            [("Read the ", 0.0), ("docs", 0.0), (", then ", 0.0), ("Hel", 0.0), ("lo", 0.0), ("Next line", 20.0)]
                .iter()
                .map(|(s, y)| (s.to_string(), line(*y)))
                .collect();
        assert_eq!(merged_text(&parts), "StaticText = \"Read the docs, then Hello⏎Next line\"");
        let mut t = props("AXStaticText");
        t.value = Some("hi".into());
        assert!(t.plain_text());
        t.actions = vec!["AXPress".into()];
        assert!(!t.plain_text(), "actionable text stays its own line");
    }

    fn loc(name: &str) -> Locator {
        let mut p = props("AXButton");
        p.title = Some(name.into());
        Locator::ROOT.child(&p)
    }

    #[test]
    fn locators_follow_role_name_and_ancestry() {
        assert_eq!(loc("OK"), loc("OK"));
        assert_ne!(loc("OK"), loc("Cancel"));
        let mut group = props("AXGroup");
        group.identifier = Some("toolbar".into());
        let mut ok = props("AXButton");
        ok.title = Some("OK".into());
        assert_ne!(Locator::ROOT.child(&group).child(&ok), loc("OK"));
    }

    #[test]
    fn ids_survive_offscreen_pruning() {
        let mut ids: Ids<&str> = Ids::new();
        let a = ids.assign(&"a", 1, loc("a"));
        let b = ids.assign(&"b", 2, loc("b"));
        let mut ids = ids.carry();
        assert_eq!(ids.assign(&"a", 1, loc("a")), a);
        let mut ids = ids.carry();
        let c = ids.assign(&"c", 3, loc("c"));
        let mut ids = ids.carry();
        assert_eq!(ids.assign(&"b", 2, loc("b")), b, "scrolled back: same id");
        assert_eq!(ids.assign(&"c", 3, loc("c")), c);
        assert_eq!(ids.next, 3);
        assert!(ids.seen(&"b", 2) && !ids.seen(&"a", 1), "only this walk counts as seen");
    }

    #[test]
    fn parked_ids_expire() {
        let mut ids: Ids<&str> = Ids::new();
        ids.assign(&"a", 1, loc("a"));
        for _ in 0..=PARK_OBSERVATIONS + 1 {
            ids = ids.carry();
        }
        assert_eq!(ids.assign(&"a", 1, loc("a")), 1, "forgotten after too long");
    }

    #[test]
    fn rebuilt_elements_inherit_ids_by_locator() {
        let mut ids: Ids<&str> = Ids::new();
        let send = ids.assign(&"send-v1", 10, loc("Send"));
        assert!(ids.rebind(|_| true).is_empty(), "nothing to inherit from on the first walk");
        let mut ids = ids.carry();
        let fresh = ids.assign(&"send-v2", 11, loc("Send"));
        assert_eq!(ids.rebind(|e| *e == "send-v1"), HashMap::from([(fresh, send)]), "old object is dead");
        let mut ids = ids.carry();
        assert_eq!(ids.assign(&"send-v2", 11, loc("Send")), send, "the new object is what is remembered");
        let mut ids = ids.carry();
        ids.assign(&"send-v3", 12, loc("Send"));
        assert!(ids.rebind(|_| false).is_empty(), "old object still alive: a second button");
    }

    #[test]
    fn ambiguous_locators_get_new_ids() {
        let mut ids: Ids<&str> = Ids::new();
        let row1 = ids.assign(&"row1", 1, loc("Row"));
        ids.assign(&"row2", 2, loc("Row"));
        let mut ids = ids.carry();
        ids.assign(&"row3", 3, loc("Row"));
        assert!(ids.rebind(|_| true).is_empty(), "two old candidates");
        let mut ids = ids.carry();
        assert_eq!(ids.assign(&"row1", 1, loc("Row")), row1, "same object still matches directly");
    }

    #[test]
    fn one_old_two_new_is_ambiguous() {
        let mut ids: Ids<&str> = Ids::new();
        let send = ids.assign(&"send", 1, loc("Send"));
        let mut ids = ids.carry();
        let a = ids.assign(&"send-a", 2, loc("Send"));
        let b = ids.assign(&"send-b", 3, loc("Send"));
        assert!(ids.rebind(|_| true).is_empty());
        assert!(a != send && b != send);
    }

    #[test]
    fn reused_objects_get_new_ids_when_their_identity_changes() {
        let mut ids: Ids<&str> = Ids::new();
        let original = ids.assign(&"cell", 1, loc("Alice"));
        let mut ids = ids.carry();
        let recycled = ids.assign(&"cell", 1, loc("Bob"));
        assert_ne!(recycled, original);
        assert_eq!(ids.locator(recycled), Some(loc("Bob")));
        let mut ids = ids.carry();
        let parent = Locator::ROOT.child(&props("AXToolbar"));
        let reparented = parent.child(&Props { role: "AXButton".into(), title: Some("Bob".into()), ..Default::default() });
        assert_ne!(ids.assign(&"cell", 1, reparented), recycled);
    }

    #[test]
    fn surviving_duplicate_prevents_rebinding_a_new_object() {
        let mut ids: Ids<&str> = Ids::new();
        let old = ids.assign(&"old", 1, loc("Send"));
        ids.assign(&"survivor", 2, loc("Send"));
        let mut ids = ids.carry();
        ids.assign(&"survivor", 2, loc("Send"));
        let new = ids.assign(&"new", 3, loc("Send"));
        assert_ne!(new, old);
        assert!(ids.rebind(|e| *e == "old").is_empty());
    }

    #[test]
    fn collection_items_never_inherit_ids() {
        let mut row = props("AXRow");
        row.identifier = None;
        let mut reply = props("AXButton");
        reply.title = Some("Reply".into());
        let inside = Locator::ROOT.child(&props("AXTable")).child(&row).child(&reply);
        assert!(!inside.rebindable);
        let mut ids: Ids<&str> = Ids::new();
        ids.assign(&"reply-row1", 1, inside);
        let mut ids = ids.carry();
        ids.assign(&"reply-row11", 2, inside);
        assert!(ids.rebind(|_| true).is_empty());
    }

    #[test]
    fn rebound_lines_count_as_changed() {
        let base: HashMap<Key, String> =
            lines(&[(Key::Element(0), "[0] A"), (Key::Element(1), "[1] B"), (Key::Element(2), "[2] C")]).into_iter().collect();
        let after = lines(&[(Key::Element(0), "[0] A"), (Key::Element(1), "[1] B"), (Key::Element(2), "[2] C")]);
        let out = render(&after, Some(&base), &HashSet::from([1]));
        assert_eq!(out.tree, "~ [1] B\n");
    }

    #[test]
    fn spots_large_regions_with_nothing_readable() {
        let window = r(0.0, 0.0, 1000.0, 800.0);
        assert!(sparse(r(0.0, 80.0, 1000.0, 700.0), window, 0));
        assert!(!sparse(r(0.0, 80.0, 1000.0, 700.0), window, 3));
        assert!(!sparse(r(0.0, 0.0, 100.0, 100.0), window, 0));
    }
}
