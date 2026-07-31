# The cron fire log grows without bound, and every fire rewrites all of it

Follow-up to the durable-map ADR — same corner of the code, different disease. This one is
about `fireLog` on the cron record.

`recordFire` appends an entry per fire and nothing ever trims it. Not archive, not disable,
not any sweeper — the only way the log shrinks is deleting the cron. Silent fires append
too: a polling cron that says `[no-update]` every minute still gains an entry per minute,
forever. And because the log lives inside the cron's own jsonb row, appending entry N
means reading and rewriting all N entries: `recordFire` parses the full row under
`FOR UPDATE`, dedupes and re-sorts the whole array in JS, and writes the whole thing back.

I measured it with the repo's own `createCronStore` on `createPostgresMapFactory`, after
recording 6,670 fires with 2,000-char replies — that's one every-minute cron after ~4.6
days:

```
row state: 6,670 entries, 14.5 MB raw JSON (TOAST compresses my filler to ~280 KB)

recordFire (one more entry)          median 229 ms
crons.get (fireJob / claimSlot read) median  50 ms
crons.list cold (reconcile path)     median  90 ms
crons.list cached (structuredClone)  median  23 ms
WAL written per recordFire           ~300 KB
```

recordFire on a young cron is 1–2 ms, so that's ~150× at day five, and the cost is linear
in the entry count — the total work is quadratic in the life of the cron. My filler text
compresses ~50×; realistic varied replies won't, so the on-disk row and per-fire WAL for a
real deployment sit closer to the raw numbers than the compressed ones.

The reads multiply it. In job-queue mode each fire does `crons.get` (full row), `claimSlot`
(full row under `FOR UPDATE`, full rewrite), `recordFire` (again), and `enqueueNext`'s
`crons.get` (again) — call it four full-log round-trips per fire. `reconcile` calls
`crons.list()` about every 5 seconds, and since every fire anywhere bumps the map's version
counter, that's routinely a cold read: every cron's full log, parsed, plus a
`structuredClone` of the lot on every call even when cached. None of these readers wants
the log — `nextSlot` needs three timestamps; the API's `runs` view slices the tail
(`fireLog.slice(-limit)`).

Left alone it also has an end state: a single jsonb value has hard size limits in Postgres,
and once the row is too big to write, `recordFire` throws on every fire from then on. The
schedule survives that (same path as the other ADR: tick logs an error, idempotency absorbs
the retry) but the log is permanently unwritable and every fire still pays the failed
multi-MB attempt first.

Issue 46 already treats this class as a bug — "`tool_calls` has no retention — nothing
deletes from it" — and I think `fireLog` is the same disease in a worse home, because a
retention-less _table_ at least appends in O(1), while a retention-less _jsonb array_ makes
every writer and every reader pay for the whole history.

What I'd actually do: cap it in `recordFire` — keep the newest N entries (50? 100?) with a
`slice(-N)` after the existing sort. One line, and it bounds the row, the per-fire cost, the
WAL, and the reconcile scan all at once. It also matches what the system already believes
about this data: the fire input tells the agent the log shows "how prior fires went", the
reply inside an entry is already clamped to 2,000 chars for exactly this reason, and every
consumer reads the tail. If someone truly wants full fire history it wants to be an
append-only table with retention — but I'd take the cap first; it's the version that
shrinks the system.

Not a security issue — nothing crosses a scope. It's a slow-burn operational one: nothing
looks wrong in week one, and by month three every active cron is quietly the biggest row in
the database and the scheduler is spending its ticks re-parsing history nobody reads.
