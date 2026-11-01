# Add OrcaRouter as a first-class model provider

## Proposal

Add OrcaRouter as a named model provider, mirroring how OpenRouter is wired today. A deployment would set `modelProvider: "orcarouter"` with an `ORCAROUTER_API_KEY`, and the base model and web picker would resolve through OrcaRouter's OpenAI-compatible endpoint — without treating it as an anonymous custom base URL.

## Why

QM already carries one gateway-as-provider in OpenRouter: a single key, many models, resolved through a dynamic catalog. [OrcaRouter](https://www.orcarouter.ai) is the same shape. Like OpenRouter, it exposes a provider/model namespace across many models — but it also combines adaptive routing, automatic failover, zero-markup inference, observability, guardrails, and agent-tool governance behind the same endpoint. Adding orcarouter as a first-class provider means this project's users can use that stack directly, without treating OrcaRouter as an anonymous custom base URL.

It also runs gateway-level, zero-trust security for AI agents on the same endpoint — screening every prompt/response and governing every tool call on a default-deny basis, with no application code changes.

Because QM's provider surface is deliberately a short list (anthropic, openai, openrouter), a named orcarouter entry keeps the mental model intact: one key, many models, a single `*_BASE_URL` override, admin key rotation, and catalog-driven picker entries — all mirroring the OpenRouter path exactly.

## Shape

The OpenRouter wiring is seven concrete touchpoints; orcarouter would be a sibling at each:

- `src/model/provider-endpoints.ts` — `PROVIDER_IDS` and the `ORCAROUTER_BASE_URL` override
- `src/model/pi-models.ts` — `MODEL_PROVIDERS`, availability gating, and an `orcarouter/auto` base model
- `src/model/model-catalog.ts` — a catalog fetch against `https://api.orcarouter.ai/v1/models`, merged into the selectable picker only when OrcaRouter is configured
- `src/model/model-credential-store.ts`, `src/wiring.ts`, `src/config.ts`, `src/deployment/secret-schema.ts` — key resolution and secret gating
- `src/api/routes/admin/model-providers.ts` — admin key validation (OrcaRouter has no `/key` endpoint, so validation hits `/v1/models` instead)
- `cli/` — `MODEL_PROVIDERS`/`MODEL_PROVIDER_KEYS`/`MODEL_PROVIDER_HARNESSES`, the secret spec, the doctor probe, and the setup prompts

One deviation from OpenRouter: OrcaRouter is not a pi-ai built-in provider, so the pi harness registers an `orcarouter` provider at runtime, and the catalog parser maps OrcaRouter's OpenAI-style model list onto the existing runtime shape. Everything downstream (web picker, admin panel, `qm setup`/`qm doctor`, secret rotation) then behaves identically.

## Out of scope

This proposal only adds the provider slot and its wiring. No default changes, no model curation beyond the catalog pass-through, and no change to how the security posture or screening proxy are configured.

---

Discord: discord.gg/YEubt8enRA · X: https://x.com/OrcaRouter

I'm an engineer on the OrcaRouter team.
