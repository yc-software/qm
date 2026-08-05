# Let assistant replies thread inside a 1:1 DM

Slack DMs have threads. QM won't use them.

`reachNow` in `src/api/app-messaging.ts` rejects `threadTs` unless the destination is a channel or a
group DM. A DM to a person returns `bad_request` with "a DM to a person has no threads". That isn't
true of Slack. `chat.postMessage` accepts `thread_ts` on an IM channel and the client renders the
reply thread normally. `src/slack/delivery.ts` already passes `thread_ts` through, so the plumbing
below the API is fine. The check above it is the only thing in the way.

Why I care. I have several topics open with the assistant in one DM. Every answer lands top-level,
so the DM is one flat column with the topics interleaved. The workaround today is one message per
question, which approximates threads badly and makes the DM noisier rather than less.

What I'd like: allow `threadTs` when the destination is a person-DM, and let the `post` action reply
in the thread of the message it's answering in a DM the same way it does in a channel. Keeping the
error for cases Slack can't thread is fine.

One thing to decide that I don't have an opinion on: whether a threaded DM reply should also
broadcast to the DM top level. In a channel `threadOnly` controls that. For a DM I'd guess default
to no broadcast, but you'd know better whether that hides replies from people who don't expand
threads.
