# PostgreSQL connection ownership

Ordinary queries, including Absurd workflow claims and checkpoints, share the process-wide query pool for a database URL. When DATABASE_POOL_URL is configured, these queries use transaction pooling. Workflow shutdown releases its pool reference without closing other stores' connections. The vendored Absurd schema and queue migrations run through the shared migration runner. See [durable workflows](durable-workflows.md) for ownership and cutover requirements.

Notification subscriptions share one direct connection per database URL per process. Session state, ledger events, run signals, and run streaming register their channels on that connection. Closing a consumer removes its subscription; the last unsubscribe closes the listener. Reconnection restores the active channel set before notifying consumers to resynchronize from durable state. Notifications remain wake-up hints, not durable storage.

Session advisory locks and leader leases continue to use direct session connections. Query pool sizes, PgBouncer backend limits, and database placement are unchanged. Multiple processes and separate company databases still have separate listeners and pools.

Validate notification delivery, reconnection, and teardown with test/postgres-listener.test.ts against a disposable DATABASE_URL. The race and queue lifecycle tests run with the standard module-mocking test command. scripts/test-pgbouncer.sh exercises queue startup, execution, shutdown, and restart through a one-backend transaction pool.

This removes three notification connections when all four channels are in use. Absurd shares the ordinary query pool. Active queries, session locks, deployment overlap, and pooler replicas still determine server usage.
