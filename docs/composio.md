# Composio through the QM backend

QM discovers apps, creates consent links, and executes Composio tools through its authenticated backend. Agent code never receives the project API key. The composio skill calls `/v1/composio` through the existing execute tool, retaining its command-policy and approval gates.

## Setup

Store a personal keychain credential with env key `COMPOSIO_API_KEY`, or an org service credential with `delivery: "env"` and that env key. Existing records and service-credential grants remain compatible. The env key identifies a reserved backend credential: despite the legacy delivery label, QM never materializes it into a computer, command handle, or keychain-use script. Multi-field records containing that key are also backend-only.

An org administrator configures the project once. Users connect their own apps through QM's picker or agent-provided consent links. Composio handles provider authentication and refresh. Some apps still require provider setup. Never paste a project key into chat, scripts, or Git.

## Authorization and execution

The runtime attests whether the initiating actor may use their connections in the current context. This follows existing owner-keychain access: personal conversations, explicitly Open sharing on a human-started shared turn, and authorized automations using their owner's keychain. Shared human requests recheck sharing posture. Org credentials require current grants for the conversation audience. Published apps and bot actors cannot use this API.

The backend derives the Composio user ID from the organization and canonical QM principal. Before every execution it verifies the chosen account's owner, ACTIVE status, disabled flag, and toolkit, then checks the tool and concrete version. Request bodies cannot supply another user identity or override authentication. There is no raw proxy, workbench, or tool-router execution endpoint. The generic credential broker rejects Composio destinations so it cannot serve as a project-wide bypass.

Tool discovery returns schemas; connection discovery returns account IDs and toolkit names, not credentials. Execution returns provider data and success/error status. Audit records contain the actor, scope, tool, account and execution stage without request arguments or response bodies. An uncertain execution failure is never retried automatically.

Calls run through the ordinary execute tool. Existing policies inspecting provider URLs or CLI syntax must be updated to recognize the new QM API calls; these are not a semantic per-provider operation approval system. Strict posture continues to block direct control-plane mutations.

## Browser callback verification

Enable callback identity verification before production use, including for personal projects. Backend execution isolation alone does not prevent a forwarded consent link from attaching the wrong human’s account. For a project dedicated to one QM deployment, configure Composio's project verifier URL as:

```text
https://<QM web origin>/api/composio/callback
```

The authenticated web surface passes the opaque `session_uri` to core. Core supplies the signed-in user's derived identity to Composio's `connected_accounts/complete_auth` endpoint. Agent capabilities cannot complete verification. The browser must be signed into the same QM account that started consent.

Composio ignores a link's `callback_url` when project verification is enabled. QM saves the original return URL and expiry in its durable store, keyed by principal and connected account, and restores it after successful verification. This preserves app-picker state and personal Slack linking. The web surface accepts only same-origin return destinations. The backend never changes project settings automatically.

Verification is project-wide. A project shared across several company deployments needs a trusted central verifier/router or separate company projects before enabling it. Do not point that shared project's verifier at one company's QM URL. Dashboard-originated connections cannot complete against a verifier that only recognizes QM users. See [Composio's verifier contract](https://docs.composio.dev/reference/api-reference/connected-accounts#callback-identity-verification).

## Existing deployment cutover

A source or image pin must adopt this change before behavior changes. Existing credential records, grants, canonical user IDs, and connected accounts are preserved; upgrading alone does not disconnect users or rotate keys.

1. Inventory project use across deployments and identify any personal credentials, generic broker records, custom skills, scripts, or scheduled jobs that directly call the SDK. Connections created under ad hoc user IDs require explicit reconciliation or reconnection; QM never guesses another account owner.
2. Update custom callers to the authenticated `/v1/composio` API. Standard seed-managed skills update through normal startup seeding. User-authored or deployment-layer overrides are not silently overwritten and must be updated separately. SDK scripts that expect a sandbox `COMPOSIO_API_KEY` stop working after upgrade.
3. Deploy the same version to all core/worker instances that share the key and drain old runs. During a rolling mixed-version deployment, old workers can still deliver the old key.
4. Rotate the Composio project API key and update its existing QM credential records after old workers are retired. Keep the same project so connected accounts and user IDs remain valid. Coordinate every deployment sharing the key. Historical sandbox files, snapshots, environment captures and scripts may retain old copies; blocking new materialization cannot revoke them. Rebuild or clean affected sandboxes as appropriate; rotation invalidates old key copies.
5. Configure and test callback verification only after deciding project routing. Existing connections do not need new OAuth consent merely because verification is enabled. Verify one new connection and one read-only operation, plus affected scheduled jobs and shared conversations.

No production credentials, projects, consent settings, fleet pins, or connections are changed by installing this code in a development checkout. Rolling back to an older worker restores its ability to deliver whichever project key it can read and therefore reopens the old boundary.

## SDK assets

Older images and the build pipeline may still contain the credential-free Composio SDK bundle. It is not an authorization mechanism and is no longer used by the standard skill. Keeping or removing that asset does not replace rotating previously delivered keys.
