# desk

A small Rust program that lets an agent see and drive Mac apps: list running apps, read a window's accessibility tree as numbered elements (plus an optional screenshot), and run batches of clicks, typing, keys, scrolls and drags. It speaks JSON lines on stdio; see `PROTOCOL.md`. It copies the _shape_ of Codex's Computer Use: AX tree first, indexed targets, events posted to the target pid. No Codex code or prompt text is used.

The QM desktop app bundles the release binary at `QM.app/Contents/Resources/desk` and spawns `desk serve` on first use, so macOS attributes Accessibility and Screen Recording to QM. `npm run package` in `desktop/` builds it with Cargo first.

**Status:** exercised in the signed macOS desktop trial for permission setup, app observation, and Calculator interaction.

## Build and try it alone

```sh
cargo build --release
./target/release/desk permissions --prompt
open -a Calculator
./target/release/desk apps
./target/release/desk observe Calculator --png /tmp/calc.png
./target/release/desk act Calculator '[{"type":"click","target":{"index":12}}]'
```

Run alone, macOS grants permissions to the terminal that launches desk, so switch your terminal on under System Settings > Privacy & Security > Accessibility and Screen Recording, then restart it.

All running apps can be observed and controlled, subject to macOS permissions.

## Platform considerations

- **Background input is experimental.** Desk sends target-only synthetic activation and input without raising the app, but some apps may ignore it. `{"type":"raise"}` is an explicit foreground action. Live Mac verification is still required.
- **Screenshots.** On macOS 14+ they use ScreenCaptureKit's `SCScreenshotManager`. The app's own menus, popovers and sheets in front of the target window are composited in, and the image grows to include any part outside the window, across displays if needed; `frame` says which screen area it covers. macOS 12.3–13 uses `CGWindowListCreateImage` for the main window only; menu/panel composition requires macOS 14+. desk links ScreenCaptureKit, so it needs macOS 12.3 or later. `pixels_per_point` still needs checking on a Retina screen.
- **`_AXUIElementGetWindow`** (private, widely used) maps the AX window to a window id for capture and event targeting.
- **Clipboard.** `paste` replaces the general pasteboard, presses Cmd+V and restores the previous contents only once the focused field visibly contains the pasted text. When it cannot confirm that (canvas or terminal views without readable text, password fields, slow apps), it leaves the pasted text on the clipboard and says so, rather than risk the app pasting the user's clipboard. Clipboard data is available before Cmd+V is sent, so the receiving app does not need a callback from desk to read it.
- **Keyboard layout.** `type_text` reads the current layout with `TISCopyCurrentKeyboardLayoutInputSource` and `UCKeyTranslate` on desk's main thread (TIS calls are main-thread only on recent macOS).
- **Accessibility enablement.** On first observation, desk requests `AXManualAccessibility` and uses `AXEnhancedUserInterface` only if an empty web area still needs it. Prior settings are restored on normal exit.
- **Speed.** Element attributes are read in batches. Actions and settability are cached until that app posts an accessibility notification; frames, values and children are always read fresh. Offscreen pruning and a 6,000-element read cap bound each walk.
- **Universal binary:** `cargo build --release --target aarch64-apple-darwin --target x86_64-apple-darwin`, then `lipo`.
