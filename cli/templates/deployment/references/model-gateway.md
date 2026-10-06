# Existing model router (LiteLLM-style)

Ask for the router's base URL, an inference key, its authentication header,
and the model/group to use. The endpoint must be reachable from core; use
HTTPS outside a trusted private network. No direct provider key is required.

## Configure before setup

Remove `modelProvider` and any `env.core.MODEL_PROVIDER` override from
`qm.config.jsonc`; `litellm` is not a valid `modelProvider` value. Select the
`pi` harness, since discovered gateway models are not process-harness models.
Merge these fields into the existing config without replacing other settings:

```json
{
  "model": "gateway/my-chat-model",
  "env": {
    "core": {
      "HARNESS": "pi",
      "MODEL_GATEWAY_URL": "https://router.example.com/v1",
      "MODEL_GATEWAY_API_KEY_HEADER": "Authorization"
    }
  },
  "secretEnv": {
    "core": {
      "MODEL_GATEWAY_API_KEY": "MODEL_GATEWAY_API_KEY"
    }
  }
}
```

Replace `my-chat-model` with an actual eligible router model/group ID. Save
`MODEL_GATEWAY_API_KEY` in the private, gitignored `.env`, not in `env.core`.
The header value is sent verbatim: for LiteLLM's bearer authentication, store
`Bearer <router-key>` as the secret value, not just the raw key. For a custom
key header, use the exact header name and value the router expects. The
`secretEnv` declaration makes this a required secret delivered only to core;
merely adding an undeclared key to `.env` does not configure delivery.

Run `npm exec qm -- setup` after these changes. Do not collect an Anthropic,
OpenAI, or OpenRouter key as a substitute if gateway authentication fails.

## Discover and verify

QM uses authenticated `GET /v1/models` and `GET /model_group/info`, preserving
any path prefix before `/v1`. A model must appear in both endpoints with chat,
tool support, context/output limits, and pricing metadata. Its QM ID is
`gateway/<upstream-id>`. The router must support the inference protocol selected
by its metadata: native Messages for Anthropic groups, Responses for OpenAI/Azure
groups, and streaming chat completions for other groups. A generic OpenAI model
list alone is not sufficient for automatic discovery.

For a router without discovery, `env.core.MODEL_GATEWAY_MODELS` can provide
`local-id=upstream-id` aliases using existing QM model definitions; select the
local ID as `model`. Do not invent capabilities for an unknown model. See
[the gateway contract](https://github.com/yc-software/qm/blob/main/docs/model-gateway.md)
for alias behavior and metadata requirements.

After deployment, confirm the chosen model is available in the web model picker
and run `npm exec qm -- check --live` on Fly or AWS (use `docker.md`
acceptance checks for local Docker). Then verify a real web reply and generated
sidebar title. A configured endpoint or a green direct-provider check is not
proof of router inference. Do not expose router administration endpoints or
request an administrative key just to enable discovery.
