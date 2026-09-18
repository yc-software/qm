# Google Workspace action controls

Set `GOOGLE_WORKSPACE_GUARDED=true` in core to use the trusted Google tools with each requesting person's connected Google account. The default is `false` for compatibility. Sign-in establishes identity; users still connect Google through Connections and grant the required OAuth scopes separately.

`google_workspace_request` reads, creates, and edits Drive files and native Docs, Sheets, and Slides. Binary files such as PowerPoint use base64 uploads, limited to 10 MiB. Drive metadata edits support names and descriptions; creation and copying support a parent folder. Native document editing can remove content such as paragraphs, slides, or sheet tabs. Whole-file deletion, permission changes, moving existing files between folders, and arbitrary Google APIs are unavailable through this tool.

`google_workspace_trash` requests a one-time approval before moving a file or folder to Google Drive trash. The existing Slack or web confirmation identifies the account, target, and observed folder descendants. Only the requester may approve. Session and permanent approval grants cannot authorize trash. Permanent file deletion and emptying trash are unavailable. Trash remains subject to Google's retention and recovery rules.

Approvals are stored durably, uniquely identified, and consumed atomically. Each retry fetches fresh metadata and binds approval to the requesting person, connected account identity, target, and observed descendants. Changed metadata requires another approval. Folder previews are limited to 100 descendants and must fit the approval card; incomplete or oversized previews fail closed. Google does not provide an atomic snapshot of a folder tree: concurrent changes after enumeration can still affect what is moved. The target ETag is checked when Google supplies one; this does not lock descendants.

Guarded mode keeps managed Google OAuth tokens in core. It blocks their sandbox environment injection, keychain materialization, derived credential export, and reuse by arbitrary MCP servers. The tools use the actor's selected account (`default`, `personal`, or `company`), with no operator or other-user fallback. They follow the existing shared-conversation personal-keychain rules and are unavailable to read-only or automated turns. Gmail's trusted sent-mail viewer continues to work; general Gmail and other Google APIs are not provided by these tools.

## Rollout

Before calling this an enforced restriction, revoke and reconnect previously exported Google OAuth grants, clear credentials from existing sandboxes, and restrict shared service accounts to their intended automation. Manually saved raw credentials and static third-party credentials are separate access paths; this switch cannot revoke them. Turning the setting off restores legacy token access.

Enable the Drive, Docs, Sheets, and Slides APIs required by the deployment. Test read/create/edit and approval/deny with disposable fixtures before rollout. Audit events record attempts, approval requests, and outcomes. Avoid deploying unrelated upstream changes solely to enable this setting; assess runtime and database compatibility first.
