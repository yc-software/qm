# Langfuse support

QM has no first-class LLM observability today. The only built-in tracing is Sentry (DSN plus an optional sample rate) with manual spans — no model or tool instrumentation. Admin has no Langfuse / OpenTelemetry settings, the harness env allowlists do not pass `LANGFUSE_*` or `OTEL_*` through to Codex/Claude children (they do pass `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`, with the usual ChatGPT-login caveat), and the Admin README still lists observability as future work. Operators who want traces today have to point traffic through an external LLM gateway or a provider-side observability hook (for example OpenRouter → Langfuse). That only sees generations: model, tokens, cost, latency. It does not see QM sessions, turns, tool calls, or skill loads, and it does nothing for traffic that never hits that gateway.

Options I looked at:

- A. Status quo, and document the gateway / provider workarounds. Zero code, but sessions/tools/skills stay invisible and coverage depends on whoever routes the model calls.
- B. Pass `LANGFUSE_*` (or `OTEL_*`) through the harness allowlist, and optionally wire an OpenTelemetry exporter for model generations only. Cheap, and good enough for operators who already have a Langfuse-compatible backend, but still no QM session/turn/tool/skill structure unless something else emits it.
- C. First-party Langfuse SDK in core: traces for sessions/turns, generations for model calls, spans for tools and skill loads; Admin settings for host + public/secret key (or env secrets); a privacy mode that redacts prompts by default. Rich and product-shaped, but vendor-specific and a bigger surface.
- D. Generic OpenTelemetry export only (vendor-neutral), document Langfuse as one backend that accepts OTEL. Same Admin/env knobs, same opt-in story, no SDK lock-in; Langfuse (or Jaeger, Honeycomb, etc.) is just where the spans land.

I'd go with D as the foundation, and treat C's span shape (session/turn traces, model generations, cheap tool/skill spans) as what we emit over OTEL rather than baking in the Langfuse SDK. Config via Admin and/or env, off by default. Do not send prompts or completions unless an explicit "include prompts" (or equivalent privacy-off) setting is on. Tool and skill spans only where the cost is low and the attribution is clear — same places we already know a skill was loaded or a tool ran. Keep Sentry for errors; this does not replace it.

Out of scope: replacing Sentry; forcing a particular Langfuse host; changing how harnesses authenticate to model providers; shipping a gateway ourselves.

Open calls if the direction looks right: whether Admin should expose a full OTEL endpoint + headers form or just Langfuse-shaped host/keys that we map to OTEL under the hood; whether harness passthrough of `OTEL_*` / `LANGFUSE_*` is worth doing as a thin B on the way to D; and how much of the session/turn tree we want in v1 versus generations-only. Happy for you to implement once you're aligned.
