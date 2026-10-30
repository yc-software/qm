# Re: dev-instance requires ANTHROPIC_API_KEY even when pi is running on another provider

Tried booting a dev instance with only an OpenRouter key and it refused with ANTHROPIC_API_KEY is required: dev instances exercise real LLM calls by default.

But pi handles OpenRouter ok — config.ts reads OPENROUTER_API_KEY and OPENAI_API_KEY, and modelSupportedByHarness lets pi use any registry model. It's scripts/dev/lib/envctx.ts that kind of only selects pi when an Anthropic key is given, so the dev script ends up being more strict than the runtime it configures.


Small related thing: PI_MODEL in the worktree .env doesn't carry through to the dev instance env, which impacts when the only key is non-Anthropic, because the default model isn't workable.

Happy to send the patch if needed.
