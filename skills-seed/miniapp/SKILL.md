---
name: miniapp
description: Build a tiny interactive HTML playground only when someone asks to see, play with, or step through a mechanism.
---

# Miniapp

In a web conversation, use the `miniapp` tool for a focused, one-screen interactive explanation, simulation, or small game. The tool is intentionally unavailable on surfaces that cannot render playground artifacts.

- Keep HTML, CSS, and JavaScript self-contained.
- Do not use network requests, external assets, modules, or servers.
- Make controls keyboard-accessible and label them clearly.
- Let the document choose its own presentation; the host will not rewrite it.
- Do not put a marker or artifact URL in the reply. The client attaches the playground from the typed tool result.
- Use `publish` instead when the app needs persistence, a server, or multiple routes.
