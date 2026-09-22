# Model gateways

Pi can route model calls through an authenticated gateway instead of holding provider keys. Set `MODEL_GATEWAY_URL`, `MODEL_GATEWAY_API_KEY`, and `MODEL_GATEWAY_API_KEY_HEADER`. The key stays server-side. No model list is required.

QM discovers models using authenticated `GET /v1/models` and `GET /model_group/info`, the end-user metadata endpoint implemented by LiteLLM. A base URL ending in `/v1` is supported; both endpoints retain any preceding path prefix. Discovery uses the same key as inference, rejects redirects, and ignores upstream credential and endpoint fields.

Only models listed by both endpoints, marked as chat models with tool support, and carrying valid context, output and pricing metadata are offered. Discovered IDs are namespaced as `gateway/<upstream-id>`. Groups whose metadata identifies only Anthropic providers use native Messages, preserving signed thinking blocks across tool calls. Groups whose providers are exclusively OpenAI or Azure use Responses, including native file inputs. Other groups use OpenAI-compatible streaming chat completions. Reasoning controls are enabled for native Anthropic and OpenAI/Azure groups; other provider combinations use standard chat without requesting reasoning effort. They are available in Pi, not process harnesses. The gateway owns provider translation and group capabilities. QM selects the protocol from provider metadata, never model names. Gateways must expose `/v1/messages` for Anthropic groups and `/v1/responses` for OpenAI/Azure groups. PDF inputs on chat-completion routes require vision capability and a provider set consisting only of Anthropic, OpenAI, Azure, Gemini or Vertex. Unknown or mixed unsupported provider groups use bounded text extraction.

Availability refreshes on demand every five minutes and before inference when expired. Successful refreshes replace the catalog, including an empty catalog. After discovery has succeeded, a failed refresh disables gateway routes until recovery without interrupting independent direct providers, with retries after thirty seconds. In-flight requests are not cancelled; the gateway still enforces its key permissions on every call. Retired selections remain in conversation history but cannot issue a new request through a different provider.

`MODEL_GATEWAY_MODELS` is optional and accepts the existing `local-id=upstream-id` pairs. These provide compatibility aliases using QM's existing native model definitions; they do not limit discovered models. After discovery succeeds, aliases are usable only while their upstream IDs remain advertised. Gateways without the discovery endpoints can continue to use explicit mappings. Before the first successful discovery, failures leave those configured routes available. This compatibility fallback never restores a route removed by a successful discovery.

For LiteLLM deployments, allow the two authenticated GET endpoints alongside inference paths. Do not expose administrative `/model/info` or key-management routes to enable discovery. Gateways implementing only the OpenAI model-list endpoint can use explicit mappings or implement the metadata contract below.

The metadata endpoint returns `{"data": [...]}` with one object per model group. QM uses `model_group`, `mode`, `supports_function_calling`, `max_input_tokens`, `max_output_tokens`, `input_cost_per_token`, and `output_cost_per_token`. Optional fields include `providers`, `supports_vision`, `supports_reasoning`, `supports_adaptive_thinking`, `supported_openai_params`, `cache_read_input_token_cost`, and `cache_creation_input_token_cost`. Prices are per token and converted to per-million-token prices for QM. Missing cache prices use the input rate. Input capacity is used conservatively as the context budget; output capacity must be smaller.

LiteLLM group metadata may combine capabilities and maximum limits from multiple deployments. It is a gateway contract, not a guarantee that every backing deployment has identical capabilities.

## Browser agent

When a model gateway is configured, the browse skill uses it for the inner browser
agent as well. The organization browser-model override, or deployment base model,
must be present in the gateway catalog or configured aliases. Kernel, Anchor and
Browserbase still use their own credentials to create browser sessions.

Core gives internal, non-strict turns a one-hour capability bound to the selected
browser model and conversation scope. The sandbox sends OpenAI-compatible,
non-streaming chat completions to `/v1/browser-model/chat/completions` on core;
core replaces the model alias and authenticates with the existing gateway key.
That key stays on core, so private gateways need no public listener. Browser
inference uses the same gateway key permissions and budgets as other model calls.
The endpoint accepts up to 16 MiB for screenshot history, rejects provider overrides,
and rechecks scope membership, strict posture and gateway model availability.

The browse runner needs browser-use 0.12.9 with `ChatOpenAI.default_headers`
support. It does not request direct provider credentials or fall back to them on
gateway errors. Gateway budget exhaustion is returned as HTTP 429. A missing or
retired model is unavailable until the organization selects an accessible model.
