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

- **Events posted to a background app.** `CGEventPostToPid` clicks and keys might be ignored, or land in the wrong window, when the app isn't frontmost. If nothing happens, add `{"type":"raise"}` first; that does take focus.
- **Screenshots.** They use `CGWindowListCreateImage`, deprecated in macOS 14 in favour of ScreenCaptureKit. On macOS 15+ it may return nothing or prompt monthly. `pixels_per_point` also needs checking on a Retina screen.
- **`_AXUIElementGetWindow`** (private, widely used) maps the AX window to a window id for capture and event targeting.
- **`AXManualAccessibility`** is set on each app so Electron and Chrome apps expose their trees.
- **Speed.** Each element costs about 7 AX round trips, so big windows may take seconds. The 800-element cap bounds this.
- **Universal binary:** `cargo build --release --target aarch64-apple-darwin --target x86_64-apple-darwin`, then `lipo`.
