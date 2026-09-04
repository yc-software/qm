# Onboarding plugin

Adds a memory-first onboarding skill: it connects the user's accounts, reads a light
snapshot of their real work, and proposes concrete automations — then persists the
profile in memory.

The core discovers plugin skills from `plugins/*/skills` by default and installs them
into the org skill catalog at startup. The onboarding skill is therefore visible in a
user's DM as `/onboarding`, and the core injects a pending-onboarding prompt when the
personal memory notebook does not contain a completion or dismissal marker for the
current version.

## Source Of Truth

Onboarding state is readable memory, not a separate database table:

```md
## Onboarding

- Onboarding: completed v2 on 2026-06-09.
- I write in direct, straightforward, concise sentences.
```

`completed v2` suppresses the pending prompt. `dismissed v2` also suppresses it until
the onboarding version changes — bumping the version re-triggers onboarding so an
improved flow reaches users who finished an earlier one.

SOUL updates are optional and should only hold compact first-person operating
instructions.
