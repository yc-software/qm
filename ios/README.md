# QM for iOS

An iOS 18+ SwiftUI client for QM deployments. Product screens, navigation, editors, conversation controls, and voice controls are native. There is no embedded WebKit product UI. It uses the existing authenticated APIs and runs no agent or model on the phone. External authentication uses ASWebAuthenticationSession; external links and user-created web apps open in the browser.

## Run

Install Xcode and XcodeGen. Create an ignored `Local.xcconfig` next to this file:

```xcconfig
QM_BASE_URL = https:/$()/qm.example.com
QM_BUNDLE_ID = org.example.qm
DEVELOPMENT_TEAM = YOUR_TEAM_ID
```

The `$()` preserves the double slash in an xcconfig value. Keep deployment URLs and signing settings in this ignored file. Debug builds also accept an HTTP loopback origin for simulator development. Release builds require HTTPS. The app accepts an origin only, without a path, query, or embedded credentials.

```sh
cd ios
xcodegen generate
open QM.xcodeproj
```

Choose the QM scheme and an iPhone simulator or a provisioned device, then Run. Simulator builds use local signing; do not disable code signing, because the session is stored in Keychain. The generated project is ignored; edit `project.yml` instead. A build without a configured URL offers workspace selection before sign-in.

## Portal sign-in

Sign-in uses the portal’s existing desktop authentication endpoints, also used by Electron. No mobile-login deployment flag is required on a portal that already supports `/auth/desktop` and `/auth/desktop/redeem`.

The app opens `/auth/desktop` in `ASWebAuthenticationSession` with a random state and S256 PKCE challenge. After ordinary portal login and confirmation, `qm-desktop://auth/callback` receives a signed code valid for up to two minutes. The app validates the callback and posts the code, verifier, and state as form data to `/auth/desktop/redeem`. It stores the returned session cookie only after checking the response and confirming that sign-in is still active. No bearer credential is placed in the callback URL. No core signing secret or model credential is shipped in the app. The portal confirmation currently calls the client “QM Desktop.”

Provider-connection callbacks still use the separate `qm` scheme and require the accompanying mobile connection support on the server. This is independent of signing into QM.

The native client stores its portal session in device-only Keychain and persists renewal cookies. Sign-out removes that local session and the signed-in account's drafts. Like the current web cookie, this is not a separately revocable device credential; per-device revocation and a longer-lived refresh-token design are outside this initial slice. Changing the portal session signing secret invalidates these sessions along with web sessions.

## Verify

Backend checks run from the repository root:

```sh
npm run typecheck
npm run lint
npx tsc --noEmit -p plugins/portal/tsconfig.json
npm test --prefix plugins/portal
```

From this directory, select an installed simulator from `xcrun simctl list devices available`:

```sh
xcodebuild -project QM.xcodeproj -scheme QM \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
xcrun swift-format lint --strict --recursive QM QMTests
```

Tests cover code replay, wrong verifier, org/expiry boundaries, durable-store failure, route opt-in, native response races after sign-out, UTF-16 stream offsets, transcript delivery normalization, and recovery of an unsent first conversation.

For local end-to-end QA, use a portal with desktop authentication support and this repository's dev-instance launcher with the web surface, a real model and Postgres. Set `QM_BASE_URL` to the printed localhost portal origin. The dev portal's existing local authentication bypass supplies a test identity; production uses the configured identity provider. Verify sign-in, a new task, background/foreground resume, persisted history after relaunch, and signing out. Test production SSO separately before inviting users.

## Feature coverage

Native screens cover sign-in, conversation lists and drafts, new personal conversations, streaming/history, stop and permission-aware approval grants, queued-message editing/withdrawal/steering, per-turn model/harness/effort/fast-mode settings, skill completion, message search, pin/rename/archive/restore, file selection, formatted Markdown and QuickLook previews with sharing. Home includes Active/Waiting/Archived filters; forks identify their origin and separate inherited history. Transcript notices preserve approval decisions, Slack revisions and linked subagent updates.

Browse routes to SwiftUI Projects, Files, Crons, Webhooks, Keychain, Apps, Memory, Skills, and Settings. Inbox, Calendar, and Loops follow server permissions. Organization administration stays in the web Settings pages. Search opens a native transcript at its matching message. Conversation tools provide native snapshot sharing, forks, linked conversations, scoped resources, activity and background process output. Calendar matches the current web placeholder.

Native Markdown images use authenticated workspace file requests with an 8 MiB transfer limit and bounded thumbnails. External block images appear as links, and external inline images use placeholders; they do not load automatically. Oversized or unsupported images can still be opened through the existing file preview or an external browser.

## Live voice

Browse → Talk to QM opens native SwiftUI controls backed by the WebRTC iOS SDK. Web conversations also offer Talk to QM in their menu, keeping spoken tasks in that conversation. Voice and dictation are available to everyone signed in when the server has `OPENAI_API_KEY`. Never put a provider key in the iOS build settings.

The voice frontend uses `gpt-live-1` with `gpt-5.6-terra` Responses delegation. Completed structured `ask_qm` calls submit to the existing authenticated QM turn API; captions cannot execute tasks. QM keeps its configured runtime, tools, permissions, and approval flow. Task records are durable; live captions are temporary and the provider session uses `store: false`.

The native audio track starts only when the user starts a call. Mute stops microphone transmission; End conversation and backgrounding stop the call. Already submitted QM tasks continue. Session creation is limited durably to six per person per hour; the client ends calls after 20 minutes. These are usage controls, not a server-enforced spending cap.

Unit tests cover the voice protocol and call lifecycle. Native audio, physical-device routing and production SSO need manual checks on a device.

Choose a workspace from the welcome screen or use Change workspace in the account menu. The app remembers the selected HTTPS origin; Debug builds also accept local HTTP addresses. Changing origins signs out and clears local drafts for the previous account. Equivalent origins preserve the existing session.

The bundled privacy manifest declares app-local UserDefaults access (`CA92.1`) for workspace and appearance settings, following [Apple’s required-reason API guidance](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api). This API declaration does not replace App Store Connect privacy answers: those must describe the target deployment’s handling of identity, chat content, attachments, and voice data before distribution.

While visible and active, Home refreshes conversation state every five seconds; read-only transcripts refresh at the same interval. Writable conversations retain their run stream and queued-input reconciliation. Refresh tasks stop when their view disappears or the app becomes inactive.

An unsigned device-target archive can be built for compilation and packaging checks before an Apple team is available:

```sh
xcodebuild -project QM.xcodeproj -scheme QM \
  -destination 'generic/platform=iOS' -archivePath /tmp/QM.xcarchive \
  archive CODE_SIGNING_ALLOWED=NO QM_BASE_URL=
```

This archive opens workspace selection and is not installable or distributable until rebuilt with the intended team, bundle registration, and provisioning. Keep normal signing enabled for simulator QA and all device installation builds.

## Dictation

The composer microphone records locally with AVAudioRecorder. Finishing uploads the recording to the authenticated `/api/dictation` endpoint and appends the transcript to the editable draft. It never sends a chat message automatically. Interrupted or time-limited recordings wait for an explicit Transcribe action. Failed uploads can be retried; cancellation, leaving the conversation, or backgrounding deletes the temporary audio.

Both the native client and server depend on a `SpeechToTextProvider` interface. The server selects the implementation with `WEB_UI_STT_PROVIDER` (currently `openai`) and its model with `WEB_UI_STT_MODEL` (default `gpt-transcribe`). Enable it with `WEB_UI_STT_ENABLED=1`, `WEB_UI_STT_USERS`, and server-only `OPENAI_API_KEY`. The enabled flag and user list fall back to their live-voice equivalents when omitted. No OpenAI credentials or model identifiers are bundled in iOS.

Requests require the existing signed portal identity, reject impersonation, and use durable per-user limits of 60 recordings per hour. Recordings are bounded to five minutes on iOS and 10 MiB on the server.
