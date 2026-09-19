# Background ownership

A core deployment can transfer background work to another deployment without restarting either HTTP process. Existing runs retain their leases and heartbeats while the old deployment stops accepting background work. The deployment controller uses a shared PostgreSQL record to fence generations and record each process's acknowledgment.

## Enable the capability

Configure every core replica with:

| Variable                    | Requirement                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `BACKGROUND_DEPLOYMENT_ID`  | An immutable identity shared by replicas of one deployment revision, distinct from every other deployment revision.       |
| `DEPLOYMENT_CONTROL_SECRET` | At least 32 characters, distinct from `CORE_SIGNING_SECRET`; distribute only to core and the trusted deployment operator. |
| `CORE_SIGNING_SECRET`       | The normal source request signing secret.                                                                                 |
| `DATABASE_URL`              | The shared PostgreSQL database.                                                                                           |

On ECS, `ECS_CONTAINER_METADATA_URI_V4` supplies the task ARN used to associate process membership with infrastructure termination evidence. A process without task metadata can enroll, but cannot participate in an ECS cohort bootstrap or task retirement.

Installing this capability does not activate the protocol. Until explicit bootstrap, each replica follows `BACKGROUND_WORK_ENABLED`. Upgrade both deployments and verify their exact current task cohort before bootstrapping. Do not fall back to boot-flag mutation after the protocol has been enabled.

## Operator endpoint

`GET /v1/background-work` and `POST /v1/background-work` require both normal source request signing and `Authorization: Bearer <DEPLOYMENT_CONTROL_SECRET>`. Agent capabilities cannot invoke these routes. Portal forwards only those exact methods and path, preserving the supplied credentials.

Status includes `protocol: 1`, the responding process's `deploymentId` and `instanceId`, `enabled`, `generation`, `desiredDeploymentId`, `lastRequestId`, and durable `members`. Every member includes its deployment identity, process identity, task ARN, admission generation, state, readiness, and retirement flag.

To bootstrap, post:

```json
{
  "expectedGeneration": 0,
  "requestId": "ed73d35e-7dfd-49b9-8550-62955df7df7b",
  "desiredDeploymentId": "core:release-a",
  "bootstrapTaskArns": ["exact-task-arn-a", "exact-task-arn-b"]
}
```

The cohort must match all enrolled, nonretired processes exactly. Later transitions omit `bootstrapTaskArns` and increment the generation using the same compare-and-swap contract. Set `desiredDeploymentId` to `null` to pause with no successor.

Use a fresh UUID for each logical mutation and reuse that UUID only when retrying the same payload. After an uncertain response, inspect `lastRequestId`, generation, desired identity, and the affected member records. A matching desired identity alone does not prove that a particular request committed.

## Admission, readiness, and draining

A process records `admitted` before starting background resources. The desired deployment cannot admit while any earlier generation remains admitted. All replicas of the desired deployment may admit; existing per-job claims and leases continue to coordinate work within the deployment.

`ready: true` means activation completed. A deployment operator should wait for every expected current task to have an admitted, ready process at the desired generation before considering activation successful.

`relinquished` acknowledges that the process stopped new claims and closed its Slack ingress. Already admitted turns may still run. Cron polling can resume after rollback while earlier callbacks keep their queue connection and heartbeats. Maintenance callbacks that cannot relinquish safely are joined before acknowledgment.

`drained` means the process's admitted background work has finished. Releasing ownership and making a deployment safe to replace are separate gates. Do not terminate a relinquished but undrained process merely to meet a rollout time target.

Relinquishing requests a handoff from both background workers and admitted synchronous turns. The current tool can finish and commit its result, after which the harness yields instead of starting another model step. The run lease returns to the queue with the handoff counted separately from retry attempts, so repeated deployments do not exhaust a healthy run's retry budget. `BACKGROUND_HANDOFF_GRACE_MS` defaults to 120 seconds. At the deadline, the harness aborts remaining provider work and refuses new tool dispatch. A later shutdown may shorten that deadline; returning leadership creates fresh signals without cancelling the retiring generation's deadline.

Pi resumes a clean native tape with `continue()`, without another user message or interruption note. An interrupted tool result, incomplete legacy transcript, or context rewrite uses the existing hidden recovery note. Committed skill loads restore their files at the recorded paths before continuation, only when the currently authorized skill and pack contents match the recorded fingerprint. Changed or revoked skills fail closed. Other provider adapters honor handoff and deadline signals but retain their existing transcript reconstruction and recovery-note behavior. A tool that exceeds the grace may have an unknown outcome. Reattaching foreground sandbox executions by durable process ID is a separate optimization; this change does not claim exactly-once execution for uncommitted external effects.

Loop fires persist their batch and completed intake, work, and judge outcomes. Recovery resumes the same item attempt and shipping fire key without rerunning completed stages or spending another item attempt. Busy decision leases defer recovery; outputs awaiting confirmation remain reviewable. Cron journals retain the original fire specification and key across handoff or infrastructure failure, including manually fired crons. Completed runs retain a durable delivery-pending marker until their outbox delivery and failure-transcript backfill have been handled. The delivery sweeper retries missed terminal callbacks without waiting for a busy session lease.

Database errors or an expired local validity watchdog fence new local work. They do not establish durable relinquishment or authorize another deployment to bypass an outstanding member.

## Terminated processes

When a process cannot acknowledge, the trusted operator must independently prove that its exact infrastructure task has stopped. It can then post:

```json
{
  "expectedGeneration": 3,
  "requestId": "e59f2af3-1d57-49a4-9453-91a391540c17",
  "terminatedMembers": [{ "instanceId": "exact-process-id", "taskArn": "exact-stopped-task-arn", "generation": 2 }]
}
```

Retirement preserves the ownership generation, updates `lastRequestId`, and marks only the matching members retired and drained. Retired task identities cannot enroll again. An unreachable HTTP endpoint, old heartbeat, or elapsed timeout is not termination evidence.

## Live deployment session check

A ready, active deployment accepts `POST /v1/deployment/live-session` with the
same source signature and distinct deployment bearer credential. The exact body
contains `requestId` (a fresh UUID), `expectedDeploymentId`, `expectedGeneration`,
and `expectedTaskArns` (the exact healthy task cohort). The endpoint rejects
unknown fields, inactive ownership, incomplete readiness, stale generations,
and mismatched membership before starting work.

The check runs the same fixed session command used by the standalone deployment
smoke: a real model reply, persisted turns, generated title, session error log,
session archival, then the configured PostgreSQL catalog checks. The request
cannot select a principal, URL, model, prompt, or command. Model HTTP requests
have a five-minute limit; other HTTP requests and database operations have
30-second limits. These are failure bounds, not a release-duration claim.

The response is newline-delimited JSON with an initial newline and five-second
whitespace heartbeats, followed by one final object containing `ok`, `requestId`,
`deploymentId`, `instanceId`, `taskArn`, and `generation`. A failed result adds a
fixed error code without raw model, database, or credential details. Ownership
and cohort readiness are checked again before success. Heartbeats alone never
prove success; the caller must receive and verify the complete final object.

Request IDs are durably consumed across replicas and cannot be replayed. Each
process permits one check at a time, including its cleanup. Disconnecting the
caller does not cancel the check or release that guard before cleanup finishes.
Singleflight is per process, and durable request IDs prevent replay. Requests with distinct IDs can run concurrently on different replicas. The release workflow serializes its own requests.
An uncertain result must fail the release; do not retry automatically or fall
back to a second canary execution.

## Enrolling an active legacy deployment

Before bootstrap, a controlled process with its legacy boot flag enabled publishes
an enrollment-specific legacy build heartbeat only after its generation-zero
membership is admitted and ready. Older legacy workers then stop claiming new
runs even when both processes use the same image. Controlled processes ignore
legacy supersession results and continue using durable ownership admission.
Inactive, unready, or fenced processes do not publish this compatibility heartbeat;
publishing also stops once durable ownership is enabled.

This bridge preserves the legacy worker drain behavior and its running-turn task
protection. It does not add missing lifecycle controls to older binaries: their
Slack ingress, cron callbacks, and inline HTTP execution can remain active.
Never treat the heartbeat as a deployment relinquishment acknowledgment or as
proof that a legacy task is safe to terminate. Bootstrap still requires explicit
infrastructure proof that every legacy task has retired, including pending tasks.
Do not clear task protection or terminate live turns to finish enrollment.
If enrollment is abandoned, the legacy heartbeat expiry permits older workers
to resume their existing claim loop.

Synchronous turns and manually started cron callbacks are admitted work too. A
paused deployment refuses new synchronous execution while still accepting durable
asynchronous submissions for the active workers. Accepted turns, scheduled
callbacks, and their nested work retain their leases until completion or handoff;
that settlement is part of the deployment's drain acknowledgment. Resuming ownership
restores synchronous admission with a fresh handoff generation.
Task protection also counts admitted foreground work while the process drains.
