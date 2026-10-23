# Vendored pi-ai 0.82.0 (qm.3)

qm installs `@earendil-works/pi-ai` from the GitHub release
[`vendored-pi-ai-0.82.0-qm.3`](https://github.com/yc-software/qm/releases/tag/vendored-pi-ai-0.82.0-qm.3),
built from stock npm 0.82.0 plus `provider-error.patch` and `served-tier.patch` (dist only; version unchanged; not
sent upstream).

Why: stock pi-ai folds a provider HTTP failure into the display string `errorMessage`, so qm had to
parse text to tell a budget cap from a rate limit. The patch keeps the structured data next to it:

- `AssistantMessage.providerError?: { status?, type?, code?, body? }`, from the SDK error, in the
  error path of openai-completions, openai-responses, azure-openai-responses, openai-codex-responses,
  anthropic-messages, google-generative-ai, google-vertex, mistral-conversations and
  bedrock-converse-stream (`extractProviderError` in `dist/utils/error-body.js`).
- `AssistantMessage.rawStopReason?: string` when a stop/finish reason maps to `stopReason: "error"`
  (anthropic-messages, openai-completions, bedrock-converse-stream), e.g. Anthropic `refusal`.

`errorMessage` is byte-for-byte what stock 0.82.0 produces.

`served-tier.patch`: OpenAI bills a call at the tier it served and reports that tier in the response's
`service_tier`, which can be lower than the tier requested. Stock pi-ai prices openai-responses calls with it, then
drops it, and prices a reported `fast` at the standard rate. The patch keeps the tier as
`AssistantMessage.serviceTier?: string` (openai-responses and azure-openai-responses), prices `fast` like `priority`
as pi-ai does from 0.99.0, and exports `getServiceTierCostMultiplier` from `api/openai-responses` so qm prices an
Ultrafast call served at another tier with pi-ai's own rates. openai-codex-responses is left out: its backend reports
`default` for priority and flex requests, which pi-ai corrects from the requested tier that qm doesn't pass it.

The vendored pi-coding-agent (`vendored-pi-coding-agent-0.82.0-security.6`) is security.5 with only its
`npm-shrinkwrap.json` pi-ai entry repointed at the qm.1 tarball; the root `overrides` entry resolves it to this one,
so there is one pi-ai in the tree.

Rebuild (both are byte-reproducible and verify their inputs' SHA-256):

    vendor/pi-ai/build.sh                 # earendil-works-pi-ai-0.82.0-qm.3.tgz
    vendor/pi-ai/repack-coding-agent.sh   # earendil-works-pi-coding-agent-0.82.0-qm-security.6.tgz

Drop this directory when qm upgrades past 0.82.0 to a pi-ai that exposes equivalent fields.
