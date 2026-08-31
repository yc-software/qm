# Procedural memory: let QM remember how it did something

QM remembers what was said. It does not remember how anything was done. So the same
recurring job gets re-diagnosed from scratch every time: find the file again, run the
same three commands again, discover the same exit code again.

What we would like to add: at the end of a run, take a prompt and the tool calls that
followed it, and store that as a small record. Which files changed, which commands
verified the work, what order, real exit codes. Later, when a prompt looks like one of
those records already answers it, put a short pointer in the system prompt saying where
the fix landed last time.

The reason it is worth doing at the harness level rather than in a skill: the tool calls
and their exit codes are already in `session_entries`. Nothing else has to be captured,
and nothing has to be inferred by a model to get the record. A skill can only tell an
agent a method; this replays work that actually ran and passed.

We have this working against QM already and can share the branch. Rough shape, so you
can tell us if it is the wrong shape before anyone writes more:

- One env flag, off by default. With it off, no hook is registered and the orchestrator
  check short-circuits on an undefined dependency.
- Roughly 30 lines added to existing files (`config.ts`, `wiring.ts`, `orchestrator.ts`,
  `orchestrator/types.ts`), nothing deleted or edited in place. The rest is new files
  under `src/memorable/` and `test/`.
- QM opens no socket. It spawns a local binary; that binary does the network work and
  holds the consent check. Storage lands in QM's own `DATABASE_URL` Postgres, not a
  second store.
- The injected block is treated as untrusted input: envelope-checked, escape-stripped,
  size-capped, dropped whole rather than truncated, and appended outside the prompt-cache
  boundary.

Two things we already know are not free, so they should be part of the decision rather
than a surprise later. Recall sits on the turn's critical path behind a subprocess call
with a 15 second bound. And the relay holds no state, so a long session re-offers its
earlier work at each run end; the binary skips what it has already stored, but that is a
dedupe rather than an absence of the call.

The parts of this that are enforced by code you can read, and the parts that are
enforced by the binary and therefore taken on trust, are separated explicitly in
`docs/procedural-memory.md`, because that is the line we would want drawn if we were
reviewing it.

One account per deployment was the obvious first shape and it is the wrong one. QM is
multi-tenant; a single key means every scope's procedures land in one organization, and
whoever holds that key can read all of them. So each scope can connect its own account
instead, through a device authorization: QM asks the sign-in service for a code, hands the
human a URL, and stores whatever key comes back, encrypted under the same key material the
keychain already uses. QM never sees a password, and it cannot create an account for
someone who has not signed in themselves.

That does add the one outbound call this integration otherwise avoids, to two endpoints
that carry a scope label and an opaque code and nothing else. We think that is the right
trade against a shared credential, but it is the part of this change most obviously open
to argument, so it is called out here rather than buried. A deployment that connects
nobody keeps the single-key behavior and makes no such call.

Happy to cut it down, split it, or move any of it out of core if the answer is that it
does not belong here.
