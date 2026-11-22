# Put delivered files on the message, not in a thread under it

Jake from CargoLabs again. We run qm on Fly and use crons to post engineering summaries to a Slack channel for management.

We asked the cron to attach a PDF of the report. It works, but the PDF never lands on the post itself: the text goes up as the channel message, and the file shows up as a reply in a thread underneath it ("1 reply"). Readers see the summary, don't notice the thread, and never find the PDF. For a report meant for people who skim Slack, that's the difference between the attachment existing and not existing.

Looking at `src/slack/deliveries.ts`, this is by design today: the delivery posts the message, takes its `ts` as the root, and `uploadAttachments` uploads every file with that `thread_ts`. The upload helper already accepts an `initial_comment`, but nothing in the delivery path uses it.

What we'd like: when a delivery has both text and attachments, put them together in one top-level message. Slack's `files.uploadV2` with `initial_comment` does exactly that (text on top, file card below, one message). Concretely:

- Text plus one or more files, no thread target: upload the files with the delivery text as `initial_comment`, and skip the separate `chat.postMessage`. That message's `ts` becomes the root for anything that follows.
- Text plus files inside an existing thread: same, but with the existing `thread_ts`, so it stays a single reply.
- Text only, or files only: unchanged.

The footer ("Weekly engineering summary · Settings") would have to ride along in `initial_comment` since a file upload has no blocks. That seems fine for a delivery; the DM-side reply path that streams and edits text in place doesn't need to change.

If there's a reason to keep files out of the root message (message size, the edit-in-place recovery logic keyed on `editRef`, or something else), a `destination.attachFilesToMessage` flag with the current behaviour as default would also work for us.

Happy to test against our live workspace.
