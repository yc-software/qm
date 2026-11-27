# Database

- `db/schema.sql` is the current schema. Read it to see the database as it is now. It is
  generated; never edit it by hand.
- `db/migrations/*.sql` are changes made since, applied in name order.
- `db/vector.sql` adds the optional pgvector tables the first time semantic memory uses them.

A new database loads `schema.sql`, which records the migrations it already contains, so they
are skipped. An existing database applies the migrations it has not recorded yet. Both happen
at startup.

`schema-replaces.txt` lists the migrations that built the schema before this layout. A
database that recorded all of them adopts `schema.sql` without running it. One that recorded
only some must first be upgraded with the last release that shipped them.

## Adding a change

1. Add `db/migrations/NNNN-what-it-does.sql`, numbered after the last file.
2. Run `npm run db:schema` with `DATABASE_URL` pointing at a Postgres 16 server you can
   create databases on. It loads `schema.sql` into a scratch database, applies the new
   migrations and rewrites `schema.sql`. If your `pg_dump` is not version 16, set `PG_DUMP`
   to one that is, for example `PG_DUMP="docker exec -i <container> pg_dump"`.
3. Commit both files. CI regenerates `schema.sql` and fails if it differs.

Never edit a migration once it has merged; add another. A file that is exactly one
`CREATE INDEX CONCURRENTLY IF NOT EXISTS` runs outside a transaction, and a failed build is
dropped and rebuilt on the next start. Set `lock_timeout` with `SET LOCAL` when altering a
busy table.

A file whose first line is `-- qm:batched` rewrites data a slice at a time. It runs again and
again, each run in its own transaction, until its last statement selects `false AS more`; the
last run records it. Keep its progress in tables so a stopped run resumes, and make each run
safe to repeat. It holds its own lock while it runs, not the one other migrations wait on.
