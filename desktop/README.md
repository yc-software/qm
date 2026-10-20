# QM desktop

An Electron client for an existing QM web deployment. The welcome screen connects to your workspace; the app then runs the same web UI with its own persistent session.

```sh
cd desktop
npm ci
npm start
```

Enter your QM web URL on first launch. HTTPS is required except for localhost development. Change instances with **QM → Change Instance…** (`Cmd+,` on macOS). You can also set `QM_DESKTOP_URL` when starting the app.

```sh
QM_DESKTOP_URL=http://localhost:3000 npm start
npm run package
```

Packaging writes a native app for the current platform into `desktop/dist/`, registering the `qm-desktop` URL scheme. Use the packaged app for browser sign-in. The macOS build is an unsigned local prototype, without automatic updates in development. It connects to a running server; it does not bundle the QM backend or provide offline agent execution.

## Browser sign-in

When sign-in is needed, the app opens `/auth/desktop` in your default browser. Sign in there as usual, confirm your account, and choose **Open QM Desktop**. The browser returns a two-minute, single-use code bound to the app's proof key and random state. The app redeems it over the instance connection and stores the session in its isolated persistent cookie partition. Closing the app or starting another connection cancels unfinished sign-in requests; it does not sign out sessions whose cookie exchange already completed. The portal must include the desktop sign-in routes; older deployments need an update.

The portal preserves the browser session's identity, original authentication time, and expiration. Redemption uses the existing durable core claim store to prevent replay across portal instances and deployments. The desktop proof key exists only for the disposable, in-progress sign-in attempt and is never sent to the browser. Passwords and identity-provider cookies stay in your browser.

On macOS, the window controls sit inside the sidebar header. With a single session open, drag its title bar to move the window; tab dragging remains available in multi-pane layouts. Hold Command to reveal shortcuts for the first nine sessions in expanded sidebar groups, then press 1–9 to switch. Windows and Linux use Control. Collapsed groups and a hidden sidebar are excluded.

Remote content is sandboxed with no Node.js access. An isolated desktop preload adds window styling and session shortcuts with one sender-validated operation for opening a same-instance setup page in the browser. Off-origin links open in your browser. Microphone, camera, and notification permissions are disabled in this prototype.

The welcome screen uses _Becalmed off Halfway Rock_ (Fitz Henry Lane, 1860), sourced from [Ève Bouffard’s QM brand board](https://www.evebouffard.com/qm-brand). [National Gallery of Art collection record](https://www.nga.gov/artworks/76213-becalmed-halfway-rock).

## Connection setup and previews

Slack installation and personal app authorization start in your browser before QM creates the connection attempt. Finish setup there, then return to the desktop app; it refreshes connection status on focus. Settings contains both personal Slack linking and the app picker. This keeps provider callbacks, installation POSTs, cookies, and tab-local authorization state in one browser.

Same-instance links opened in a new tab use a separate sandboxed window sharing the instance session. External links open in the browser. View → Back and Forward navigate the focused window. Closing the main window closes its previews.

## Computer use

On macOS the app can see and drive running Mac apps through [`desk`](desk/README.md), a Rust helper bundled at `QM.app/Contents/Resources/desk`. `npm run package` builds it with Cargo first, so install Rust (`rustup`) on the packaging Mac. Because QM launches it, grant **QM** Accessibility (and Screen Recording for screenshots) in System Settings > Privacy & Security, then relaunch QM. In development, `npm start` uses `desk/target/release/desk`; override with `QM_DESK_BIN`.

The workspace preload exposes `window.qmDesktop.computer.call`. The `desktop` tool accepts JavaScript with top-level await and preserves bindings within the initiating turn. A hidden, sandboxed Electron renderer evaluates code without Node.js or network access and forwards computer API requests to `desk serve` one at a time (see `desk/PROTOCOL.md`). Each request uses the originating turn's owner and absolute call deadline. The same sender check as browser handoff applies. All installed apps are available subject to macOS permissions.

The first call returns API documentation. Start with `var app = await computer.getApp("Calculator")`, then use `app.getAXState()`, `app.click(id)`, or `app.getScreenshot()` in later calls. Accessibility observations default to changes since the previous state; `{disableDiffing: true}` returns the full tree. Await every operation; background callbacks persist within the turn and should not schedule computer actions. Reset, cancellation, and timeout destroy JavaScript state. Results contain at most four resized JPEG screenshots within an 800 KB base64 budget.

Before each click, scroll or drag, a transparent click-through overlay flies an agent cursor to the target point and desk waits for it to land. Set `QM_DESK_CURSOR=0` to skip the overlay.

## Mac release

`npm run package` builds the unsigned local app. For a signed and notarized build, install a Developer ID Application certificate in the Mac keychain and sign in to that team in Xcode Settings → Accounts. Then run:

```sh
QM_MAC_SIGN_IDENTITY="Developer ID Application: Your Organization (TEAMID)" npm run package:release
```

The release command signs the app, submits an archive using the signed-in Xcode account, waits for notarization, and verifies the stapled ticket and Gatekeeper assessment. It produces the notarized ZIP, SHA256SUMS.txt, and RELEASES.json in desktop/dist. Credentials and certificates stay outside this repository. Builds target the current machine's architecture.

Packaged Apple Silicon builds check the desktop-only feed on startup and every five minutes. Updates download in the background and restart QM automatically without a confirmation dialog. Restart waits while a composer has a pending submission, file processing, staged attachments, or an open paste editor. Older servers without the update-readiness handshake defer automatic restarts until their web UI is upgraded. Open non-web previews, such as PDFs, also defer restart until closed. Interaction pauses briefly while the app saves restart state. Before restarting, QM flushes saved text drafts and pane layout, saves the current instance page, and flushes its persistent browser session. Server-side agent work continues during restart. QM → Check for Updates triggers an immediate check. Development, Intel, Windows, and Linux builds do not use this Mac feed. Versions 0.1.0 and 0.1.1 require one manual upgrade to receive the updater.

Publish the verified ZIP and checksum as desktop-v<VERSION>, then upload RELEASES.json to the dedicated desktop-updates GitHub release using gh release upload desktop-updates desktop/dist/RELEASES.json --clobber --repo yc-software/qm. Update the feed only after the versioned download is published and verified. The feed uses Squirrel.Mac's static JSON format and points to the immutable versioned ZIP; backend and dependency releases never enter it.

`npm run test:electron` exercises actual Electron preview windows, POST popups, session sharing, sandboxing, and browser handoff against a temporary local server.

New chats started in desktop have a stable `desktop` tool. Send a request such as “Use Calculator to compute 17 × 23.” Only human-initiated turns submitted from the desktop app can execute it. Automatic openers, background automation, delegated turns, and retries cannot use computer access. The app must stay open and connected for that turn; switching chats is fine. Continuing the chat in a browser retains the tool definition but returns an unavailable result if it is called. Existing browser-created chats do not gain computer access: start a new desktop chat. Chats from the earlier computer-use trial retain their old tool schema and must also be replaced with a new chat.

Computer requests are bound to the submitting desktop turn. Only one turn can control the computer at a time; other turns receive a busy result until it finishes. A closed window, disconnected stream, stopped run, or helper deadline cancels native execution; reconnecting does not replay actions. After an interrupted action, observe the app before retrying because it may have partially completed. Screenshots return as image content, without base64 duplicated in model-visible text.

### Guided computer access

On macOS, missing computer permissions open a local setup window before the workspace.
It checks Accessibility and Screen Recording automatically, opens their System Settings
panes, and provides the installed app as a draggable icon with a Finder fallback.
Choose **Enable computer access** to request the native prompts, then enable this app
in both settings lists. **Continue to workspace** becomes available when both checks
pass and restarts the native helper to pick up the grants. **Not now** skips setup;
**QM → Computer Access…** reopens it. A permission failure during a task reopens setup
and reports the failure without replaying the action.

For local macOS builds, set `QM_MAC_SIGN_IDENTITY` to a consistent signing certificate
to keep the application identity stable across updates. Ad-hoc builds can leave stale
macOS permission entries: remove the old entry, add the current app, and enable it again.
