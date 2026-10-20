# Vendored pi-ai 0.82.0 (qm.2)

qm installs `@earendil-works/pi-ai` from `earendil-works-pi-ai-0.82.0-qm.2.tgz` in this directory, built from stock
npm 0.82.0 plus `provider-error.patch`, `stream-idle-timeout.patch` and `fetch-options.patch` (dist only; version
unchanged; not sent upstream). The core and egress-proxy images copy the tarball in before `npm ci`.

Why: stock pi-ai folds a provider HTTP failure into the display string `errorMessage`, so qm had to
parse text to tell a budget cap from a rate limit. The patch keeps the structured data next to it:

- `AssistantMessage.providerError?: { status?, type?, code?, body?, retryAfterMs? }`, from the SDK error, in the
  error path of openai-completions, openai-responses, azure-openai-responses, openai-codex-responses,
  anthropic-messages, google-generative-ai, google-vertex, mistral-conversations and
  bedrock-converse-stream (`extractProviderError` in `dist/utils/error-body.js`). `retryAfterMs` is read
  from the SDK error's `retry-after-ms` / `Retry-After` headers.
- `AssistantMessage.rawStopReason?: string` when a stop/finish reason maps to `stopReason: "error"`
  (anthropic-messages, openai-completions, bedrock-converse-stream), e.g. Anthropic `refusal`.

`errorMessage` is byte-for-byte what stock 0.82.0 produces.

`stream-idle-timeout.patch`: stock pi-ai hands `timeoutMs` to the provider SDK, which bounds only the wait for
response headers, so a stream that goes quiet after its first event never ends. anthropic-messages, openai-completions
and openai-responses now give the SDK client a fetch (`idleTimeoutFetch` in `dist/utils/idle-timeout.js`) whose
response body fails if no bytes arrive for `timeoutMs`; any bytes count, including SSE comments, pings and partial
events. On expiry the request is aborted and the reply fails with `providerError: { type: "stream_idle_timeout" }`.
The pi CLI enforces the same byte-level bound through its global HTTP dispatcher; the patch keeps it to model
requests.

`fetch-options.patch`: adds `StreamOptions.fetchOptions`, extra fetch init that anthropic-messages, openai-responses and
openai-completions pass to the SDK with each request (`streamSimple` included), so QM can set `{ redirect: "error" }` on
gateway-routed requests so a gateway redirect cannot carry the gateway key and `x-qm-*` headers to another host.
`idleTimeoutFetch` forwards the init unchanged, so the two patches compose.

The vendored pi-coding-agent (`vendored-pi-coding-agent-0.82.0-security.6`) is security.5 with only its
`npm-shrinkwrap.json` pi-ai entry repointed at the qm.1 tarball; the root `overrides` entry resolves it to
this one, so there is one pi-ai in the tree.

Rebuild (both are byte-reproducible and verify their inputs' SHA-256):

    (cd vendor/pi-ai && ./build.sh)       # earendil-works-pi-ai-0.82.0-qm.2.tgz
    vendor/pi-ai/repack-coding-agent.sh   # earendil-works-pi-coding-agent-0.82.0-qm-security.6.tgz

Drop this directory when qm upgrades past 0.82.0 to a pi-ai that exposes equivalent fields.
