# Runtime QA: restarts, handover and background sweeps

`scripts/dev/runtime-qa.ts` boots a throwaway two-worker instance and drives the
runtime paths that otherwise only show up by waiting or by deploying: worker crashes,
SIGTERM drain, leader-lease handover, deploy drain between builds, and interval
sweeps. Use it when a change touches `src/runs/`, `src/persistence/leader-lease.ts`,
`src/util/sweeper.ts`, the cron scheduler, or any `createSweeper` caller in
`src/wiring.ts`.

```bash
npm run qa:runtime                    # every scenario
npm run qa:runtime -- crash sigterm   # just these
```

It needs the same environment as a dev instance (`scripts/dev-instance.sh`): a
`DATABASE_URL` pointing at a Postgres server, model provider keys, and a cloud
sandbox backend (`SANDBOX_BACKEND` plus its key). It creates a fresh database on that
server, starts one core with background work disabled and two `src/runs/worker-main.ts`
processes against it, and drops the database at the end. Exit code 0 means every
scenario passed. Each process's log is kept in the temp directory the script prints.

## Scenarios

| Scenario  | What it does | What it asserts |
| --------- | ------------ | --------------- |
| `tick`    | Sends SIGUSR2 to a worker. | Every interval timer in that process ran at once: the deploy-drain heartbeat refreshes well inside its 10 s interval. |
| `lease`   | Finds the worker holding the cron scheduler's leader lease in `pg_locks` and SIGKILLs it. | The other worker holds the lease within seconds; the killed worker is restarted. |
| `crash`   | Starts a turn whose sandbox command sleeps 40 s, SIGKILLs the worker running it, waits out the run lease and forces a sweep tick on the survivor. | The reaper requeues the run, the survivor claims it and the run finishes `done`. |
| `sigterm` | Same turn, but SIGTERM instead. | The worker logs the signal, hands the run back and exits; the other worker reclaims it before the lease would expire and finishes it. |
| `deploy`  | Starts a third worker with a newer build id and forces a tick on the old ones. | The old workers log that a newer build is live and stop claiming; a new turn runs on the new worker. |

## Forcing a sweep now

Every process the script starts loads `scripts/dev/runtime-qa-clock.ts` with
`node --import`. It records each `setInterval` callback, and on SIGUSR2 runs all of
them immediately and logs `[runtime-qa] SIGUSR2 ticked N intervals`. That covers
every `createSweeper` sweep, run heartbeats and the deploy-drain loop without waiting
for their intervals. The preload lives only in `scripts/`; production processes never
load it. To poke a sweep by hand in a run that is still going, send `kill -USR2 <pid>`
to the worker.
