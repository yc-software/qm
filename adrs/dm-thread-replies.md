Small ask: could QM replies start new threads inside a 1:1 DM?

Slack DMs do have threads, but right now a reply to a person's DM always posts at the top level, and
passing a thread id back gets rejected with "a DM to a person has no threads". Slack itself is supports
threading on DM channel, and it looks like the layer that actually talks to Slack already forwards
the thread id, so this is probably a trivial change.

Why this would be useful: I keep a few topics going with the assistant in one DM. Every reply goes to
one flat DM channel and the topics interleave. Best I can do now is one message per question, which is a
poor imitation of threads and makes the DM noisier.

The only way QM can do threads in DMs is if I start a thread by replying to a non-thread message.

No strong opinion on whether a threaded DM reply from QM should also send as a top level DM. Maybe agent can decide depending on context?
