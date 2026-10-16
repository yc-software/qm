# Azure Foundry and Bedrock model backends

I've been setting up qm for my team and already have a lot of inexpensive model
capacity in an Azure AI Foundry deployment. I wanted to use that deployment with
the Codex harness instead of having to buy the same model capacity again directly
from OpenAI.

I got this working with a small generic change to qm. When `OPENAI_BASE_URL` is
present, qm writes an isolated Codex provider configuration under the jailed
`CODEX_HOME` that looks like this:

```toml
model_provider = "qm-openai-compatible"

[model_providers.qm-openai-compatible]
name = "OpenAI-compatible"
base_url = "https://example.invalid/openai/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
supports_websockets = false
```

The implementation passes `OPENAI_BASE_URL` only to the Codex child, validates
that it is an HTTP(S) URL without credentials, a query, or a fragment, normalizes
trailing slashes, and keeps the generated config and auth files inside Codex's
isolated home with mode `0600`. I also changed `qm doctor` so it validates the
configured endpoint before probing it, and added tests for the environment
boundary, generated TOML, URL rejection, normalization, and doctor behavior.

This is working in a real deployment now. The implementation is generic rather
than Azure-specific: it should work for a Responses-compatible endpoint that Codex
can authenticate to with the configured API key. I would love for this to be a
supported qm path.

I have a similar need for Claude through Amazon Bedrock. Claude Code already
supports this with `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, the normal AWS
credential chain, and optional `ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_FAST_MODEL`
values. qm's Claude child-environment allowlist does not currently pass the
Bedrock/AWS variables through. I have not implemented that half yet, but it seems
like the same kind of provider-routing problem and I would be happy to test it.

I wonder if qm should distinguish the model family from the backend used to reach
it. For example, the family would still be `openai` or `anthropic`, while a backend
could be `direct`, `azure-foundry`, or `bedrock`. That would avoid teaching the
model registry that Bedrock is itself a model family, and would also let setup and
doctor ask for the right credentials without requiring `ANTHROPIC_API_KEY` when
Claude is running through Bedrock.

Would you be open to supporting these as first-class backends? I can contribute or
hand over the working Foundry/Codex implementation and its tests, then help verify
the Bedrock/Claude path against a real AWS account.
