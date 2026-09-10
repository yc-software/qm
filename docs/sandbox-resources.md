# Sandbox resources and defaults

A sandbox is an independently recorded resource with an owning scope, provider, backing identity, and lifecycle state. Creating a sandbox provisions a blank machine without copying files or changing a default. Setting a default changes routing only. Background jobs retain the target on which they started.

Before activation, agents have `execute`, `background`, and `sandbox` with `status` and `restart`. With `SANDBOX_RESOURCES_ENABLED=true`, a single `sandbox` tool replaces the advertised `execute` and `background` tools and provides management, command execution, and process control. `list` returns the available providers and supported actions. Unsupported provider operations fail explicitly. Files publication is separate from sandbox management.

`sandbox` actions `exec` and `start_process` accept `sandbox_id`. Without a target, execution requires the scope's stored default after activation. `set_default` accepts an ID or null; null clears the default. A new scope has no default. Retiring a sandbox requires clearing its default and stopping its jobs first. Retirement is available only for providers with direct scope deletion. It never provisions or restores a machine. Once retirement begins, execution stays blocked; interrupted or failed cleanup remains visible and can be retried. Retirement deletes its working state, so durable outputs should be published to Files or git beforehand.

The initial agent interface restricts inventory and operations to the current owning scope, in addition to actor authorization. It does not yet offer cross-conversation access to every resource a person can access. Provider-native recovery status includes its own expiry; a sandbox record is not an indefinite backup guarantee.

## Agent actions

| Action              | Parameters                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| `list`              | `purpose`; returns providers, capabilities, resources and default                                           |
| `create`            | `backend`, optional `name`, `purpose`; creates a blank resource                                             |
| `set_default`       | `sandbox_id` or null, `purpose`; changes routing                                                            |
| `status`, `restart` | optional `sandbox_id`, `purpose`                                                                            |
| `retire`            | `sandbox_id`, `purpose`                                                                                     |
| `exec`              | `command`, `purpose`, optional `sandbox_id`, `timeout_seconds`, and supported routing/credential parameters |
| `start_process`     | `command`, optional `sandbox_id`, `timeout_seconds`, `purpose`; returns a process ID                        |
| `read_process`      | `process_id`, optional `since_cursor`, `wait_seconds`, `max_bytes`                                          |
| `write_stdin`       | `process_id`, `data`; newline is not appended                                                               |
| `signal_process`    | `process_id`, optional `signal` (`TERM`, `KILL`, `INT`, `HUP`, `QUIT`)                                      |
| `list_processes`    | lists jobs belonging to this scope                                                                          |
| `watch_process`     | `process_id`, optional `since_cursor`, `pattern`, `instructions`; returns a monitor ID                      |
| `unwatch_process`   | `monitor_id`                                                                                                |

Process actions also accept optional `purpose` for approval context. Unrelated fields are rejected rather than silently ignored. `exec` retains the enabled scoped, scratch, owner-auth and reached-room routing options and command credential handles. Process starts use the default or a named authorized resource; subsequent operations use the process ID's durable saved target, even after the scope default changes. Watches retain their durable monitor registration and wake this conversation with output or exit. Provider loss or expiry can still interrupt a process.

Execution and process handlers retain their existing approval and output-screening paths. Strict sandbox approvals are scoped to each action (`tool:sandbox:exec`, for example); an older broad `tool:sandbox` grant does not authorize newly exposed command or process actions. Transcript entries identify the actual `sandbox` action. Files publication, application deployment, and file read/write remain separate capabilities; unsupported resize and clone actions are not advertised.

## Staged activation

The feature defaults off. Deploy this reader-compatible version to every core and worker and retain a compatible rollback release before enabling it. Drain pre-feature cores and their in-flight work before activation. Compatible readers coordinate legacy record publication and migrations with the activation lock; ordinary provider provisioning remains concurrent. An older binary cannot be made safe by a lock introduced in a newer binary.

On activation, startup completes a durable, locked backfill before accepting new work. It preserves explicit defaults, existing routing, session scopes, provider records, and original backing identities. It makes no provider calls or disk copies. Inferred resources start unverified. The activation marker is written last, so an interrupted backfill can be retried. Legacy provisioning selected before activation may complete afterward: its inventory publication fills only a missing default and preserves an explicit selection or null. Legacy migrations complete before backfill or are refused after activation.

The activation marker is permanent: after it exists, a missing default means no default even when the feature flag is turned off again. Turning the flag off restores the legacy `execute` and `background` tool names and hides new management operations; it does not restore implicit computer creation or move running jobs. Rollback must use a reader-compatible release.

Agent-facing migration is retired. Existing operator migration refuses scopes with managed defaults. Provision, verify on the named target, then select a default explicitly when moving work between providers; copying files is optional.
