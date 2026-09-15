# Composio integrations

Composio is an opt-in universal integration provider. Existing direct OAuth remains available when it is not configured.

## Operator setup

Store the project key as an existing org service credential with `provider: "composio"`, `delivery: "broker"`, and `host: "backend.composio.dev"`. Grant its use through the existing service-credential ACL. Never put the project key in sandbox environment variables. The generic HTTP/Git brokers and model credential resolver refuse this provider type.

Configure the Composio project's callback verifier to the authenticated portal path `/connect/composio/complete/<credential-slug>` (for example `/connect/composio/complete/apps`). This is one verifier URL per Composio project, not per app. The SDK link-level `callbackUrl` is deliberately omitted: Composio ignores it when project callback verification is enabled. See [the vendor verifier contract](https://docs.composio.dev/reference/api-reference/connected-accounts#callback-identity-verification). Composio sends its opaque `session_uri` there. The portal requires sign-in and forwards the real browser session identity to core; core redeems it with the namespaced company/user ID. Only a successful redemption of an active private account registers a connection reference in the existing keychain. Browser query flags or an ACTIVE account alone cannot register one.

A shared hosting project needs a centrally authenticated tenant gateway for both dispatch and callback verification. Do not distribute that shared project key into tenant-managed stacks. Hosting-specific routing is deliberately outside the public harness.

## Shared helper

The `integrations` tool is the single helper used by onboarding and app skills:

- `status`: configured and entitled providers, without key material. Availability does not prove provider health or an app connection.
- `catalog` / `search`: native provider apps and tool schemas, with no local app registry.
- `connections`: local references owned by this personal context or explicitly granted here.
- `connect`: a native consent link for the current user in their personal conversation.
- `execute`: one versioned native app tool, using a selected authorized connection.
- `disconnect`: revoke local access and grants before requesting remote deletion.

The helper runs inside the existing tool executor, not through a second execution API. Existing strict-posture screening and approval pause/resume apply. Native execution and disconnect require exact-operation approval by default; explicit command-policy allow rules can permit selected operations. Shell-only rules are not assumed to authorize a native call. The approval command includes credential, local connection, tool version and canonical arguments.

Connection references carry no token and cannot be materialized. Existing owner grants work for shared conversations, including atomic once-grant consumption after operation approval. Provider key access and connection access are separate checks.

## What stays out of core

Composio owns app discovery, OAuth, token refresh, provider schemas and native execution. Skills choose apps and compose calls. There is no provider URL registry, custom HTTP proxy, connection state machine or app-specific workflow in core.

The SDK's automatic local file transfers, telemetry, redirects and request retries are disabled. Meta-tools, custom tools and remote workbench execution are not exposed. Do not automatically repeat an uncertain write or OAuth completion. File operations need explicit authorized data; a path to core's filesystem is never a file handoff.

## Rollout

No provider key or project callback is changed by installing this code. Validate real consent, reads, approved writes, sharing, revocation and files in a development instance before rollout. Native app calls do not install the separate chat bot. Deterministic inbox/loop adapters still use their direct connectors; this change routes the agent's skills, not those background adapters.
