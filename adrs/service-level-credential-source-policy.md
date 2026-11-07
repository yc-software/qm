QM already has two credential sources with different operators: a person's keychain and
administrator-managed service credentials. A shared agent deployment needs to be able to
say that one service may only come from the second source.

Could scope config gain a small per-service credential-source policy? For example, an org
could deny personal credentials for `artifactshare` while continuing to allow an admin to
register a service credential for it. The default would remain today's behavior when no
policy exists.

The personal denial needs to hold at the boundaries, not just in the UI or prompt. Saving
or importing a matching personal credential should fail, creating or approving a grant for
one should fail, and an older matching credential should no longer materialize into a turn.
That last check matters during rollout because stored credentials can predate the policy.

Service credentials should keep using their existing ACL grants. An administrator can then
grant the managed credential only to selected channel scopes, and the runtime already has a
single place to decide whether the current conversation is entitled to it. This avoids a
second channel allowlist and keeps service identity separate from user-supplied channel
metadata.

The resolved admin config and audit trail should make the effective policy visible. It
would also be useful for static or live conformance to prove three things for a configured
service: personal save is denied, a pre-existing personal credential cannot be loaded, and
the managed credential is available only in its granted scopes.

This is intended as a generic deployment control rather than a special case for one CLI.
