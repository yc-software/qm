# Edge and harness

QM core runs as two services built from one image. They share no memory and call no RPC: everything that crosses between them goes through Postgres.

| Service | Entry | Owns |
| --- | --- | --- |
| Edge | `node src/edge/main.ts` | HTTP API on `PORT`, the public front door (portal, sign-in, web UI) on `PUBLIC_PORT`, Slack surfaces, webhooks |
| Harness | `node src/harness/main.ts` | Claiming and running agent turns, crons, sweeps, the reaper; `/healthz` and `/readyz` on `PORT` |

Code lives in three places. `src/edge/` is only loaded by the edge (`buildEdge`, the HTTP routes, the front door). `src/harness/` is only loaded by the harness (`buildHarness`, the orchestrator, agent harness adapters, the run worker, scheduler, reaper and deploy drain). Everything else under `src/` is the shared library; `buildCore` in `src/wiring.ts` constructs the stores and services both use. ESLint rejects imports from the edge into the harness, from the harness into the edge, and from the library into either.

Restarting the edge drops open HTTP and SSE connections, which clients reopen; turns keep running in the harness. Restarting the harness hands its in-flight turns back to the queue for the next claim. Both run the registered schema migrations at boot under an advisory lock.

## What crosses the seam

| Concern | Written by | Read by | Mechanism |
| --- | --- | --- | --- |
| Turn requests | Edge (`app.turn` enqueues) | Harness worker | `runs` row; `pg_notify('qm_run_available')` wakes idle workers |
| Claim, lease, result | Harness | Edge (`waitRun`, run views) | `runs` row: status, lease, heartbeat, result. An expired lease is requeued by the harness reaper |
| Abort and steer | Edge | Harness turn | `run_signals` rows + `run_signals` channel |
| Live output | Harness | Edge streams to browsers | `run_stream` channel (deltas, reasoning, refresh, sync requests) |
| Session state | Both | Edge streams to browsers | `session_state` channel |
| Loop item events | Both | Edge | `loop_item_events` channel |
| Cron edits | Edge | Harness scheduler | `cron_changed` channel |
| Cron fires, including "run now" | Edge enqueues manual fires; harness schedules the rest | Harness | pg-boss `cron-fire` queue; manual fires carry a `fireKey` and are already logged as running |
| Outbound messages | Harness (agent posts, cron results, approvals) | Edge Slack and web drains | `deliveries` rows + `delivery_enqueued` channel |
| Liveness nudges | Edge | Harness | `harness_nudge` channel: wake the reaper, mark a session engaged |

Channels are only wake-ups. Every reader also polls or reconciles on an interval from the tables, so a missed notification delays work but does not lose it.
