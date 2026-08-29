# Telemetry

qm can share anonymous usage telemetry with the qm project via PostHog. It is **off by
default** and does nothing unless an operator turns it on. This page is the complete
list of what is sent; if an event or property is not on this page, it is not collected.

## How to turn it on or off

- Admin panel → org scope → **Usage telemetry** toggle (org-wide, default off). This is
  the only way to turn telemetry on; the setting is durable and re-checked on every
  flush, so flipping it off stops every process of the deployment within about 30
  seconds and drops anything still buffered.
- `TELEMETRY_DISABLED=true` env var is a hard kill switch that wins over the admin
  toggle; it can only disable, never enable.
- `POSTHOG_API_KEY` must be set for telemetry to exist at all; without it the entire
  subsystem is a no-op, regardless of the toggles.
- `POSTHOG_HOST` overrides the ingestion endpoint (default `https://us.i.posthog.com`),
  e.g. for the EU cloud or a self-hosted PostHog.

## Identity and what is never sent

Events are tied to a single random UUID generated on first boot and stored in Postgres
(`telemetry_instance`). It identifies the deployment, not any person, and contains no
information about your organization.

Never sent, under any setting: message or prompt content, memory content, file names or
contents, skill names or bodies, credential values or service hosts, user or principal
identifiers, channel or session identifiers, Slack workspace identifiers, resource
names, error messages or stack traces, or your org name. Properties are limited to
enums, counts, durations, and the deploy's git SHA (`version`). Every event also sets
`$geoip_disable: true` and `$process_person_profile: false`, which tells PostHog to skip
GeoIP enrichment and create no person profile. PostHog records the sending server's IP
unless the receiving project enables its **Discard client IP data** setting — the qm
project's PostHog instance has that enabled, and anyone pointing telemetry at their own
PostHog project should enable it too.

Events buffer in memory and flush to PostHog every 30 seconds and on shutdown. Delivery
is fire-and-forget: telemetry failures never block or fail any user-facing operation.

## Events

Every event carries `version` (git SHA, when known) and, where noted, `scope_kind` — the
kind of scope the action happened in (`personal`, `channel`, `team`, `group`, `org`, or
`unknown`), never the scope's identity.

| Event                                                               | Properties                                                          | Fired when                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `instance_started`                                                  | `background_work`                                                   | a core or worker process starts                                              |
| `instance_heartbeat`                                                | —                                                                   | daily per deployment                                                         |
| `harness_invoked`                                                   | `harness`, `model`, `scope_kind`                                    | a harness runs (may exceed turn counts: re-prompts and retries invoke again) |
| `turn_completed`                                                    | `status`, `scope_kind`, `duration_ms`, `tool_calls`, `model_calls`  | a turn finishes                                                              |
| `memory_auto_captured`                                              | `scope_kind`, `duration_ms`                                         | the post-turn memory capture runs                                            |
| `error_recorded`                                                    | `category`, `code`, `scope_kind`                                    | an internal error is logged                                                  |
| `trigger_fired`                                                     | `surface` (`cron`/`webhook`/`monitor`/`keychain-ask`/`secret-drop`) | unattended work runs                                                         |
| `session_forked` / `session_spawned`                                | `scope_kind`, `status`                                              | a session is forked / spawned                                                |
| `skill_installed` / `skill_promoted` / `skill_archived`             | `scope_kind`, `status`                                              | skill lifecycle                                                              |
| `skill_pack_imported`                                               | `scope_kind`, `status`                                              | a skill pack import                                                          |
| `cron_created` / `cron_deleted`                                     | `scope_kind`, `status`                                              | cron lifecycle                                                               |
| `webhook_created`                                                   | `scope_kind`, `status`                                              | an inbound webhook is registered                                             |
| `web_app_deployed` / `web_app_published` / `web_app_rolled_back`    | `scope_kind`, `status`                                              | web-app deploy lifecycle                                                     |
| `connector_connected` / `connector_revoked` / `connector_token_set` | `scope_kind`, `status`                                              | connector lifecycle                                                          |
| `credential_added` / `credential_deleted`                           | `scope_kind`, `status`                                              | keychain writes                                                              |
| `file_uploaded` / `file_shared`                                     | `scope_kind`, `status`                                              | file activity                                                                |
| `memory_updated` / `memory_captured`                                | `scope_kind`, `status`                                              | memory writes                                                                |
| `project_created` / `project_member_added`                          | `scope_kind`, `status`                                              | project lifecycle                                                            |
| `grant_created` / `grant_revoked`                                   | `scope_kind`, `status`                                              | resource sharing                                                             |
| `environment_created`                                               | `scope_kind`, `status`                                              | a sandbox environment is created                                             |
| `onboarding_status_set`                                             | `scope_kind`, `status`                                              | onboarding status changes                                                    |
| `config_updated`                                                    | `section`, `scope_kind`, `status`                                   | an admin config section is saved                                             |

The `status` property, when present, is the short outcome code the audit log already
records (for example `ok` or `denied`); `section` is the admin resource id (for example
`security-posture` or `runtime`). Audit-derived events also carry `audit_action`, the
internal audit action name they were mapped from.

Most of these derive from the audit log: the telemetry layer forwards two explicit
allowlists — `AUDIT_TELEMETRY_EVENTS` and `CONFIG_UPDATE_ACTIONS` in
`src/insights/telemetry.ts` — and forwards only the fields above. Any audit action not
on those lists emits nothing.
