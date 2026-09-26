# External Slack workspaces

External workspace access is opt-in. Without this configuration, existing Slack identity, context, and authorization behavior is unchanged.

Add `externalAccess` to the selected `SLACK_ACCOUNTS` entry:

```json
{
  "id": "partners",
  "botToken": "<bot token>",
  "appToken": "<Socket Mode token>",
  "externalAccess": {
    "companyDomains": ["company.example"],
    "serviceCredentials": ["public-search"]
  }
}
```

For the default Slack account, set `SLACK_EXTERNAL_ACCESS` to the JSON value of `externalAccess`. The same policy works with HTTP Events accounts. Account IDs must be unique, including the implicit `default` account. Apply the configuration to core and workers together, then restart them.

## Identity and public work

Slack's authenticated user profile must contain an email whose exact domain is in `companyDomains`. Case is normalized. Subdomains are not implicitly included. Workspace membership, guest status, and Slack Connect status do not establish company identity. Missing emails, non-company emails, deleted users, and bots cannot initiate work. `allowFrom`, if configured, can further restrict access.

Every non-DM conversation in an opted-in workspace has an external audience, including private channels and group DMs with an apparently staff-only roster. Its computer and conversation use a workspace-and-policy namespace. Enabling this policy, or changing its allowlists, starts a fresh restricted namespace rather than exposing an older computer or retained private context.

The channel agent can answer and execute code using its own restricted computer. It does not preload personal or organization memory, files, skills, private instructions, keychain inventory, connected apps, or MCP tools. Open sharing and admin privileges do not widen this context. Other resource operations must continue privately rather than using the channel as a route to private data.

`serviceCredentials` is an explicit external-use allowlist, not an alternative to existing service credential grants. A service must pass both checks and remain enabled. An organization-wide grant alone does not make a service safe for an external audience. Leave the list empty unless the service and everything it can return are suitable for the workspace's audience. In particular, do not add a confidential company search or database credential just because everyone at the company can use it internally.

## Private continuation

When the request needs personal context or a private service, the agent finishes the channel turn with a self-only continuation directive. The platform:

1. Loads the originating request, not a model-selected recipient.
2. Rechecks the employee's current Slack profile on the originating account.
3. Opens that employee's DM and acknowledges the move in the source thread.
4. Queues a normal personal-context turn with the original request, relevant channel history, and incoming attachments.
5. Delivers results and approvals privately. There is no automatic result bridge back to the channel.

This is a general continuation mechanism, not a calendar-specific workflow. Existing personal authorization and approval rules still apply. Run idempotency prevents Slack redelivery from executing the private task twice. If a process stops after admission, the existing durable result-delivery path recovers the DM response using its recorded Slack account and workspace.

## Operational limits

- Explicit mentions, genuine replies in an engaged thread, and employee DMs are supported. Passive ambient ingestion is disabled for opted-in accounts so it cannot start an unclassified alternate turn.
- Existing shared-scope approvals and legacy personal-agent bridges are not resumed in an opted-in workspace. Start a fresh request so it receives the current boundary.
- Old shared replies without the restricted namespace are not released into an opted-in workspace during delivery recovery. Unprovenanced historical shared Slack requests are refused when an external policy is configured.
- Restricted sessions cannot be resumed through a surface that omits their authenticated workspace policy. Normal private DMs are unaffected.
- Configuration is deployment-level; there is no new admin UI in this change.
