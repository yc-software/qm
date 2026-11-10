# A refused one-shot cron burns its one fire

I build a local multi-agent harness that drives Claude Code and Codex as
subprocesses, so I was reading qm to compare how it handles scheduled background
work. I ended up in the cron path and think I found something.

Your tool schema says a one-shot "fires once, then auto-cancels". That part
works as documented. The problem is that a refused attempt counts as the fire.

Rate limit and budget both return `status: "refused"`
(`src/core/orchestrator.ts:449-463`), and the reason text says to try again in N
seconds. `runTrigger` passes it through as `authzFailed: false, ran: true`
(`src/triggers/run-trigger.ts:273-280`), so the scheduler treats it as a fire.
`claimSlot` drops `nextFireAt` and stamps `lastFiredAt`
(`src/cron/cron-store.ts:136-152`), then `src/cron/scheduler.ts:171` disables
the cron.

An exception thrown at the same point retries. It propagates before `markFired`,
so the cron stays due and comes back next tick. In the job path the catch
unclaims the slot and reconcile re-enqueues it.

So the scheduler already separates transient from final. Refusals sit on the
wrong side of that line.

Where this bites. An org turns budget caps on. Someone burns their daily budget
by lunchtime. Every reminder and follow-up they scheduled for that afternoon
fires once, gets refused, and disables itself. The budget window is 24 hours
(`src/config.ts:388`), so it is not one unlucky cron, it is every one that comes
due until the window rolls. The fan-out cap does not save them either: crons
past the per-tick limit are never marked fired, so they stay due and meet the
same refusal on the next tick.

Rate limiting is the same code path, per principal, 60 per 60 seconds, with cron
fires sharing that bucket with the owner's interactive turns. A single fire
will not trip it alone, so budget is the realistic way in. Budget caps are
opt-in, so a deployment that never sets one never sees this.

Re-enabling does not recover the scheduled occurrence. `setEnabled` only flips the flag
(`cron-store.ts:107-109`). `recoverNextFireAt` returns undefined once
`lastFiredAt` is set and there is no `everyMs` (`src/cron/schedule.ts:111-115`),
so `due()` never returns the cron again. Recovery needs a new `firstFireAt` or a
manual run-now.

No proactive notification is sent. The refusal lands in the fire log and the
runs API, so it is visible to anyone who looks. `errorNotice` already exists for
this (`run-trigger.ts:51`, delivered at `:282`). Monitors pass it. Cron does
not.

One-shots are not an edge case either. The shipped onboarding skill recommends a
cron `message` for a literal reminder and a scheduled follow-up when the agent
promises to check back (`plugins/onboarding/skills/onboarding/SKILL.md:104-105`).

I reproduced it with your own `createCronStore` and `createScheduler`, in
memory, driving `scheduler.tick()` with a `run` that returns the refused shape
from `orchestrator.ts`. Same one-shot cron in all three cases:

```
A. refused          enabled false | lastFiredAt set | due() after re-enable: false
B. thrown           enabled true  | lastFiredAt unset | due() after: true
C. ok (control)     enabled false | lastFiredAt set
```

A and C are identical. A refusal is recorded as the successful fire. B is the
same cron on the same path and it survives. C is there because an ok fire has to
look like A for the comparison to mean anything.

If you go to check this, use the scheduled path. `runNow` does not reproduce it.
It skips `markFired`, so the manual path leaves `lastFiredAt` unset and
re-enabling does recover the cron. Only tick and the queue consume the slot.

Then the same four cases against real Postgres 17, using
`createPostgresMapFactory` and, for the last one, the pg-boss queue path:

```
PG-A. refused, interval    enabled false | lastFiredAt set | due() after re-enable: false
PG-B. thrown,   interval    enabled true  | lastFiredAt unset | due() after: true
PG-C. ok,       interval    enabled false | lastFiredAt set | due() after: false
PG-D. refused,  pg-boss     enabled false | lastFiredAt set | due() after: false
```

Identical to the in-memory run, and queue mode loses it the same way. Your own
`test/cron-queue.test.ts` passes against the same database, 2 of 2, which I ran
only to confirm the wiring was right. It returns `ok`, so it says nothing about
refusal semantics. The paired cases above are the actual evidence.

What I still cannot tell from outside is how often a real deployment hits a
refusal at a scheduled fire.

The contract I think is missing, separate from how you implement it: a normal
refusal should not consume the scheduled occurrence the way a success does, and
if it does end the cron, that should reach the owner rather than waiting to be
found. Everything below is one way or another to get there, and I do not have a
strong preference:

- Classify rate-limit and budget refusals as retryable, the same as a thrown
  error, with a backoff and an attempt cap. Straight retry would be worse than
  the bug, since a persistent refusal like the shared-audience-external case
  (`orchestrator.ts:437-447`) would loop every tick, and every loop appends to
  the fire log.
- Pass `errorNotice` from cron the way monitors do. Smaller change, and it tells
  the owner rather than preventing the loss. Destination-less crons still cannot
  be notified, and a persistently refusing recurring cron would notify on every
  fire, since cron has no `minFireInterval` throttle.
- Do not stamp `lastFiredAt` on a refused attempt, so the slot is never
  consumed. I have not worked through what that breaks for recurring crons.
