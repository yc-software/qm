QM deployment layers can currently interpolate only `{actingSlackUserId}` into
`auth.splitEnv`. Tools that need the current Slack conversation therefore have to ask the
model to supply channel metadata as command arguments, even though the orchestrator has
already derived that metadata from the platform event.

Could `auth.splitEnv` gain placeholders for that trusted conversation context? A small set
would cover the generic need:

- `{conversationKind}` for `dm`, `channel`, or `group`
- `{channelRef}` for the platform channel ID
- `{channelName}` for the human-readable channel name
- `{channelIsPrivate}` as `1` when private and `0` when explicitly public
- `{actingPrincipalId}` for the normalized identity key used by the deployment
- `{actingDisplayName}` for display-only attribution

`{actingSlackUserId}` would remain available as a compatibility placeholder and existing
templates would keep their current behavior. The conversation values should come from the
normalized `Conversation` created by the surface adapter, and the acting values from its
resolved actor. Neither source should be model-generated tool input or a second Slack
lookup. A deployment that keys principals by verified email can use `actingPrincipalId`
as an email; one that keys them by platform ID must not present it as an email.

Missing values need deterministic, fail-closed behavior. A template that references
`channelRef` or `channelName` in a DM, or before that value is known, should not be emitted.
For `channelIsPrivate`, an unknown value should be treated as private (`1`); only an
explicit `false` should produce `0`. `conversationKind` and `actingPrincipalId` should
always be available. A template that references a missing display name should not be
emitted.

This lets a deployment inject machine-derived context into an ordinary CLI invocation
without teaching the model to decide or reproduce security-relevant metadata. The CLI can
still choose its own environment variable names, and the proposal remains independent of
any one publishing service or organization.

Conformance should cover public and private channels, DM/missing-field behavior, both
principal-keying modes, and the rule that command arguments cannot alter the interpolated
values.
