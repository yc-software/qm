# Mid-run steer drops attachments

I opened #48 about this — writing it up here too, per CONTRIBUTING.

If you send a message while a run is still going, only the text reaches the run.
`app-turn.ts` builds the steer out of `req.text` alone, and the run reads only `s.text`. The
full request does ride along on the signal, but nothing looks at it until orphan replay,
which only happens after the run has already died.

So a message with a caption and a file steers the caption, and the file is never seen.

The one that actually bit me is the version with no caption. `routeWake` calls that
`drop: "empty-mid-turn"`, but `app-turn` still returns `steered: true`, so the Slack handler
stands down and posts nothing — and by then the file has already been downloaded and staged.
Nothing happens after that. No reply, ever.

It's easy to hit because it's the shape the agent itself asks for: it says "send me the
screenshot", you paste the image while it's still working, and that's the end of it.

`test/wake-steering.test.ts` only covers the whitespace-only case with no attachments, so
none of this trips anything today.

I don't have a strong opinion on the fix. Carrying the attachments through on the signal
looks natural since the request is already attached to it, but you'd know better whether a
live run can absorb them mid-turn. At a minimum, a message that has attachments shouldn't be
counted as empty.
