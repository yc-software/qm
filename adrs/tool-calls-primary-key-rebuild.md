# Stop rebuilding the tool_calls primary key on every boot

Looked at this while poking around the run store, following up on #46.

One detail I think makes it worse than the race in that description: `applyDdl` runs each
statement on its own with no wrapping transaction, so the two ALTERs autocommit separately.
That means you don't need a concurrent writer to get stuck at all. If the process dies
between them (OOM, deploy timeout, anything that kills the boot midway) the DROP is already
committed and there's nothing to roll back. Table sits with no PK, the sibling instance
writes duplicates into it freely, and every boot after that fails on the ADD.

The same file already has the pattern for this, which is what makes lines 76-77 stand out.
The migrations above them are already idempotent — the duplicate-running-rows UPDATE matches
nothing once it's run, the rest are IF NOT EXISTS — and both the directory store and the task
store guard their one-time DDL in DO $$ blocks. This is the one pair that never got the same
treatment. Reading the current PK's column list out of pg_constraint and skipping the whole
thing when it already matches would cover the boot cost, and since a DO block is one
transaction the drop and add can't come apart the way they can now.

One thing the guard doesn't solve on its own: a database that's already in the broken state
has duplicate rows in it, so the ADD will keep failing there until they're cleared. Worth
deciding whether the migration should clean those up itself or whether that stays a manual
step, since the two answers have pretty different risk profiles.
