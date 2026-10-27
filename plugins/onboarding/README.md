# Onboarding plugin

Adds a memory-first onboarding skill: it connects the user's accounts, reads a light
snapshot of their real work, and proposes concrete automations — then persists the
profile in memory.

The core discovers plugin skills from `plugins/*/skills` by default and installs them
into the org skill catalog at startup. The onboarding skill is therefore visible in a
user's DM as `/onboarding`. The web UI's first-visit greeting asks the agent to follow it.

The skill keeps what it learns about the user in their memory notebook.

SOUL updates are optional and should only hold compact first-person operating
instructions.
