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

## Mac release

`npm run package` builds the unsigned local app. For a signed and notarized build, install a Developer ID Application certificate in the Mac keychain and sign in to that team in Xcode Settings → Accounts. Then run:

```sh
QM_MAC_SIGN_IDENTITY="Developer ID Application: Your Organization (TEAMID)" npm run package:release
```

The release command signs the app, submits an archive using the signed-in Xcode account, waits for notarization, and verifies the stapled ticket and Gatekeeper assessment. It produces the notarized ZIP, SHA256SUMS.txt, and RELEASES.json in desktop/dist. Credentials and certificates stay outside this repository. Builds target the current machine's architecture.

Packaged Apple Silicon builds check the desktop-only feed on startup and every five minutes. Updates download in the background and restart QM automatically without a confirmation dialog. Restart waits while a composer has a pending submission, file processing, staged attachments, or an open paste editor. Older servers without the update-readiness handshake defer automatic restarts until their web UI is upgraded. Before restarting, QM flushes saved text drafts and pane layout, saves the current instance page, and flushes its persistent browser session. Server-side agent work continues during restart. QM → Check for Updates triggers an immediate check. Development, Intel, Windows, and Linux builds do not use this Mac feed. Versions 0.1.0 and 0.1.1 require one manual upgrade to receive the updater.

Publish the verified ZIP and checksum as desktop-v<VERSION>, then upload RELEASES.json to the dedicated desktop-updates GitHub release using gh release upload desktop-updates desktop/dist/RELEASES.json --clobber --repo yc-software/qm. Update the feed only after the versioned download is published and verified. The feed uses Squirrel.Mac's static JSON format and points to the immutable versioned ZIP; backend and dependency releases never enter it.

`npm run test:electron` exercises actual Electron preview windows, POST popups, session sharing, sandboxing, and browser handoff against a temporary local server.
