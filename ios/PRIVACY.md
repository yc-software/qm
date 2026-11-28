# Privacy policy for QM on iOS

Last updated: 27 November 2026

This policy describes what the QM app for iPhone and iPad does with your data. It is written about the app's own behaviour, so it holds for any unmodified build of the app from this repository. "The publisher" means whoever distributed the copy you installed.

## Publisher

The build on the App Store is published by Y Combinator, and this is its privacy policy. Questions about it can be raised as an issue at <https://github.com/yc-software/qm/issues>; do not put personal information in a public issue.

QM is open source, so anyone can build and distribute the app. If you got your copy from someone else, they are its publisher, and their policy replaces this section with their own details.

## The short version

- The app has no analytics, advertising, or tracking, and its publisher receives none of your content.
- What you write and attach goes to your QM workspace: the one you choose, or the one your copy was set up with.
- Your workspace sends your messages, attachments, and content it reads from apps you connect to a third-party AI provider, such as Anthropic or OpenAI, to answer you. See [AI providers](#ai-providers).
- A live voice call also connects your device directly to OpenAI, which provides the voice.
- The app asks for your agreement before any of this happens, and you can withdraw it in Settings.
- Whoever operates your workspace decides how your data is stored and used on it. Ask them about retention, access, and deletion.

## The app and your workspace are separate

QM is software an organization runs for itself. The app is a client for it. When you sign in, the app works against that workspace's address.

Publishing the app is not the same as operating a workspace. The publisher has no access to your workspace unless it is also the organization that runs it, and this policy does not describe what any workspace does with data once it arrives. The workspace's operator is responsible for that.

## What the app sends to your workspace

What you do in the app, plus your device's time zone and what iOS adds to any web request, such as your language preference:

- **Sign-in.** You sign in on your workspace's own sign-in page, shown in a system browser sheet. The app receives a session token from the workspace. It never sees the password you sign in with.
- **Conversations.** The messages you send, and the actions you take on conversations, approvals, and other items in the workspace.
- **Attachments.** Files, photos, videos, and pasted images you choose to attach, including photos you take with the camera from inside the app. The photo picker gives the app only the items you select, not your library. Photos and videos from your library may be converted to a widely supported format and can include metadata embedded in them, such as where they were taken.
- **Credentials you enter.** API keys, authorization codes, and other secrets you type into the app's keychain and settings screens are sent to your workspace.
- **Time zone.** Sent with each message, each voice task, and each request for suggested activities.

## AI providers

QM answers you with AI models run by third-party companies. After you sign in to a workspace, and before you can use QM there, the app shows what is shared and with whom and asks you to agree. Until you agree, the app does not open your conversations or send anything for QM to work on. The app asks again for each workspace you switch to, since its operator may use other providers. You can review or withdraw your agreement at any time in **Settings > AI data sharing**; withdrawing closes QM in that workspace until you agree again.

- **What is sent:** the messages you send, including questions about inbox items and spoken requests; the files, photos, and videos you attach; and content QM reads on your behalf from apps you connect to your workspace, such as Slack, Gmail, or GitHub, while working on your request. Conversation history and the results of QM's work are sent along so the model has context.
- **How:** the app sends your messages and attachments to your workspace, and the workspace sends them to the provider of the model the conversation uses. The app does not send them to a model provider itself. Live voice is the exception, described below.
- **Who receives it:** the provider of the model the conversation uses, which the model picker shows: **Anthropic** for Claude models and **OpenAI** for GPT models. A workspace's operator can also set up other providers, such as OpenRouter, and those appear in the picker under their own names. Live voice audio goes to **OpenAI**.
- **What it is used for:** to generate replies, carry out the tasks you ask for, transcribe and voice live calls, and, in your workspace, to search and summarize your past work. It is not used by the app or its publisher for advertising, tracking, or profiling.

Each provider handles the data under its own terms and privacy policy, and under the agreement the workspace's operator has with it.

## Live voice

While a Talk to QM call is active, the app connects directly to OpenAI, the voice service QM uses, over an encrypted connection:

- Your microphone audio is sent to OpenAI. Muting stops your audio.
- The app sends OpenAI the text of QM's progress and results so they can be read aloud. This continues while you are muted.
- OpenAI returns a transcript of what you said, which the app submits to your workspace as a task.

Ending the call or leaving the app ends the connection.

## Dictation

Dictation is different from live voice. The composer microphone transcribes speech on your device with Apple's Speech framework, and dictation audio is never uploaded. The text becomes part of your message, and is sent to your workspace and its AI provider only when you send it.

The temporary recording is deleted once it has been transcribed, or when you cancel, open another conversation or page, or leave the app. If transcription fails, the recording is kept so you can retry, until you cancel. If the app is closed unexpectedly while a recording exists, the protected temporary file remains until iOS clears temporary storage.

## Other connections the app makes

- **Images your workspace points to.** Profile pictures of people in shared conversations are downloaded from the addresses your workspace supplies, and logos in the app catalog are downloaded from `logos.composio.dev`. These requests do not carry your session or your content. The host sees your IP address, the app and iOS version, and which image was requested, and iOS may keep a cookie the host sets.
- **Pages you open.** Signing in, connecting an app, and tapping a link open a web page in a system browser sheet or in your browser. Those sites have their own privacy policies. The sign-in sheet shares cookies with Safari, and signing out of the app does not clear them.

## What the app keeps on your device

- **Settings.** The workspace address, your appearance and theme, and list preferences. These stay until you delete the app.
- **Your session.** The session token, in the device keychain, marked as available on this device only.
- **Unsent work.** Drafts and attachments you have not sent yet, in the app's own storage, protected while the device is locked and excluded from device backups.
- **Temporary files.** Copies of attachments being prepared, files you are previewing, and dictation recordings, in temporary storage.
- **Downloaded images.** iOS may cache the profile pictures and logos described above.
- **Diagnostics.** Error messages are written to the device's system log. They are not sent anywhere by the app.

Conversation history is loaded from your workspace when you open it and is not saved by the app. iOS itself keeps a snapshot of the app's last screen for the app switcher, and text you copy goes to the system clipboard.

Signing out, or changing workspace, deletes the session token and the drafts for that account from the device. Two exceptions: if your session had already expired, or if you change workspace while the app cannot reach the old one, the drafts stay until you sign in to that workspace and sign out again, or delete the app. Signing out removes the token from the device; it does not end the session on the workspace. iOS can retain the keychain entry of a deleted app, so sign out before deleting the app.

## Permissions

The app asks for a permission only when you first use the feature that needs it:

- **Microphone:** dictation, transcribed on your device, and live voice, which sends your audio to OpenAI.
- **Speech Recognition:** dictation.
- **Camera:** taking a photo to attach.

You can withdraw any of these in the iOS Settings app. The app does not ask for your location, contacts, calendars, or full photo library.

## What the publisher receives

Nothing from the app itself. The app contains no analytics or crash-reporting service and sends nothing to its publisher.

Apple provides app developers with crash reports and usage statistics from people who have chosen to share them with developers in their device settings, and with crash reports and feedback from TestFlight builds. That is handled by Apple and governed by Apple's privacy policy.

## Third parties

The app does not sell your data or share it for advertising, and it contains no third-party advertising or analytics code. It sends data only to your workspace, to OpenAI during a live voice call, and to the image hosts listed above; pages you open are loaded by the browser. Your workspace shares your content with AI providers as described in [AI providers](#ai-providers).

The app is built with the open-source libraries declared in [`project.yml`](./project.yml). They run only on your device or as part of a call you start.

## Children

QM is a tool for work. It is not directed to children.

## Your choices

- Withdraw your agreement to share data with AI providers in the app's Settings, under AI data sharing.
- Withdraw microphone, speech recognition, or camera access in iOS Settings.
- Sign out to remove your session and drafts from the device.
- For a copy of, or the deletion of, data held by a workspace, contact that workspace's operator.

## Changes

Changes to this policy are made in this file. Its history in this repository shows what changed and when.

## Contact

Questions about this policy go to the publisher of your copy; for the App Store build, see [Publisher](#publisher). To report a security problem in the app, follow [`SECURITY.md`](../SECURITY.md) and do not open a public issue.
