# Google Workspace action controls

## Objective

Provide per-person Google Drive, Docs, Sheets, and Slides access with reads, creation, and editing available, a mandatory one-time human approval before moving a file or folder to trash, and no permanent deletion or empty-trash operation.

## Architecture

A trusted Google Workspace service in core owns OAuth use. Agent tools receive results, never bearer tokens. Reuse the dynamic tool interface and existing durable approval records and Slack/web approval cards. An operator-enabled GOOGLE_WORKSPACE_GUARDED setting switches Google OAuth credentials from materialization to the trusted service; default remains compatible for other deployments. The credential store must deny raw materialization for all Google provider hosts when enabled, including grants, own-credential use, standing grants, and derived authentication paths. Orchestrator injection must skip every Google provider host. No operator-token fallback is allowed by the new service.

Two explicit tools expose Google operations: google_workspace_request for allowlisted read/create/update operations, and google_workspace_trash for a single target. The request tool must reject arbitrary hosts, redirects, authentication overrides, HTTP method overrides, batch envelopes, legacy APIs, and any Drive fields capable of trashing. Drive uploads use bounded base64 data handled inside core. Native Docs/Sheets/Slides batch operations edit document contents, not whole-file deletion. Permanent file deletion, emptying trash, sharing/permissions changes, and arbitrary API calls are unavailable.

Trash first retrieves authoritative target metadata. A file approval names its title and ID and identifies moving to trash as recoverable. A folder approval includes the affected descendants (bounded; oversized or incompletely enumerable folders fail closed). The approval key binds actor, account, target and metadata snapshot; changed target/contents requires a new approval. The service must require approval through the core callback and never trust an approved boolean from tool arguments. Only the requester may approve, only once; session/always grants cannot authorize trash. Keep confirmations in the existing requesting conversation or existing requester-DM route. All attempts and outcomes are audited using the durable core audit store. No persistent in-memory approval state.

## Rollout

Do not claim enforcement for credentials outside this service. Shared service accounts, existing raw user credentials, cached OAuth tokens, and third-party connector credentials are separate access paths. Production cutover must isolate the automation service account, revoke the old OAuth grant and reconnect, and clear old sandbox credentials before enforcement can be claimed. Do not upgrade a live deployment across unrelated upstream changes without assessing compatibility.

## Validation

Use fake Google transport for adversarial endpoint/body validation tests and account-binding tests. Verify exact approval before any trash mutation, denial and replay behavior, changed folder snapshot, foreign-user approval, permanent-delete rejection, and raw-token materialization denial. Run affected tests, typecheck and lint. Independently review security boundaries. Boot a real dev instance and exercise approval UI before PR. Live Google tests use explicitly disposable files only; do not permanently delete anything.

## Constraints

No new code comments. No private organization data in upstream code, docs, fixtures, commits, screenshots, or PR text. TypeScript on Node >=24.15.0. Durable state uses existing Postgres-backed stores. User approved implementation and delegated confirmation-placement choice.
