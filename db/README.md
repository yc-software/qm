# Database

- `db/schema.sql` is the current schema. Read it to see the database as it is now. It is
  generated; never edit it by hand.
- `db/migrations/*.sql` are the changes that produced it, applied in name order.
  `0000-baseline.sql` is the schema as of the move to this layout.
- `db/vector.sql` adds the optional pgvector tables the first time semantic memory uses them.

A new database loads `schema.sql`, which records the migrations it already contains. An
existing database applies the migrations it has not recorded yet. Both happen at startup.

## Adding a change

1. Add `db/migrations/NNNN-what-it-does.sql`, numbered after the last file.
2. Run `npm run db:schema` with `DATABASE_URL` pointing at a Postgres 16 server you can
   create databases on. It builds a scratch database from the migrations and rewrites
   `db/schema.sql`. If your `pg_dump` is not version 16, set `PG_DUMP` to one that is, for
   example `PG_DUMP="docker exec -i <container> pg_dump"`.
3. Commit both files. CI regenerates `schema.sql` and fails if it differs.

Never edit a migration once it has merged; add another. A file that is exactly one
`CREATE INDEX CONCURRENTLY IF NOT EXISTS` runs outside a transaction, and a failed build is
dropped and rebuilt on the next start. Set `lock_timeout` with `SET LOCAL` when altering a
busy table.
