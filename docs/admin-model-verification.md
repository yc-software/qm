# Admin-managed model verification

In the admin model registry, **Verify and enable** checks a proposed OpenAI or Anthropic model before saving it. Only organization administrators can run the check. API clients must explicitly consent by including `verify: true` with the registry PUT; it is not part of the model definition.

The check uses Pi's model runtime, the selected template's protocol, the exact model ID, and the organization's serving credential and endpoint configuration. It sends only synthetic text and a synthetic tool schema; no tools are executed or conversation data sent. It requires a completed, nonempty text response. The output cap is the lesser of 128 tokens and the model's configured limit. Fast-mode definitions require ordinary and fast checks. Verification has a 15-second deadline; provider retries may apply. These requests may incur provider charges.

A failed check does not create or save the proposed definition. Failed edits preserve the previously saved settings. A failed recheck of the same saved settings removes their earlier verification. Errors distinguish missing credentials, access denial, unavailable models, quota/rate limits, rejected configurations, timeouts, and other provider failures without returning raw provider details.

Successful checks store a timestamp and a private fingerprint of the definition, resolved template metadata, and serving credential/configuration revision. Each durable refresh checks that fingerprint without making another provider request. Relevant changes invalidate verification and remove the model from selectable choices until an administrator verifies it again. Previously stored definitions without verification are unavailable until checked. Existing selected IDs are preserved rather than silently replaced.

Slow probes run outside the registry write lock. Before saving, the store rechecks the definition, serving configuration, and prior stored revision. A late result cannot undo a deletion or overwrite another edit.

## What verification does not promise

- The timestamp records a successful check at that time, not permanent provider access. Entitlements, quota, or provider behavior can subsequently change.
- Organization verification does not certify any user's personal API key or subscription. Existing credential boundaries still apply.
- A small probe does not certify prices, the maximum advertised context/output limits, image support, every reasoning level, or correct tool execution. Check provider documentation for those fields.
- Configuring a model does not add support for a new protocol or native harness. Admin-managed API models remain Pi-only in normal use.
- Live provider compatibility requires running the check against that provider. Development tests use local streaming provider fixtures.

## Find a model before entering metadata

Start with **Provider** and **Model ID**, then **Look up model**. Exact matches use the bundled, maintained model catalog, including models not currently offered in the picker. The result shows its source and catalog generation date when available. Existing models can be verified and added to the web picker without cloning them or changing the organization default. This uses existing built-in model policy; it does not create an admin-managed override or persistent overlay verification record.

For a new ID, lookup requests that exact record from the selected provider using organization credentials and configured endpoints. Redirects are refused. Lookup is bounded to five seconds and 64 KiB. Available name and token-limit fields are imported; missing prices, limits, and the compatible protocol template are requested explicitly. Provider APIs do not consistently publish pricing or complete metadata. Unknown values are never replaced with values from a similar model, and no third-party pricing source is queried.

The common path requires only the initial two inputs. New-model details that are already known remain under **Advanced overrides**, while missing fields are shown separately. All new or edited definitions still require **Verify and enable**. Metadata lookup is not a generation-access test and cannot certify a personal credential. Editing the provider or model ID clears a prior lookup result. The existing full-definition PUT remains supported.
