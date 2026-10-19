use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: u64,
    pub cmd: Command,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Permissions {
        #[serde(default)]
        prompt: bool,
    },
    Apps,
    Observe {
        app: String,
        #[serde(default)]
        screenshot: bool,
        #[serde(default = "yes")]
        diff: bool,
    },
    Act {
        app: String,
        actions: Vec<Action>,
        #[serde(default = "yes")]
        observe: bool,
        #[serde(default)]
        screenshot: bool,
        #[serde(default)]
        pace: bool,
        #[serde(default = "yes")]
        diff: bool,
    },
    Arrived,
}

fn yes() -> bool {
    true
}

fn one() -> u8 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Click {
        target: Target,
        #[serde(default)]
        button: Button,
        #[serde(default = "one")]
        count: u8,
        #[serde(default)]
        modifiers: Vec<Modifier>,
        #[serde(default)]
        hold_ms: u32,
    },
    TypeText {
        text: String,
    },
    Paste {
        text: String,
        #[serde(default)]
        format: PasteFormat,
    },
    PressKey {
        key: String,
        #[serde(default)]
        hold_ms: u32,
    },
    Scroll {
        #[serde(default)]
        target: Option<Target>,
        direction: Direction,
        #[serde(default)]
        amount: Amount,
    },
    SelectText {
        index: u32,
        text: String,
        #[serde(default)]
        prefix: String,
        #[serde(default)]
        suffix: String,
        #[serde(default)]
        selection: Selection,
    },
    Drag {
        from: Point,
        to: Point,
    },
    SetValue {
        index: u32,
        value: String,
        #[serde(default)]
        submit: Option<bool>,
    },
    Perform {
        index: u32,
        action: String,
    },
    Raise,
    Wait {
        ms: u32,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Target {
    Index(u32),
    Point(Point),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Button {
    #[default]
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Modifier {
    Command,
    Shift,
    Option,
    Control,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Amount {
    Pages(f64),
    Pixels(u32),
}

impl Default for Amount {
    fn default() -> Self {
        Amount::Pages(1.0)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PasteFormat {
    #[default]
    Text,
    Markdown,
    Html,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Selection {
    #[default]
    Text,
    CursorBefore,
    CursorAfter,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub id: u64,
    pub reply: Reply,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Reply {
    Permissions { accessibility: bool, screen_recording: bool, binary: String, help: String },
    Apps { apps: Vec<AppInfo> },
    Observation(Observation),
    Acted { completed: u32, failure: Option<Failure>, observation: Option<Observation>, observation_failure: Option<Failure> },
    Pointer { action: u32, point: Point },
    Error(Failure),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppInfo {
    pub name: String,
    pub bundle_id: Option<String>,
    pub pid: i32,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub app: String,
    pub bundle_id: Option<String>,
    pub pid: i32,
    pub window: String,
    pub window_id: u32,
    pub frame: Rect,
    pub elements: u32,
    pub truncated: bool,
    pub diffed: bool,
    pub tree: String,
    pub removed: Vec<u32>,
    pub screenshot: Option<Screenshot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Screenshot {
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
    pub pixels_per_point: f64,
    pub frame: Rect,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Failure {
    pub code: ErrorCode,
    pub message: String,
    pub action: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    BadRequest,
    UnsupportedPlatform,
    PermissionMissing,
    AppNotFound,
    NoWindow,
    BadIndex,
    UnknownKey,
    ActionFailed,
    PasteConflict,
}

impl Failure {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Failure { code, message: message.into(), action: None }
    }
}
