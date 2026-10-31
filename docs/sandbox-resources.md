# Sandbox resources and defaults

A sandbox is an independently recorded resource with an owning scope, provider, backing identity, and lifecycle state. Creating a sandbox provisions a blank machine without copying files or changing a default. Setting a default changes routing only. Background jobs retain the target on which they started.

Sandbox resources are always on. The `sandbox` tool provides lifecycle management; `execute` is the sole command launcher and `background` controls existing processes. `list` returns the available providers and supported actions. Unsupported provider operations fail explicitly. Files publication is separate from sandbox management.

`execute` accepts `sandbox_id` for both foreground and background commands. Without a target, execution requires the scope's stored default. `set_default` accepts an ID or null; null clears the default. A new scope has no default. Retiring a sandbox requires clearing its default and stopping its jobs first. Retirement is available only for providers with direct scope deletion. It never provisions or restores a machine. Once retirement begins, execution stays blocked; interrupted or failed cleanup remains visible and can be retried. Retirement deletes its working state, so durable outputs should be published to Files or git beforehand.

In Isolated posture, agent inventory and operations stay in the current owning scope. In Open posture, authenticated human turns and owner-authorized scheduled turns can also target the acting person's personal sandboxes and Open shared sandboxes where they are a current member. Access is rechecked for each operation; changing conversations does not transfer ownership or grant other participants personal access. Cross-context execution uses the target's existing workspace without copying the calling conversation's credentials, files, or capability tokens onto it. Defaults remain local to their owning scope. Cross-context commands must satisfy both the calling conversation's and target sandbox's command policies. Network access is narrowed to satisfy both egress policies. Provider-native recovery status includes its own expiry; a sandbox record is not an indefinite backup guarantee.

## Agent actions

| Action              | Parameters                                                        |
| ------------------- | ----------------------------------------------------------------- |
| `list`              | `purpose`; returns providers, capabilities, resources and default |
| `create`            | `backend`, optional `name`, `purpose`; creates a blank resource   |
| `set_default`       | `sandbox_id` or null, `purpose`; changes routing                  |
| `status`, `restart` | optional `sandbox_id`, `purpose`                                  |
| `retire`            | `sandbox_id`, `purpose`                                           |

Commands use `execute(command, sandbox_id?, credentials?, background?)`. Set
`background:true` for a detached job and a process ID. The short `purpose` is saved
with the job and displayed instead of the command; the raw command remains available
in expanded output. `timeout_seconds` is the foreground wall-clock timeout or the
background job lifetime. Background jobs require scoped, durable execution; disposable
scratch and reached-room routing remain foreground-only.

In a shared conversation (anything other than the acting person's personal scope, or a
personal scope whose environment another conversation is attached to), a
command that names a personal, granted, connector, role-broker or org environment
credential runs on the turn's scratch computer instead of the conversation's computer,
including when it asked for the scoped computer or a `sandbox_id`. The scratch computer
is the ordinary per-turn one: same image, the turn's environment and capability tokens,
Files, skills and global mounts, but none of the shared workspace's files. Only that
turn's commands run there. The result tells the model the command moved. Brokered org
service handles (`AGENT_CREDENTIAL_TOKEN`) carry no raw secret and stay on the requested
computer. Personal conversations stage credentials on their own computer.

A background job in a shared conversation that names such a credential starts on its own
job computer: a sandbox record marked job-only, created on the conversation's provider. It
is not listed in the sandbox inventory, cannot be targeted with `sandbox_id` by execute,
files, apps or skills, cannot be made a default, and refuses `send_input`. Only the job's
own controls reach it: poll, stop, watch, the reaper and the web output pane, including
from a later deploy. The process reaper's sweep settles the job's exit and credential
write-back, then destroys the computer and deletes its record. A failed destroy, and a
computer left provisioning for over fifteen minutes, are retried every five minutes; a retire
is skipped if the computer's state changed after the sweep looked. A job computer's backing scope
is named `job-<id>`, and home snapshots and provider checkpoints skip those scopes, so nothing a
job writes to its home outlives the computer. A provider that cannot retire computers (Porter today) refuses such
jobs; the command must run in the foreground.

The `background` tool controls existing jobs with `poll`, `send_input`, `stop`, `list`,
`watch`, and `unwatch`. Process IDs retain their durable saved target even after the
scope default changes. Watches retain their durable monitor registration and wake this
conversation with output or exit. Provider loss or expiry can still interrupt a process.

Execution and process handlers retain existing command-policy, credential authorization,
and output-screening checks. Strict approvals use the called tool identity (`execute`,
a process action such as `background:poll`, or a lifecycle action such as `sandbox:retire`); a sandbox grant cannot
authorize commands. Transcript entries identify the called tool. Removed sandbox command
and process actions and `background start` are not aliases. No database migration or
backfill is needed; existing jobs remain controllable by process ID. Interrupted old tool calls may return an unsupported-action error and require agent recovery with the new tools.

## Upgrade and rollback

Resources and explicit defaults are always enabled. The one-time import of old routing entries has been removed together with the `sandbox_routing` and `sandbox_resource_rollout` tables; an installation must have booted a release that completed the import (it wrote the `explicit-defaults` marker) before upgrading past it. `SANDBOX_SCOPE_BACKENDS` and `SANDBOX_RESOURCES_ENABLED` are no longer read.

Before upgrading from a release without resource-aware readers, drain its cores and workers. Rollback must use a resource-aware release that honors the permanent completion marker. A missing default after import means no default, not permission to recreate an old scoped computer.

Scoped commands require an explicit target or selected default. Disposable scratch computers use the selected computer's provider without reusing its disk or resource identity; with no selection they use the installation provider, without creating a default. An unavailable selected provider fails explicitly rather than substituting another provider.

To move work between providers, create a computer, restore the required work from git or Files, verify it, and select it as the new default. Selection does not copy files or migrate running jobs.

## Tenant isolation

Every stored byte and provider object is keyed by the tenant bound to the request or job; nothing resolves without one.

- Object storage keys are `<S3_PREFIX><area>/<tenant>/<key>`: `transfer`, `docstore` (files and direct uploads), `session-shares`, `deploy-git`, `tool-output`, `app-data`. Home snapshots are `<area>/<tenant>/<scope>.tar` in each provider's snapshot bucket (`sprites-home`, `smolmachines-home`, `e2b-home`, `managed-agents-home`, `modal-home`, and the AWS sandbox prefix); AWS app data is `<data prefix>/<tenant>/<deployment>`.
- Local disk uses the same shape under `DATA_DIR`: `transfer/<tenant>`, `docstore/<tenant>`, `session-shares/<tenant>`, `tool-output/<tenant>`, `workspaces/<tenant>/<scope>`, and `<DEPLOY_GIT_DIR>/<tenant>/<deployment>.git`.
- Provider names are `<prefix>-<first 8 tenant hex>-<scope slug>-<hash of prefix, tenant and scope>`, so two tenants with the same scope id never share a machine. Modal sandboxes carry a `qm-tenant` tag in place of `qm-org`, and the orphan sweep only lists the bound tenant's sandboxes. Deployment app names and public subdomains stay globally unique and are reached only through the tenant's own deployment rows.
- The local Docker backend hands core the host Docker socket and shares the host network, so it serves single-tenant installs only and refuses to provision when the `tenants` table has more than one row.
- Deployment-wide sandbox secrets (`FLY_RESIDENT_ENV_*`, `sandbox.env`, `sandbox.secretEnv`) are refused; a credential that a computer needs lives in the keychain of the scope that owns it. Unset any `FLY_RESIDENT_ENV_*` secrets on the core before upgrading (for example `fly secrets unset`); the core will not start while one is present.

Storage written before tenant prefixes is moved once, at the first start of a core, worker or `node src/migrate-main.ts` on this release, under an advisory lock; completion is recorded in `qm_schema_migrations` as `tenants/storage-layout` and later starts skip the scan. With exactly one tenant it copies each pre-tenant object to its tenant key (an existing tenant copy always wins), deletes the original, and merges legacy `DATA_DIR` directories; with zero or several tenants it refuses. Drain cores and workers of the previous release first: anything they write to an old key after the move is not moved again. The first start can take as long as the copy; restarts resume where it stopped.

Provider machines cannot be renamed. After the upgrade each scope provisions a machine under its tenant name and restores its home from the moved snapshot when its provider keeps home snapshots in S3 (Sprites, smolmachines, E2B, DO Managed Agents and Modal with a snapshot bucket, and AWS). Porter volumes, Agent37 and Superserve keep homes only on the old machine, as do snapshot providers without a bucket: copy needed work to git or Files before upgrading. Retire old-named machines with the provider's own tools afterwards. Running AWS apps restage litestream under the tenant prefix on their next credential refresh; Render apps use the tenant prefix from their next deploy and should be redeployed right after the upgrade.
