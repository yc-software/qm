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
         | paste       { text: string, format?: text|markdown|html = text }
         | press_key   { key: string, hold_ms?: u32 = 0 }           // a chord such as "cmd+shift+t"
         | scroll      { target?: Target, direction: up|down|left|right, amount?: Amount = { "pages": 1 } }
         | select_text { index: u32, text: string, prefix?: string, suffix?: string,
                         selection?: text|cursor_before|cursor_after = text }
         | drag        { from: Point, to: Point }
         | set_value   { index: u32, value: string, submit?: bool }
         | perform     { index: u32, action: string }        // any AX action the element lists, e.g. "ShowMenu", "Increment"
         | raise                                             // bring the app's window to the front (steals focus)
         | wait        { ms: u32 }                            // capped at 10000

Target   = { "index": u32 } | { "point": Point }
Amount   = { "pages": f64 } | { "pixels": u32 }
Point    = { x: f64, y: f64 }
```

`app` matches a running app's name or bundle id, case-insensitive, or its full application path (resolved through symlinks). Ambiguous matches return the candidate PIDs, bundle IDs and paths without sending input. An installed app that is not running is opened in the background (`open -g`) first. A `press_key` chord is modifiers (`cmd`, `shift`, `opt`/`alt`, `ctrl`) joined by `+` and ending in a key, which is a letter, digit, punctuation, `return`, `tab`, `space`, `delete`, `escape`, `forwarddelete`, `home`, `end`, `pageup`, `pagedown`, arrows (`left` …), or `f1`–`f20`. Keypad names such as `KP_Enter`, `KP_0` and `KP_Add`, X11 punctuation names such as `exclam`, and side-specific modifier names such as `Control_R` are also accepted.

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
Observation { app, bundle_id?, pid, window: string, window_id: u32, frame: Rect, elements: u32, truncated: bool,
              diffed: bool, tree: string, removed: [u32], screenshot: Screenshot? }
Rect        { x, y, w, h }                   // global screen points, top-left origin
Screenshot  { png_base64, width, height, pixels_per_point, frame: Rect }   // frame = global screen points the image covers
Failure     { code: ErrorCode, message: string, action: u32? }   // action = index of the failed action in a batch
ErrorCode   = bad_request | unsupported_platform | permission_missing | app_not_found
            | no_window | bad_index | unknown_key | action_failed | paste_conflict
```

## Observation semantics

- The tree covers the visible part of the app's focused window (else main, else first). One line per kept element:
  `[id] Role:Subrole "name" (description) = "value" placeholder "…" url "…" [focused disabled selected checked|unchecked|mixed expanded|collapsed settable] <Actions>`.
  The name is `AXTitle`, else the text of the element's `AXTitleUIElement` label. Checkbox, radio and switch values are
  shown as `checked`/`unchecked`/`mixed`, not `= "1"`. Text roles keep values up to 1,000 characters, others 120.
  Unlabelled containers are folded away; indentation shows nesting. A heading reads `[id] ## text` (Markdown, by its
  level). A heading or link with no title whose children are only plain text takes that text as its name, and the
  text lines are not repeated under it. Items of a web list (`AXList` with subrole `AXContentList`) that are plain
  groups read `[id] - text`, or `[id] -` with their content nested under it.
- Neighbouring plain static texts (no actions, not focused or selected) merge into one `StaticText` line carrying the
  first one's id; a fragment that starts on a lower line than the previous one is joined with `⏎`, others verbatim.
- Open menus (context menus and menu-bar menus) and the app's other sheets, popovers, drawers and dialog or floating
  windows come first, under `Open menus and other windows of this app:`, followed by `Window "title":` and the
  window's tree. Without any, the tree starts directly.
- After the tree, `Focus: [id]` names the app's focused element (or describes it when it is not in the tree), and
  `Selected text: "…"` quotes its selection when there is one.
- Children outside the window, or outside an enclosing `AXScrollArea` or `AXWebArea`, are not walked. Each container
  that had some gets one note line, `… N more offscreen; scroll to reveal`. Zero-size frames count as offscreen unless
  strictly inside the visible area (Chromium pins scrolled-out elements to the viewport edge with zero height).
- The tree is capped at about 60,000 characters of lines and 6,000 AX elements read (`truncated: true`). The characters
  are shared fairly: siblings that fit are shown whole, and the rest split what is left evenly, so one long list cannot
  starve the containers after it. Every container cut short gets `… N more not shown; the observation size limit was
reached`.
- A web area, or a childless group or scroll area, covering at least 40% of the window with nothing readable inside gets
  `… nothing readable inside; the app may draw this area itself (for example a canvas). Use the screenshot and point targets`.
- Each element's attributes are read in one batched call; actions and settability only for elements that are walked.
  While desk is subscribed to an app's accessibility notifications, it reuses each element's actions and settability
  from earlier observations until the app posts any notification, which clears them all; without a subscription it
  reads them fresh every time.
  On the first observation of an app desk sets `AXManualAccessibility` and waits up to 1 s for an empty web area to
  fill. Only if that attribute is refused and a web area is still empty does it set `AXEnhancedUserInterface` and wait
  again. Whichever it turned on is set back to off when desk exits; attributes that were already on are left alone.
- `point` targets are **window-relative points** (origin = window top-left).
  On macOS 14+, the screenshot covers its own `frame`: the window plus the app's menus, popovers and sheets in front of it, so it can reach past the window. On macOS 12.3–13 it covers only the main window.
  It is captured at nominal resolution, so one PNG pixel is about one point; `pixels_per_point` says what it really was.
  To send a `point`, divide PNG pixels by `pixels_per_point`, then add the screenshot `frame` origin minus the observation `frame` origin. `window_id` identifies the observed native window. The JavaScript API requires a screenshot before point actions and invalidates its image mapping when a later observation reports a different process, window ID or frame. This check is shared across JavaScript App objects by the observed bundle ID (or app name when no bundle ID exists), so using a different selector cannot reuse stale coordinates. Multiple instances sharing that identity may require a new screenshot after observing another instance.
- Observe before acting; absent snapshots are rejected. Ids are stable: an element keeps its id across observations of the same window for as long as it is the same AX object, including while it is scrolled out of view for up to 30 observations. When the app replaces an object (a re-render), the new one inherits the id if exactly one old object and exactly one new object have the same role, subrole, identifier, name and ancestry, the old object is gone, and neither sits inside a list, table, outline, row or cell. An inherited id's line is always marked `~` in a diff. Acting on an id whose object is gone looks for that single replacement first and fails with `bad_index` if there is none. A different window starts ids again. `index` in actions means this id, from the latest observation of that app.
- With `diff` (the default) and an earlier observation of the same window, `tree` holds only new lines, prefixed `+ `, and changed ones, prefixed `~ `; `removed` lists ids that disappeared and `diffed` is true. When more than 60% of the lines are new or changed, a selection/state/note line disappears, or no earlier observation is available, `tree` is the whole tree, unprefixed, and `diffed` is false.
- `act` returns as soon as its actions are sent. The next observation of that app (`observe`, or `act` with `observe`) first waits for that app's accessibility notifications to go quiet (other apps' notifications do not count): at least 200 ms after the last action, then until 300 ms pass with no notification, at most 2 s after the action. If desk could not subscribe to the app's notifications it waits until 1 s has passed instead. Then it waits up to 5 s more while the window shows a busy or progress indicator. An observation with no action since the previous one does not wait. A batch of only `wait` actions does not count as an action.
- A batch stops at the first failed action. `acted.completed` counts what ran; the observation or `observation_failure` comes back without losing the completion count.

## Pacing

With `pace: true`, before each `click`, `scroll` and `drag`, desk writes `pointer` with the request's id, the action's index and the global screen point it is about to use (the element's clickable point, window centre for an untargeted scroll, `from` for a drag). It then reads exactly one line, which must be `{"id": <same id>, "cmd": {"type": "arrived"}}`, and only then performs the action. Anything else fails that action with `bad_request`. The QM desktop app uses this to fly its cursor overlay to the point first. Send nothing else while a paced act is running.

## How actions are delivered

- `click` on an index, left button, single: menu items always use `AXPress`. Elements inside a web area, rows, cells and list items, and elements without `AXPress` get a synthetic click, because `AXPress` there fires no pointer events, focus change or selection. Other elements use `AXPress` (no pointer, no focus change).
- The point of a synthetic click on an index is found by hit-testing the centre and four inner points of the element's visible part and taking the first where the app reports the element or one of its descendants (or, failing that, one of its ancestors or no answer). If every point hits something else, the action fails with `action_failed` naming what covers it.
- A synthetic-click index target that is offscreen (outside the window or an enclosing scroll or web area) is first sent `AXScrollToVisible`; if it is still offscreen 250 ms later, the action fails with `action_failed`.
- Other clicks, `drag`, `scroll`, `type_text`, `press_key`, and the Cmd+V of `paste`: CGEvents posted to the app's pid (`CGEventPostToPid`). The real pointer does not move. Desk sends target-only synthetic activation before background input; this does not deliberately change the frontmost app. Some apps may still ignore these events.
- Background input protects the observed key-focus lease: a process-notification tap suppresses the target's focus-taken notification, releases the matching lease by its theft ID, and suppresses its paired return notification. External key events misdirected to that target during the lease are forwarded once to the prior owner; agent events and unrelated input pass unchanged. Missing private API support, tap failure, nested leases, or a genuine foreground change stop the batch. This is not a timer that reactivates the previous app, and it does not prevent arbitrary application window reordering.
- Pointer events at a point where the app's own hit test finds an Open or Save panel drawn by `com.apple.appkit.xpc.openAndSavePanelService` inside the app's window go to that panel's process and window. Keystrokes, `paste` and `set_value` submission go to that process when the app's focused element belongs to it.
- While the app has a menu open (a context or pop-up menu, or a menu-bar menu), only `click` on a menu item by index works (with `AXPress`); other clicks and every action that would send pointer events fail with `action_failed`. Press Escape to close the menu.
- Between actions of one `act`, except next to a `wait`, desk waits until the app has sent no accessibility notification (focus, value, selection, menu, window, layout, creation) for 120 ms, at least 60 ms and at most 800 ms, so a later action sees the UI an earlier one opened.
- `type_text` sends each character with the key code and Shift/Option flags that type it on the user's current keyboard layout, plus the character itself. `\n`, `\r\n` and `\r` press Return and `\t` presses Tab. Characters the layout cannot type (emoji, other scripts, dead-key accents) are sent as text on key code 0.
- `paste` puts the text on the general pasteboard (plain text, plus HTML for `markdown` and `html`; markdown is converted to HTML), marked `org.nspasteboard.TransientType` so clipboard managers skip it, and presses Cmd+V. The data is written eagerly before the shortcut, so the receiving app can read it without waiting for a callback from desk. A clipboard read is not taken as proof of delivery. desk restores the previous clipboard only after the app's focused field shows its previous text with the pasted text (the plain text, or for `markdown` and `html` also the text of the HTML) inserted exactly at the selection; only line endings and non-breaking spaces are normalised. Otherwise (the field never shows the text within 3 s, the focused field's text cannot be read, a failure while sending Cmd+V, or cancellation or interruption after it) the action fails with `action_failed`, desk's text stays on the clipboard and the previous clipboard is not restored, so a late paste cannot insert the user's clipboard. If the clipboard changes for another reason meanwhile, desk keeps that new content and fails with `paste_conflict`, because the app may have pasted it instead. If the clipboard holds a concealed item (`org.nspasteboard.ConcealedType`, which password managers use), `paste` fails without touching the clipboard.
- `click` holds `modifiers` and keeps the button down for `hold_ms`. `press_key` holds the key for `hold_ms`.
- `scroll` by pages first scrolls the enclosing scroll area (of the target element, or at the target point or window centre) without pointer events: its `AXScroll…ByPage` action for whole pages, else by moving its scroll bar by 85% of the visible part per page. Otherwise, and for `pixels`, it sends pixel wheel events in 120 px steps; a page is 85% of the target element's height (or width), else the window's.
- `select_text` requires nonempty `text` with exactly one match in the element's `AXValue` after filtering by `prefix` and `suffix`. It checks that `AXSelectedTextRange` is writable before focusing the element, verifies focus and unchanged text, then selects the match or places a caret before or after it. Unsupported selection, ambiguous matches and failed focus return an error without writing a selection.
- `set_value` fails unless `AXValue` is settable. It writes the value as the type the element holds: a number (`true`/`false` count as 1/0) or boolean, else a string; elements holding a date are refused. Text fields are focused first, and if a text field still shows its old value afterwards the action fails. Only with `submit: true` desk then sends `AXConfirm`, or Return when the element lacks it. `perform` validates its name against the element’s current AX actions before running it. The primary `Press` action is omitted from observation text because `click` already invokes it; secondary actions remain listed.

## App access

All installed apps are available subject to macOS permissions. Observation and control require Accessibility; screenshots also require Screen Recording.
