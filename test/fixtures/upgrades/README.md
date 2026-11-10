# Published upgrade fixture

`0.1.15.sql` is a PostgreSQL 18 dump of an empty database initialized using
`createPostgresSessionStore`, `createPostgresRunStore`,
`createPostgresDirectoryStore`, then `migrateRegisteredPgSchemas` from the immutable
`v0.1.15` tag (`7417aa2a3`). It includes the original migration ledger and checksums.
Test rows are inserted separately by `postgres-published-upgrade.test.ts`.

To regenerate, check out that tag separately, install its locked dependencies, run
those three store constructors and the migration entrypoint against an empty scratch
database, and dump with `pg_dump --no-owner --no-privileges --no-comments --inserts`.
Remove pg_dump's comment lines, psql backslash commands, blank lines and session
settings older servers reject (such as `SET transaction_timeout`, new in PostgreSQL 17;
CI runs PostgreSQL 16); keep SQL and the ledger values intact. Never derive this
fixture from the candidate schema or a production database: that would miss the published-release compatibility boundary.
