# Composio through an ordinary credential

QM uses Composio from its computer, through a skill and the official SDK.

## Setup

Register an ordinary personal keychain credential named `composio` with env key `COMPOSIO_API_KEY`, or use an existing org service credential with `delivery: "env"` and that env key. Set the normal credential grants. No provider flag is needed. Never paste the key into a conversation, a script or a repository.

The existing credential machinery delivers the key only where authorized. The `composio` skill discovers apps and tools, starts consent, chooses connections and makes SDK calls. Onboarding and app skills prefer it when an authorized credential is available; otherwise direct OAuth remains unchanged. Sprites and Modal receive a pinned, prebuilt SDK bundle during provisioning. The core image carries this credential-free asset; SDK calls still run only in the scoped computer. Other sandbox backends retain the on-demand install described by the skill.

## Access model

A Composio project API key grants its holder the project's permitted capabilities. Resource-area restrictions are not per-user account isolation. Keychain grants control who receives that key; they do not narrow its authority within Composio. A caller-supplied `userId` is not a security boundary.

Use a key whose authority is appropriate for every recipient. Do not distribute one cross-company project key to mutually isolated companies and claim their connections remain isolated. This skill does not solve shared hosting credential isolation or provisioning.

Existing command policies remain unchanged. Rules written for direct provider URLs or particular CLI commands do not automatically cover SDK calls; operators must review their policy coverage. Skill instructions retain the user's sending, drafting and approval requirements.

## Consent and limitations

Composio handles provider authentication and refresh. Some apps still require provider admin/customer setup. If project callback identity verification is enabled, an existing authenticated verifier must complete consent; this skill neither implements nor bypasses it. See [the vendor verifier contract](https://docs.composio.dev/reference/api-reference/connected-accounts#callback-identity-verification).

No live key, grant or project setting is changed by adding these skills. Test app-originated consent and requested operations before rollout. Automatic SDK file transfer is disabled. The separate chat bot installation and deterministic background source adapters remain unchanged.

## Rollback

Seed removal does not delete an already-published skill. When replacing the earlier prototype, archive its obsolete `integrations` skill if installed. To roll this version back, restore the previous app/onboarding skills, archive the published `composio` skill and stop workflows using it. Revoke any separately enabled credential grants; rotate or revoke the provider key if previously delivered copies must stop working. Do not delete provider connections without authorization.

## SDK provisioning

For source development, `npm start`, `npm run dev`, `npm run worker`, and the dev-instance launcher build the bundle automatically. When launching the core directly with Node, first run `npm run build:connector-sdk`. The core Dockerfile builds the same asset automatically. The published CLI deploys this core image; it does not run the connector SDK itself. The standalone lockfile in `deploy/connector-sdk` pins the SDK and all build dependencies. Its build produces portable Node JavaScript plus third-party licenses in `.generated/connector-sdk`; no native modules or credentials are included. Rebuild after changing the lockfile.

Provisioning checks the SDK's SHA-256, reuses a matching `/opt/qm/composio/sdk.cjs` from a baked image, or transfers the bundle to `$HOME/.qm/composio/<sha>/`. It atomically activates `$HOME/.qm/composio/current`. Concurrent provisioning can transfer duplicate bytes, but only verified complete files become active. Interrupted transfers are retried on the next provision. No npm registry connection or dependency resolution occurs in the sandbox. Home restoration runs before provisioning, so a restored older bundle is upgraded automatically; previous versions remain available for rollback. Node 22.22.3 or newer is required.
