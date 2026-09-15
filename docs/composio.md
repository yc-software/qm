# Composio through an ordinary credential

QM uses Composio from its computer, through a skill and the official SDK.

## Setup

Register an ordinary personal keychain credential named `composio` with env key `COMPOSIO_API_KEY`, or use an existing org service credential with `delivery: "env"` and that env key. Set the normal credential grants. No provider flag is needed. Never paste the key into a conversation, a script or a repository.

The existing credential machinery delivers the key only where authorized. The `composio` skill discovers apps and tools, starts consent, chooses connections and makes SDK calls. Onboarding and app skills prefer it when an authorized credential is available; otherwise direct OAuth remains unchanged. The SDK is installed on demand in the computer, not in the harness package.

## Access model

A Composio project API key grants its holder the project's permitted capabilities. Resource-area restrictions are not per-user account isolation. Keychain grants control who receives that key; they do not narrow its authority within Composio. A caller-supplied `userId` is not a security boundary.

Use a key whose authority is appropriate for every recipient. Do not distribute one cross-company project key to mutually isolated companies and claim their connections remain isolated. This skill does not solve shared hosting credential isolation or provisioning.

Existing command policies remain unchanged. Rules written for direct provider URLs or particular CLI commands do not automatically cover SDK calls; operators must review their policy coverage. Skill instructions retain the user's sending, drafting and approval requirements.

## Consent and limitations

Composio handles provider authentication and refresh. Some apps still require provider admin/customer setup. If project callback identity verification is enabled, an existing authenticated verifier must complete consent; this skill neither implements nor bypasses it. See [the vendor verifier contract](https://docs.composio.dev/reference/api-reference/connected-accounts#callback-identity-verification).

No live key, grant or project setting is changed by adding these skills. Test app-originated consent and requested operations before rollout. Automatic SDK file transfer is disabled. The separate chat bot installation and deterministic background source adapters remain unchanged.

## Rollback

Seed removal does not delete an already-published skill. When replacing the earlier prototype, archive its obsolete `integrations` skill if installed. To roll this version back, restore the previous app/onboarding skills, archive the published `composio` skill and stop workflows using it. Revoke any separately enabled credential grants; rotate or revoke the provider key if previously delivered copies must stop working. Do not delete provider connections without authorization.
