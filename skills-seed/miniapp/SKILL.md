---
name: miniapp
description: Build a tiny interactive HTML playground only when they asked to see, play with, or step a mechanism. Not for ordinary Q&A, facts, writing, or long explanations.
---

# Miniapp

Use the `miniapp` tool only when both are true: they asked to see, play with, step, or drag the idea — and a short paragraph cannot carry it. A derivative as Minecraft blocks, a sorting algorithm they can step, a compound-interest slider. Do not build a playground just because the topic could be visualized. "Explain how LLMs work" is prose. "Let me drag the number of rectangles" is a miniapp.

A miniapp is one self-contained HTML page. It is not `publish`: no server, no `PORT`, no durable process. `publish` is for long-lived internal apps.

## Build

Write the page first (`write`, or pass `html` directly). Then:

```
miniapp({ title: "Slope as mining speed", html: "<!doctype html>…" })
```

or `file: "work/playground.html"` instead of `html`.

The tool parses every inline script and checks the page has something to show before it stores. If it fails, fix the HTML and call `miniapp` again — do not put a broken directive in the reply. Never invent a path, a `sandbox:` URL, or a filename — only the url the tool returned. The host knows the first paint happened; do not wait for the page to "stabilize."

```
[[miniapp: <url> | <title>]]
```

Do not paste the raw HTML into the chat.

## Constraints

- One HTML document. Inline CSS and JS. No `fetch`, no CDNs, no remote fonts/images — the playground is sandboxed with no network.
- Keep it under ~500KB.
- Fill the host frame. `html,body` are 100% height with `overflow: hidden`. One concise screen — no `overflow: auto`, no `overflow: scroll`, no page or inner scroll. Put the live bit (`canvas`, svg, stage) in a flex child that grows.
- Label the moving number. Accent is the value they control; muted is everything else. Animate the change with `requestAnimationFrame` (lerp, step) — no page scroll, no decorative loaders.
- Match the chat, not a separate dark app. Use only these tokens — never hardcode a palette: `var(--background)`, `var(--foreground)`, `var(--border)`, `var(--secondary)`, `var(--muted-foreground)`, `var(--brand-accent)`. The host injects light or dark to match the person.
- It must work on a phone as well as a desktop.

## When not to

- They asked a question a paragraph answers — facts, definitions, how-tos, advice, summaries.
- Writing, ops, code edits, lookup, calendar, mail, memory, or "are you there."
- They asked for a durable internal app, dashboard, or anything that must keep running — that is `publish`.
- Anything that needs their logged-in session on another site — that is `browse`.
