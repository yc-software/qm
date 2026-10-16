# Post-response runtime routing

Decision rules can run at `turn_end`, after the harness returns a response or a structured provider refusal. The state contains the latest request, the active runtime, the response, and a typed `providerError.code` for refusals. Other provider errors keep their normal handling. This first version sends both structured and textual refusals through the configured classifier; it does not infer refusals from HTTP status alone.

To replace predictive refusal routing, disable the old `turn_start` rule and create a `turn_end` rule using the existing decision provider and model. Ask whether the assistant actually declined the user's request, distinguishing refusal from quoted examples, missing information, unavailable tools, and permission requests. Configure a `keep` option and a `use_runtime` option targeting the deployment's GLM model ID. Set `onError` to the keep option. Start in `observe` to inspect classifications, then use `enforce` to enable handoffs. No rule or provider is installed automatically.

An enforced rule uses the normal runtime service, including model availability, account authorization, and live-actor checks. Its target uses the Pi harness. The existing task handoff resumes the current request from recorded work. A conversation note asks the model to prefer that runtime for subsequent work, without pinning it or adding a new runtime lifetime. Future requests still use normal runtime selection.

A rule targeting the already-active model does not retry again. Stopped turns, approval pauses, silent responses and read-only turns are not classified. Textual classification happens at the end of the harness turn, after any internal goal continuations.

## Rollout

There are no database-schema changes. Existing `fallbackRuntime` still covers model availability and compaction recovery, but ordinary provider refusals now reach the shared decision hook. Deploy the post-response rule with the code if refusal fallback is desired. Existing pre-turn rules remain active until an operator disables them.
