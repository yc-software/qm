# Skill usage stats

Admin → Skills shows "Last used", and that's all there is. `recordUse` merges a single `lastUsedAt` onto the skill each time it is loaded, so an operator can tell a skill was touched recently but not how often, by how many sessions, or whether a newly published skill is actually being picked up. That makes it hard to prune skills nobody uses, spot the handful that do most of the work, or check adoption after shipping or editing one. Run traces can show individual skill reads if you dig through one session at a time, but there's no aggregate.

Options I looked at:

- A. Add a `useCount` that `recordUse` increments, plus a sortable column in Admin → Skills. Cheap, but a lifetime total can't answer "last 30 days" or "since the last edit", and concurrent merges need an atomic increment.
- B. Append a usage event per load (skill id, scope, session id, timestamp, which file) and derive counts from it. The scoped event sink behind credential usage (`credential_usage`, with an in-memory and a Postgres implementation and a `summary()` over a recent window) already has this shape, so it can be reused rather than inventing a new store.
- C. Leave it to external tracing. QM doesn't export LLM or tool spans by default, and a trace backend would see file reads, not "this skill was resolved and loaded", so attribution would be fragile.
- D. Status quo.

I'd go with B, reusing the credential usage sink pattern: record from the same place `recordUse` is called today, and have Admin → Skills show uses and distinct sessions over a recent window next to "Last used", sortable, with skills that have no uses in the window easy to find. Keep `lastUsedAt` as is so nothing that reads it changes. If a lifetime total is wanted cheaply, A can ride along, but B alone covers it. Probably count `SKILL.md` loads as a use and keep asset reads as detail, so one session reading five files doesn't count five times.

Privacy: the stats are admin-only, the same audience as the credential usage counts. Events carry ids and timestamps, no prompts, skill content or user text. Retention can follow whatever the credential usage table does.

Out of scope: credential usage, which already has counts; per-user leaderboards; anything that changes how skills are resolved or loaded.

Open calls if the direction looks right: whether the window should match credential usage or be configurable, whether to attribute by principal as well as session, and whether this belongs in Skills or a broader usage view. Happy for you to implement once you're aligned.
