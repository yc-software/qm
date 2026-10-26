---
name: define-loop
description: Set up standing work over a queue of items (Sentry issues, Front tickets, small perf PRs) as a cron with an inbox, with each item's result held for human review. Use when someone wants an agent to keep doing a kind of work on a schedule, rather than one-off. Walks the interview, works one real item live before arming anything, then writes the task and creates the cron.
---

# define-loop — standing work as a cron with an inbox

A cron with an inbox is a schedule, a task, and a durable queue of work items that
survives across fires. Each fire reads the inbox, adds new items, works the pending
ones, and closes what is finished. Reach for one when the ask is "keep doing this kind
of work", not "do this".

A plain cron is enough when each fire is independent and nothing needs tracking. Add the
inbox only when work items persist, must not be worked twice, or produce results someone
should see before they go out.

**The one rule: never arm a cron you have not watched work.** Stage 2 is not optional.

## Stage 1 — Interview

Get these, in the user's own words. Ask about them one or two at a time, not as a form.

| What               | Why it matters                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Source of work** | How to enumerate candidates each fire, and the stable id per item (Sentry issue id, Front conversation id). That id is the dedupe key — get it right or work repeats. |
| **Schedule**       | A calendar cron in their timezone. Ask when results are actually useful, not just how often.                                                                          |
| **Done**           | What "done" means for ONE item: one measurable end state, how the agent proves it, and a bound ("or fail it with a diagnosis after 5 attempts").                      |
| **Review**         | Which externally-visible actions need a person first (opening a PR, sending a reply). The task holds those as proposals on the item; a person approves in item chat.  |

## Stage 2 — Shadow run (never skip)

Work **one real item end to end, in this conversation, with the user watching.** No cron
exists yet.

1. Pull one real candidate from the source.
2. Do the whole job up to the review line — write the actual PR or the actual reply — and stop.
3. Show the user the finished result. Ask directly: would you have sent this?
4. Fix what they flag. Repeat on a second item if the first needed real correction.

Then write the task **from what you just did** — the steps that actually worked, the
dead ends worth skipping, the exact definition of done. A task written before the shadow
run is a guess; one written after is a procedure.

## Stage 3 — Emit

Create it with the `cron` tool: `action: "create"`, `inbox: true`, the schedule, a title,
and the task. Every fire is told how to use its inbox (`$AGENT_API_URL/v1/crons/<id>/items`):
add items by dedupe key, put anything that needs review on the item as a proposal, close
finished items as `done`, park hopeless ones with `fail` and a reason.

State back to the user, in one message: what it will do, when it fires, what it will
hold for them, and how to pause it.

## Stage 4 — Supervised fires

Watch the first few fires with the user. Read the fire log and the inbox together. If
proposals keep getting rejected, the task is wrong, not the reviewer: fix the task.

## Editing a live cron

"Skip payments-service tickets from now on" is a task edit, so make it one: propose the
change, get agreement, then patch the cron's task. Never let a cron carry behavior that
isn't readable in its task.

## Refuse to arm

Say no, and say why, when:

- the user can't state a stable per-item id (work will repeat)
- "done" has no measurable end state
- the shadow run never produced a result the user would actually send
