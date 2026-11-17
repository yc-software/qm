# Migrations

`db/baseline.sql` is the schema every database starts from. Each later change is a new file
here, named so it sorts after the previous one (`0001-add-thing.sql`). Startup applies
pending files in name order, each in its own transaction, and records it in
`qm_schema_migrations`.

- Never edit a file once it has merged; add another.
- A file that is exactly one `CREATE INDEX CONCURRENTLY IF NOT EXISTS` runs outside a
  transaction; a failed build is dropped and rebuilt on the next start.
- Set `lock_timeout` with `SET LOCAL` when altering a busy table.
