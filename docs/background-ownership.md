# Background ownership

Production runs two core deployments (blue and green) against one PostgreSQL database. Exactly one of them may run background work at a time: Slack ingress, run claims, cron callbacks, and periodic maintenance. A single shared owner record names that deployment. Every core process polls the record and admits background work only while it names the process's own deployment.

## Enable the capability

Configure every core replica with:

| Variable                    | Requirement                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `BACKGROUND_DEPLOYMENT_ID`  | An immutable identity shared by replicas of one deployment revision, distinct from every other deployment revision.       |
| `DEPLOYMENT_CONTROL_SECRET` | At least 32 characters, distinct from `CORE_SIGNING_SECRET`; distribute only to core and the trusted deployment operator. |
| `CORE_SIGNING_SECRET`       | The normal source request signing secret.                                                                                 |
| `DATABASE_URL`              | The shared PostgreSQL database.                                                                                           |

With `BACKGROUND_DEPLOYMENT_ID` set, `BACKGROUND_WORK_ENABLED` is ignored: the owner record alone decides. A fresh database has no owner, so no deployment runs background work until an operator sets one. Without `BACKGROUND_DEPLOYMENT_ID`, the process follows `BACKGROUND_WORK_ENABLED` as before and the legacy build-heartbeat supersession applies.

## The owner record

The record lives in the `background_ownership` durable map under the key `ownership`:

| Field               | Meaning                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `ownerDeploymentId` | The deployment that may run background work, or `null` for nobody. |
| `setAt`             | When the owner last changed.                                       |
| `setBy`             | The deployment whose API accepted the change.                      |

There are no per-process rows. Processes never write the record; only the operator endpoint does. A record written by the earlier member protocol (`enabled`, `desiredDeploymentId`, `members`, …) is read as `enabled ? desiredDeploymentId : null`; reads and no-op sets leave it untouched. The next owner change rewrites it, and the rewritten row also carries `enabled: true`, `desiredDeploymentId` equal to the owner, and the previous `generation` and `members` so that processes and CLIs still running the member protocol keep reading the same owner, acknowledge their relinquish normally, and refuse to admit: a build that predates this record can be replaced through the normal `qm up` path. If that older build's CLI changes `desiredDeploymentId` after the rewrite, the member fields win until the next owner change, so both builds always agree on the owner; do not use the older CLI once this one has set an owner. Ownership cannot be handed back to a color that still runs the member protocol with this CLI (its endpoint rejects the new request body), so the first rollout rolls forward only. The compatibility fields can go once no deployment runs the member protocol.

## Operator endpoint

`GET /v1/background-work` and `POST /v1/background-work` require both normal source request signing and `Authorization: Bearer <DEPLOYMENT_CONTROL_SECRET>`. Agent capabilities cannot invoke these routes. Portal forwards only those exact methods and path, preserving the supplied credentials.

Status is:

```json
{
  "protocol": 2,
  "deploymentId": "core:release-b",
  "instanceId": "2b1c…",
  "ownerDeploymentId": "core:release-a",
  "setAt": "2026-10-04T18:02:11.148Z",
  "setBy": "core:release-a",
  "active": false
}
```

`deploymentId` and `instanceId` identify the responding process; `active` says whether that process has finished starting background work and is admitting it. Because requests reach one process behind the load balancer, `active` describes one process; the CLI polls until it has seen every expected process of the deployment report the same state.

To change the owner, post:

```json
{ "ownerDeploymentId": "core:release-b", "expectedOwnerDeploymentId": "core:release-a" }
```

`expectedOwnerDeploymentId` is an optional compare-and-swap guard: the change is refused with `409 background_ownership_conflict` when the current owner is neither the expected one nor already the requested one. Setting the owner to the value it already has is a no-op success, so a lost response is confirmed by re-reading the record or by repeating the same request. Set `ownerDeploymentId` to `null` to pause background work everywhere.

## What processes do

Each process polls the record every second. When the record names its deployment, it starts background work: run claims, the cron scheduler, maintenance, and Slack ingress. While it owns, it keeps a local validity window of ten seconds that each successful read renews; a failed or hanging read lets the window expire, which fences new local claims until the next successful read confirms ownership again.

When the record stops naming its deployment, the process stops claiming new work and closes its Slack ingress within one poll interval, or within the ten-second validity window if its reads are failing. The new owner may start inside that window; run claims stay exclusive through the run store's leases, not through ownership, so the overlap costs at most a few redundant poll cycles. Turns and callbacks already admitted continue under their existing leases and heartbeats until they finish. There is no durable acknowledgment: the deploy workflow does not wait for old processes to report anything. It relies on ECS task replacement, which sends `SIGTERM` and allows a drain window, and on the new owner resuming any run whose lease lapses.

Synchronous turns and manually started cron callbacks are admitted work too. A deployment that is not the owner refuses new synchronous execution while still accepting durable asynchronous submissions for the owner to pick up.

## Deploying

`qm up` and `qm rollback` refuse to replace a controlled stack's core tasks while the owner record names that stack. The deploy workflow therefore:

1. Deploys the new release to the stack that is not the owner.
2. Verifies it, then sets the owner record to the new stack (`awsSetBackgroundWork(..., true)`), which waits until every one of the new stack's core tasks has reported `active`.
3. Switches public routing. The previous owner stops claiming within a second of the change and drains under `SIGTERM` when its tasks are later replaced.

Rolling back ownership is the same operation in the other direction. Nothing needs to be retired, proven stopped, or cleaned up: a hard-killed process leaves nothing behind in the record. If the record names a deployment that no longer has tasks (for example after `qm down`), no background work runs until an operator sets the owner again; `awsSetBackgroundWork(..., true)` on the live stack does that, since its compare-and-swap expects whatever owner it just read.

## Live deployment session check

A deployment that owns background work accepts `POST /v1/deployment/live-session` with the same source signature and distinct deployment bearer credential. The body contains exactly `requestId` (a fresh UUID) and `expectedDeploymentId`. The endpoint rejects unknown fields, a mismatched deployment, a non-owning deployment, and an inactive responder before starting work.

The check runs the same fixed session command used by the standalone deployment smoke: a real model reply, persisted turns, generated title, session error log, session archival, then the configured PostgreSQL catalog checks. The request cannot select a principal, URL, model, prompt, or command. Model HTTP requests have a five-minute limit; other HTTP requests and database operations have 30-second limits.

The response is newline-delimited JSON with an initial newline and five-second whitespace heartbeats, followed by one final object containing `ok`, `requestId`, `deploymentId`, and `instanceId`. A failed result adds a fixed error code without raw model, database, or credential details. Ownership is checked again before success. Heartbeats alone never prove success; the caller must receive and verify the complete final object.

Request IDs are durably consumed across replicas and cannot be replayed. Each process permits one check at a time, including its cleanup. Disconnecting the caller does not cancel the check or release that guard before cleanup finishes. An uncertain result must fail the release; do not retry automatically or fall back to a second canary execution.
