# Privacy policy for QM on iOS

Last updated: 14 November 2026

This policy describes what the QM app for iPhone and iPad does with your data. It is written about the app's own behaviour, so it holds for any unmodified build of the app from this repository. "The publisher" means whoever distributed the copy you installed.

## Publisher

The build on the App Store is published by Y Combinator, and this is its privacy policy. Questions about it can be raised as an issue at <https://github.com/yc-software/qm/issues>.

QM is open source, so anyone can build and distribute the app. If you got your copy from someone else, they are its publisher: this section does not apply to them, and they are responsible for their own policy.

## The short version

- The app has no analytics, advertising, or tracking, and the publisher receives none of your content.
- What you write and attach goes to the QM workspace whose address you enter. Live voice goes to the voice service that workspace uses. The few other connections the app makes are listed below.
- Whoever operates that workspace decides how your data is stored and used on it. Ask them about retention, access, and deletion.

## The app and your workspace are separate

QM is software an organization runs for itself. The app is a client for it. When you choose a workspace and sign in, the app works against that workspace's address.

Publishing the app is not the same as operating a workspace. The publisher has no access to your workspace unless it is also the organization that runs it, and this policy does not describe what any workspace does with data once it arrives. The workspace's operator is responsible for that.

## What the app sends to your workspace

Only what you do in the app:

- **Sign-in.** You sign in on your workspace's own sign-in page, shown in a system browser sheet. The app receives a session token from the workspace. It never sees your password.
- **Conversations.** The messages you send, and the actions you take on conversations, approvals, and other items in the workspace.
- **Attachments.** Files, photos, and pasted images you choose to attach, including photos you take with the camera from inside the app. The photo picker gives the app only the items you select, not your library.
- **Live voice.** While a Talk to QM call is active, your microphone audio is sent over an encrypted connection to the voice service your workspace is configured to use. Muting stops the audio. Ending the call or leaving the app stops the call.

Dictation is different from live voice. The composer microphone transcribes speech on your device with Apple's Speech framework. Dictation audio is never uploaded, and the temporary recording is deleted once it has been transcribed, or when you cancel, leave the conversation, or leave the app.

## Other connections the app makes

- **Images your workspace points to.** Profile pictures of people in shared conversations are downloaded from the addresses your workspace supplies, and logos in the app catalog are downloaded from `logos.composio.dev`. These requests carry none of your content or account details; like any download, the host sees your IP address.
- **Pages you open.** Signing in, connecting an app, and tapping a link open a web page in a system browser sheet or in your browser. Those sites have their own privacy policies.

## What the app keeps on your device

- **Settings.** The workspace address, your appearance and theme, and list preferences.
- **Your session.** The session token, in the device keychain, marked as available on this device only.
- **Unsent work.** Drafts and attachments you have not sent yet, in the app's own storage and excluded from device backups.

Conversation history is loaded from your workspace when you open it. Files you preview are held in temporary storage while you view them.

Signing out, or changing workspace, deletes the session token and the drafts for that account from the device.

## Permissions

The app asks for a permission only when you use the feature that needs it:

- **Microphone:** dictation and live voice.
- **Speech Recognition:** dictation.
- **Camera:** taking a photo to attach.

You can withdraw any of these in the iOS Settings app. The app does not ask for your location, contacts, calendars, or full photo library.

## What the publisher receives

Nothing from the app itself. The app contains no analytics or crash-reporting service and sends nothing to its publisher.

Apple provides app developers with crash reports and usage statistics from people who have chosen to share them with developers in their device settings. That sharing is controlled by you and governed by Apple's privacy policy.

## Third parties

The app does not sell or share your data. It contains no third-party advertising or analytics code. The open-source libraries it includes are listed in [`QM/Resources/ThirdPartyNotices.txt`](./QM/Resources/ThirdPartyNotices.txt) and run only on your device or as part of a call you start.

## Children

QM is a tool for work. It is not directed to children.

## Your choices

- Withdraw microphone, speech recognition, or camera access in iOS Settings.
- Sign out to remove your session and drafts from the device.
- For a copy of, or the deletion of, data held by a workspace, contact that workspace's operator.

## Changes

Changes to this policy are made in this file. Its history in this repository shows what changed and when.

## Contact

Questions about this policy go to the publisher of your copy; for the App Store build, see [Publisher](#publisher). To report a security problem in the app, follow [`SECURITY.md`](../SECURITY.md) and do not open a public issue.
