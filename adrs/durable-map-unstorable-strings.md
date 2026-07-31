# The durable map accepts strings Postgres can't store

`createMemoryMap` and `createPostgresMap` don't agree on what a valid value is. The memory
map takes any JS string; the Postgres map writes `JSON.stringify(value)` into a `jsonb`
column, and Postgres rejects two things that are perfectly legal in a JS string: a NUL, and
an unpaired surrogate.

I ran this against a real Postgres 18 with the repo's own `createPostgresMapFactory`:

```
memory map:    put title with NUL          -> OK
postgres map:  put title with NUL          -> unsupported Unicode escape sequence
postgres map:  merge title with NUL        -> unsupported Unicode escape sequence
postgres map:  put lone surrogate          -> invalid input syntax for type json
                                              (22P02, "Unicode low surrogate must follow a high surrogate")
```

So every artifact store behind `artifactMap(...)` — crons, projects, skills, monitors,
souls, keychain asks, the rest — can be handed a value that works in every test and throws
in production.

The part that makes this more than a theoretical edge case is that qm manufactures those
strings itself, out of clean input. Several clamps cut with a bare `.slice()`, and cutting
mid-emoji strands half a surrogate pair:

- `cleanName` in `project-store.ts` (`.slice(0, 200)`) → `projects`
- `normalizeTitle` in `cron-store.ts` (`.slice(0, 79)`) → `crons`
- `truncate` in `scheduler.ts` (`.slice(0, maxChars - 3)`) → the cron fire log

The project one is the easiest to see. Name a project 200+ characters with an emoji sitting
across character 200 and nothing about the input is unusual:

```
project name length: 216 (cleanName clamps at 200)
memory map (every test):     OK -> stored name ends with "bcd\ud83d"
postgres map (production):   THREW -> invalid input syntax for type json
```

The cron one I chased through the scheduler because I wanted to know how bad it gets. A
fire whose reply is over 2000 characters with an emoji on the clamp boundary throws out of
`recordFire`, the exception unwinds through `fireDue` and `tick`, the sweeper logs it, and
`markFired` never runs. Next tick the cron is still due and `fire()` runs again — but
`runTrigger`'s idempotency key catches it, so the turn isn't repeated and the schedule
advances. Net damage is one lost fire-log entry and a `[scheduler] tick failed` line. Less
bad than I expected, and worth saying out loud since the ordering there is doing real work.

You already treat both characters as unstorable in four other places — `jsonbSafeStringify`
for session payloads, the explicit "the store cannot persist" checks in
`deployment-layer-store.ts`, the NUL strip the session store does in SQL on its read path,
`toWellFormed()` in `security-screener.ts`. What's missing is the one layer they'd all flow
through anyway. `headSlice`/`tailSlice` are already in `util/text.ts` for exactly the
clamp problem, with a test pinning the invariant — the three call sites above just don't use
them.

Two things I'd suggest, and I think the second matters more than the first:

1. Normalize in the map's serializer rather than at call sites, so a store can't be added
   later that forgets. `.toWellFormed()` plus the NUL strip you already do is enough.
2. Make the two maps agree. Right now the memory map is more permissive than the real one,
   which is why a suite this thorough can't see any of this. CI does run the Postgres map
   tests (`core-postgres` / `npm run test:pg`), so a case in `postgres-map.test.ts` would
   actually run — it just isn't there today. If both maps went through one serializer, one
   test would cover every artifact store you ever add.

Not filing this as a security issue — nothing crosses a scope and the failures are loud and
recoverable. It's a production-only shape that the test suite is structurally unable to
reach, which is the part I'd want to know about.
