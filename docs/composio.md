# Composio adapter

This branch contains an SDK adapter, not an enabled runtime integration.

The boundary is small:

- Composio owns app/tool discovery, connection setup, token refresh, provider schemas and execution.
- Skills choose tools and compose arguments. There are no app-specific workflows in core.
- QM owns authenticated identity, local connection references, grants, operation approval and audit.
- A shared hosting gateway keeps the project key and authenticates each company stack.

`src/connectors/composio.ts` uses the official SDK. There is no custom HTTP proxy, provider URL registry, token store, connection state machine, retry queue or secondary agent runtime. Native app tools are executed individually; meta-tools, custom tools and remote workbench execution are not exposed.

## Runtime contract

The adapter is core-only. Its methods are not agent API routes.

`actor` must come from authenticated context, never request JSON. Company and principal identifiers produce a stable namespaced Composio user. The key must stay in core or the shared gateway, never in a conversation's computer.

The mandatory `authorize` callback composes the existing identity, scope/grant, approval and audit checks. For execution it receives the exact tool version and SDK-preprocessed arguments immediately before dispatch, then returns the authorized connection. A no-auth tool still passes through this check. Missing grants, account ambiguity, strict posture and approval requirements must fail closed. Provider tags are not permission, and shell-only approval rules do not cover native tool calls.

Connection references belong in the existing keychain. `complete()` returns vendor identifiers to core for registration only. Never expose raw SDK account objects, session/MCP handles or the SDK instance to agents. On disconnect, the authorization handler must revoke local access before remote deletion, so a remote failure does not restore access.

OAuth completion requires the project's callback verifier and independently authenticated returning identity. Composio owns single-use redemption. Do not infer success from a browser query or remote ACTIVE status. An ambiguous completion requires explicit cleanup/reconnection, not a blind retry; durable registration must finish before announcing success.

Automatic local file uploads/downloads, SDK telemetry, redirects and automatic request retries are disabled. Tool result data is preserved for callers; following download URLs and sending files require the existing file-access boundary, not arbitrary access to core's filesystem. General exactly-once delivery is not claimed.

## Remaining integration work

Runtime configuration, authenticated callback routing, keychain registration/resolution, operation-policy wiring, skills/onboarding changes and the shared hosting gateway are not implemented here. Direct OAuth remains unchanged. Live consent, sharing, file operations and full dev-instance tests are required before rollout.
