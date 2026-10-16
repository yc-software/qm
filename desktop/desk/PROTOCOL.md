# desk protocol

`desk serve` reads one JSON request per line on stdin and writes one JSON response per line on stdout, in order. Requests run one at a time. Every type is a closed serde type with `deny_unknown_fields`, tagged by `"type"`. Source of truth: `src/protocol.rs`.

## Requests

```
Request  { id: u64, cmd: Command }

Command  = permissions { prompt?: bool = false }
         | apps
         | observe     { app: string, screenshot?: bool = false, diff?: bool = true }
         | act         { app: string, actions: [Action], observe?: bool = true, screenshot?: bool = false, pace?: bool = false, diff?: bool = true }
         | arrived                                           // only as the answer to a pointer reply, with the same id

Action   = click       { target: Target, button?: left|right|middle = left, count?: u8 = 1,
                         modifiers?: [command|shift|option|control], hold_ms?: u32 = 0 }
         | type_text   { text: string }
         | press_key   { key: string, hold_ms?: u32 = 0 }           // a chord such as "cmd+shift+t"
         | scroll      { target?: Target, direction: up|down|left|right, amount?: Amount = { "pages": 1 } }
         | select_text { index: u32, text: string, prefix?: string, suffix?: string,
                         selection?: text|cursor_before|cursor_after = text }
         | drag        { from: Point, to: Point }
         | set_value   { index: u32, value: string }
         | perform     { index: u32, action: string }        // any AX action the element lists, e.g. "ShowMenu", "Increment"
         | raise                                             // bring the app's window to the front (steals focus)
         | wait        { ms: u32 }                            // capped at 10000

Target   = { "index": u32 } | { "point": Point }
Amount   = { "pages": f64 } | { "pixels": u32 }
Point    = { x: f64, y: f64 }
```

`app` matches a running app's name or bundle id, case-insensitive. An installed app that is not running is opened in the background (`open -g`) first. A `press_key` chord is modifiers (`cmd`, `shift`, `opt`/`alt`, `ctrl`) joined by `+` and ending in a key, which is a letter, digit, punctuation, `return`, `tab`, `space`, `delete`, `escape`, `forwarddelete`, `home`, `end`, `pageup`, `pagedown`, arrows (`left` …), or `f1`–`f12`.

Example:

```json
{"id":1,"cmd":{"type":"observe","app":"Calculator"}}
{"id":2,"cmd":{"type":"act","app":"Calculator","actions":[{"type":"click","target":{"index":12}},{"type":"type_text","text":"*3="}]}}
```

## Responses

```
Response { id: u64, reply: Reply }          // id 0 when the line could not be parsed

Reply    = permissions { accessibility: bool, screen_recording: bool, binary: string, help: string }
         | apps        { apps: [AppInfo] }
         | observation { ...Observation }
         | acted       { completed: u32, failure: Failure?, observation: Observation?, observation_failure: Failure? }
         | pointer     { action: u32, point: Point }        // paced act only; point is in global screen points
         | error       { ...Failure }

AppInfo     { name, bundle_id?, pid: i32, active: bool }
Observation { app, bundle_id?, pid, window: string, frame: Rect, elements: u32, truncated: bool,
              diffed: bool, tree: string, removed: [u32], screenshot: Screenshot? }
Rect        { x, y, w, h }                   // global screen points, top-left origin
Screenshot  { png_base64, width, height, pixels_per_point }
Failure     { code: ErrorCode, message: string, action: u32? }   // action = index of the failed action in a batch
ErrorCode   = bad_request | unsupported_platform | permission_missing | app_not_found
            | no_window | bad_index | unknown_key | action_failed
```

## Observation semantics

- The tree covers the app's focused window (else main, else first). One line per kept element:
  `[id] Role "title" (description) = "value" [focused disabled selected settable] <Actions> @x,y wxh`.
  Unlabelled containers are folded away; indentation shows nesting. Capped at 800 elements (`truncated: true`).
- Frames and `point` targets are **window-relative points** (origin = window top-left).
  The screenshot is captured at nominal resolution, so one PNG pixel is about one point; `pixels_per_point` says what it really was.
  Divide PNG pixels by `pixels_per_point` before sending a `point`.
- Observe before acting; absent snapshots are rejected. Ids are stable: an element keeps its id across observations of the same window for as long as it is the same AX object. A different window starts ids again. `index` in actions means this id, from the latest observation of that app.
- With `diff` (the default) and an earlier observation of the same window, `tree` holds only new or changed lines, `removed` lists ids that disappeared and `diffed` is true. Otherwise `tree` is the whole tree.
- After the actions, `act` waits 1 s, then up to 5 s more while the window shows a busy or progress indicator, whether or not it observes.
- A batch stops at the first failed action. `acted.completed` counts what ran; the observation or `observation_failure` comes back without losing the completion count.

## Pacing

With `pace: true`, before each `click`, `scroll` and `drag`, desk writes `pointer` with the request's id, the action's index and the global screen point it is about to use (element centre, window centre for an untargeted scroll, `from` for a drag). It then reads exactly one line, which must be `{"id": <same id>, "cmd": {"type": "arrived"}}`, and only then performs the action. Anything else fails that action with `bad_request`. The QM desktop app uses this to fly its cursor overlay to the point first. Send nothing else while a paced act is running.

## How actions are delivered

- `click` on an index, left button, single: `AXPress` if the element offers it (no pointer, no focus change); otherwise a synthetic click at the element's center.
- Other clicks, `drag`, `scroll`, `type_text`, `press_key`: CGEvents posted to the app's pid (`CGEventPostToPid`). The real pointer does not move and the app is not brought forward. Some apps ignore events while in the background; then send `raise` first.
- `click` holds `modifiers` and keeps the button down for `hold_ms`. `press_key` holds the key for `hold_ms`.
- `scroll` sends pixel wheel events in 120 px steps; a page is 85% of the target element's height (or width), else the window's.
- `select_text` finds `text` in the element's `AXValue` (the occurrence preceded by `prefix` and followed by `suffix`), focuses the element and sets `AXSelectedTextRange` to the text or a caret before or after it.
- `set_value` writes `AXValue`. `perform` runs any listed AX action.

## App access

All installed apps are available subject to macOS permissions. Observation and control require Accessibility; screenshots also require Screen Recording.
