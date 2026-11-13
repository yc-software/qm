# MuscleMemory for reviewed procedures

Could QM support MuscleMemory through its existing scope-aware memory-provider router? That could let QM and coding agents such as Claude Code or Codex use the same reviewed procedures.

This could help QM handle recurring tasks with less repeated investigation by reusing reviewed workflows.

The generic `type: "mcp"` provider currently sends memory facts and optional request/reply metadata. MuscleMemory's `observe` API expects a run token and typed tool-event batch, and `learn` requires proof that the task completed. Could QM extend its generic provider contract to send a redacted tool trace and verification evidence, then use MuscleMemory's existing `observe`, `learn`, and `recall` APIs? The typed capture contract should be canonical, with no legacy fallback.

Routing should reuse the existing `MEMORY_PROVIDER_CONFIG` and scope/capture controls, respecting MuscleMemory's scoped access controls. Each scope should have one automatic procedure-capture destination to avoid duplicate recordings. A missing match or unavailable service should leave the turn unaffected, while provider errors remain visible in QM's existing reporting. By default, give the model only a bounded guidance pointer; fetch the full procedure on demand after a match.

Would this fit QM's direction? This is an idea only; no runtime behavior, configuration, schema, or persisted data changes.
