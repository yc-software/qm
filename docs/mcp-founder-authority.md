# Founder analytics MCP authority

The founder analytics connector has two independent authorization layers. Its
encrypted MCP credential authenticates this QM instance to Command Center. A
short-lived Ed25519 envelope authorizes one exact human request from the
founder's personal Slack DM. A machine credential alone is never treated as
end-user authority.

This path is default-off. Configure all of the following values or none of
them; a partial configuration fails startup:

```text
QM_MCP_AUTHORITY_ISSUER=qm:prod
QM_MCP_AUTHORITY_ORGANIZATION_ID=<exact Command Center organization id>
QM_MCP_AUTHORITY_PRINCIPAL_ID=<exact canonical lowercase founder email>
QM_MCP_AUTHORITY_SLACK_TEAM_ID=<exact T... workspace id>
QM_MCP_AUTHORITY_SLACK_USER_ID=<exact U... founder id>
QM_MCP_AUTHORITY_SLACK_DM_CHANNEL_ID=<exact D... personal-DM channel id>
QM_MCP_AUTHORITY_ED25519_PRIVATE_KEY=<base64 DER/PKCS8 Ed25519 private key>
QM_MCP_AUTHORITY_ED25519_PREVIOUS_PUBLIC_KEYS=<comma-separated base64 DER/SPKI public keys during rotation>
QM_MCP_AUTHORITY_TTL_SECONDS=30
```

Provision the matching public key in Command Center as base64 DER/SPKI. Keep
the private key only in QM's secret store. The configured principal is a
trimmed, lowercase email address placed in the signed envelope; the configured
Slack user is independently checked against the trusted human actor on every
turn. Slack-id identity mode remains available to every other QM product path
but cannot satisfy this analytics authority contract.
The authority issuer and public key are matched exactly by Command Center.
During rotation, place no more than three prior public keys in the optional
overlap setting until every delivery sealed by them has drained, then remove
them. Prior-key cards are accepted only when their issuer, organization,
canonical email principal, workspace, Slack user, and DM channel still match
the current fixed configuration. New authority and delivery signatures always
use the current private key.

The QM MCP server record must pin the only allowed remote tool with these
closed contract fields in addition to its exact reviewed input schema:

```json
{
  "name": "analytics_query",
  "label": "Analyze account",
  "status": "Analyzing account",
  "readOnly": true,
  "requestAuthority": "qm.ed25519.founder-dm.v1",
  "nativeRenderer": "qm.analytics.card.v1",
  "inputSchema": {}
}
```

Replace the placeholder schema with the exact schema discovered and reviewed
from the analytics MCP server. QM refuses drift between the stored schema and
the live tool contract.

For a normal human Slack DM turn, QM derives the team, user, `D...` channel,
message timestamp, thread timestamp, and visible tool arguments from trusted
runtime state. The email-keyed application principal and raw Slack `U...` user
ID travel as separate hidden ingress values and must independently match their
exact configuration. External turn bodies cannot assert either trusted Slack
identity value. QM completes OAuth, freshly lists and revalidates the exact
tool contract, and resolves an all-public DNS set before it signs a fresh
`jti`, canonical body hash, issue time, and expiry. It mints and injects
`X-Risely-QM-Authority` immediately before the upstream `tools/call`; cold
discovery time therefore cannot consume the envelope TTL. It never forwards
model- or caller-supplied authority. Requests from web, group channels, other
users, other workspaces, other DMs, or calls through the context-free MCP
method fail closed.

Every real MCP HTTPS request disables agent pooling, ignores proxy-agent
defaults, pins the connection through one address from that request's fresh
all-public DNS result, preserves TLS SNI and certificate validation for the
original hostname, and verifies the connected socket's `remoteAddress`
against the same result before accepting response bytes.

The analytics server returns a closed `qm.analytics.card.v1` object in MCP
structured content. QM validates every field and the exact signed authority
echo, rejects remote Block Kit or action payloads, constructs Block Kit
locally, and queues it only to the current Slack destination with a receipt-
derived durable idempotency key. The remote server cannot choose a card
destination or author Slack blocks. The accepted card is sealed by QM against
the actual persisted delivery target, including a top-level `D...` DM target
without an invented thread suffix, stored outside the public destination
object, and verified again against that exact target before rendering. Native
card delivery reads Slack history before every post using its durable creation
time and idempotency metadata, so a restart or lost acknowledgement converges
without a duplicate. Failed verification remains pending for retry instead of
being acknowledged as delivered.

Activation still requires independent review, the paired Command Center
successor and database migrations, exact issuer/key/identity agreement, a
dedicated least-privilege Auth0 client, the reviewed MCP server record, and
live founder-DM acceptance tests. No configuration in this repository is
deployment evidence.
