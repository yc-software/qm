# Process-memory durability evidence

These historical patch excerpts preserve the implementations behind two non-durability examples. They are evidence only, not changes to the current runtime.

- `error-log.patch` shows the operational error log changing from an unconditional process-local ring buffer to a Postgres-backed log when a database is configured.
- `resolved-config.patch` shows scoped soul, command-policy, egress-policy, and flag settings gaining durable backing and startup hydration instead of living only in process-local maps.

The excerpts include the relevant source, wiring, and startup changes. Source lines are unchanged; unrelated files, commit metadata, and blob hashes are omitted. The patches document historical fixes, not a recommendation to apply them to current code.
