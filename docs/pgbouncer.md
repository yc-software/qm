# PostgreSQL transaction pooling

Keep DATABASE_URL pointed at PostgreSQL. Set DATABASE_POOL_URL to a transaction-mode PgBouncer endpoint with the same database and credentials. Set DATABASE_POOL_CA_CERT to the PEM CA certificate for that endpoint to verify its TLS identity independently of the direct database's configured trust.

Ordinary queries and transactions use the pooled endpoint. Session advisory locks and LISTEN subscriptions use separate direct connections. Schema initialization and dynamic migrations use a separate direct migration pool. pg-boss retains its existing direct endpoint, including its notification connection.

DATABASE_POOL_MAX bounds each process's shared query pool (default 10). DATABASE_DIRECT_POOL_MAX bounds its separate shared session pool (default 32). Both accept integers from 1 to 100. Migrations use a shared one-connection pool. Count every process, database and pooler replica when calculating database capacity; PgBouncer limits are per database/user and per pooler process.

Without DATABASE_POOL_URL, queries and sessions use separate pools to the direct database. Stores sharing a URL share the corresponding underlying pool, with reference-counted close. A closed store cannot reopen itself.

Use PgPool.pool() for ordinary transactions and PgPool.sessionPool() only when the PostgreSQL session must remain pinned, such as session locks and subscriptions. Register migrations through the helper; never run session-lock-based migrations through the transaction endpoint. Query-specific timeouts execute inside a transaction using SET LOCAL, preventing timeout state from leaking between PgBouncer borrowers.

Run scripts/test-pgbouncer.sh to create isolated PostgreSQL and TLS-enabled PgBouncer containers and exercise pooling, lock-held writes, timeout cleanup, migration ordering and shutdown races. The fixture uses a single backend connection to verify multiplexing and a single direct session slot to catch connection starvation. The PgBouncer compatibility workflow runs it on every pull request.

Before enabling pooling on a deployment, verify schema initialization, notifications, job scheduling, TLS failures, cross-database access denial and application reconnect behavior. Roll back routing by removing DATABASE_POOL_URL and restarting the application; database contents do not change.
