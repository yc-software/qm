# Sandbox resources and defaults

A sandbox is an independently recorded resource with an owning scope, provider, backing identity, and lifecycle state. Creating a sandbox provisions a blank machine without copying files or changing a default. Setting a default changes routing only. Background jobs retain the target on which they started.

The `sandbox` tool exposes `status` and `restart`. With `SANDBOX_RESOURCES_ENABLED=true`, it also exposes `list`, `create`, `set_default`, and `retire`. `list` returns the available providers and supported actions. Unsupported provider operations fail explicitly. Files publication is separate from sandbox management.

`execute` and `background` start accept `sandbox_id`. Without a target, execution requires the scope's stored default after activation. `set_default` accepts an ID or null; null clears the default. A new scope has no default. Retiring a sandbox requires clearing its default and stopping its jobs first. Retirement deletes its working state, so durable outputs should be published to Files or git beforehand.

The initial agent interface restricts inventory and operations to the current owning scope, in addition to actor authorization. It does not yet offer cross-conversation access to every resource a person can access. Provider-native recovery status includes its own expiry; a sandbox record is not an indefinite backup guarantee.

## Staged activation

The feature defaults off. Deploy this reader-compatible version to every core and worker and retain a compatible rollback release before enabling it. Drain old cores and in-flight legacy migrations before activation. An older binary cannot be made safe by a lock introduced in a newer binary.

On activation, startup completes a durable, locked backfill before accepting new work. It preserves explicit defaults, existing routing, session scopes, provider records, and original backing identities. It makes no provider calls or disk copies. Inferred resources start unverified. The activation marker is written last, so an interrupted backfill can be retried.

The activation marker is permanent: after it exists, a missing default means no default even when the feature flag is turned off again. Turning the flag off hides new management operations; it does not restore implicit computer creation. Rollback must use a reader-compatible release.

Agent-facing migration is retired. Existing operator migration refuses scopes with managed defaults. Provision, verify on the named target, then select a default explicitly when moving work between providers; copying files is optional.
