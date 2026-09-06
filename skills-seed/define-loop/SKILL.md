---
name: define-loop
description: Define a Loop — a durable scaffold that works a queue of recurring tasks autonomously (Sentry issues, Front tickets, small perf PRs) with its outputs held for human review. Use when someone wants an agent to keep doing a kind of work on a schedule, rather than one-off. Walks the interview, runs one real item live before arming anything, then writes the playbook and creates the loop.
---

# define-loop — author a Loop

A Loop is a cron with a memory and a gate: a trigger, a playbook, a ledger of work items
that survives across fires, ship-ready outputs held for a person, and a governor watching
its health. Reach for one when the ask is "keep doing this kind of work", not "do this".

Work turns run without surface tools or addressed delivery, and final external actions
are performed in the fenced ship stage. Work-stage tool restriction beyond that remains
a known limitation pending a turn-runner tool policy.

A cron is enough when each fire is independent and nothing needs reviewing. Prefer the
cron; a loop earns its complexity only when work items persist, must not be worked twice,
and produce artifacts someone should see before they go out.

**The one rule: never arm a loop you have not watched work.** Stage 2 is not optional.

## Stage 1 — Interview

Get these, in the user's own words. Ask about them one or two at a time, not as a form.

| What                  | Why it matters                                                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source of work**    | How to enumerate candidates each fire, and the stable id per item (Sentry issue id, Front conversation id). That id is the dedupe key — get it right or work repeats. |
| **Trigger**           | A cadence (calendar cron in their timezone) or an event. Ask when output is actually useful, not just how often.                                                      |
| **Success condition** | What "done" means for ONE item.                                                                                                                                       |
| **Ship actions**      | Which externally-visible actions the loop may take (`open_pr`, `send_email`, `front_reply`). Anything not declared is a quarantine when it happens.                   |
| **Caps**              | Optional. Propose defaults; record a decline without argument.                                                                                                        |
| **Escalation**        | Who the governor pings, and where.                                                                                                                                    |

### Writing the success condition

Free text, and it's the most load-bearing sentence in the loop. A good one has:

- **one measurable end state** — a test result, a linked PR, an empty queue
- **a stated check** — how the agent proves it ("`npm test` exits 0", "the PR shows CI green")
- **the constraints that matter** — what must not change on the way ("touches only the implicated module")
- **a bound** — "or park with a diagnosis after 5 turns", so a hopeless item stops burning money

> The Sentry issue has a linked PR whose tests pass and CI is green, the fix touches only
> the implicated module, or park with a diagnosis after 5 turns.

Add `successChecks` for anything a command can settle (`npm test`, `npm run lint`). Checks
run before the judge and are authoritative — a failed check never reaches the model.

## Stage 2 — Shadow run (never skip)

Work **one real item end to end, in this conversation, with the user watching.** No loop
record exists yet.

1. Pull one real candidate from the source.
2. Do the whole job to the ship line — write the actual PR or the actual reply — and stop.
3. Show the user the finished artifact. Ask directly: would you have sent this?
4. Fix what they flag. Repeat on a second item if the first needed real correction.

Then write the playbook **from what you just did** — the steps that actually worked, the
dead ends worth skipping, the exact success condition you'd have wanted. A playbook
written before the shadow run is a guess; one written after is a procedure.

## Stage 3 — Emit

Create the loop with the `loop` tool: name, purpose, playbook, success condition, checks,
ship actions, caps, trigger. Every ship action starts at `hold` no matter what was asked
for — `auto` is earned in stage 4, never granted at creation.

State back to the user, in one message: what it will do, when it fires, what it will
produce, what it will hold for them, and how to pause it.

## Stage 4 — Supervised fires

Watch the first few fires with the user.

- Review the held outputs together the first time.
- When a slice of work has been shipped unchanged several times running, offer graduation:
  "always ship `open_pr` labelled `lint-fix` from this loop". That writes a standing grant
  and flips only that slice to `auto`. If the org disables always-grants, graduation is
  unavailable — say so plainly instead of half-doing it.
- If outputs keep coming back returned, the playbook is wrong, not the reviewer. Fix the
  playbook; a high return rate is the loudest signal a loop isn't working.

## Editing a live loop

Playbook edits are versioned with provenance, from chat or the UI — same path, one
history. "Skip payments-service tickets from now on" is a playbook edit, so make it one:
propose the diff, get agreement, write it. Never let a loop carry behavior that isn't
readable in its playbook.

## Refuse to arm

Say no, and say why, when:

- the user can't state a stable per-item id (work will repeat)
- the success condition has no measurable end state (nothing can judge it)
- `auto` is requested at creation on an externally-visible action (that's stage 4's job)
- the shadow run never produced an artifact the user would actually send
