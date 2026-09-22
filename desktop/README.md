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

Packaging writes a native app for the current platform into `desktop/dist/`, registering the `qm-desktop` URL scheme. Use the packaged app for browser sign-in. The macOS build is an unsigned local prototype, with no automatic updates. It connects to a running server; it does not bundle the QM backend or provide offline agent execution.

## Browser sign-in

When sign-in is needed, the app opens `/auth/desktop` in your default browser. Sign in there as usual, confirm your account, and choose **Open QM Desktop**. The browser returns a two-minute, single-use code bound to the app's proof key and random state. The app redeems it over the instance connection and stores the session in its isolated persistent cookie partition. Closing the app or starting another connection invalidates the pending attempt. The portal must include the desktop sign-in routes; older deployments need an update.

The portal preserves the browser session's identity, original authentication time, and expiration. Redemption uses the existing durable core claim store to prevent replay across portal instances and deployments. The desktop proof key exists only for the disposable, in-progress sign-in attempt and is never sent to the browser. Passwords and identity-provider cookies stay in your browser.

Remote content is sandboxed with no Node.js or preload access. Off-origin links open in your browser. Microphone, camera, and notification permissions are disabled in this prototype.

The welcome screen uses _Becalmed off Halfway Rock_ (Fitz Henry Lane, 1860), sourced from [Ève Bouffard’s QM brand board](https://www.evebouffard.com/qm-brand). [National Gallery of Art collection record](https://www.nga.gov/artworks/76213-becalmed-halfway-rock).
