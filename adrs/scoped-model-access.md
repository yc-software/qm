# Scoped model access

Today every org member sees and can use every model the org has enabled. The web picker list lives in `webui_model_configs` and is read through `getWebuiModelsDurable(id)`, which falls back to the org row, but every caller passes the org scope: `getSurfaceConfig` in `src/api/routes/surface.ts`, web turn validation in `src/api/app-turn.ts` and `src/api/runtime-config.ts`. So the store can hold a per-scope list, but nothing reads one. When no list is set, the picker and validation fall back to the whole selectable catalog for the harness (`defaultWebuiModelIds`, `DEFAULT_WEBUI_MODEL_IDS`, overlays, gateway models). The org runtime model is always added to the enabled set.

What is scoped already is defaults, not access. `base_model_configs` holds a runtime selection per scope (org, personal, `group:web-project-<id>`) with `orgRevision` tracking, so a project or person can have a different default model. Purpose runtimes (`cron`, `subagent`, `fallback`) and approved harnesses (`approved_harness_configs`) are org-only. The title and auxiliary model comes from harness config. Turn validation checks that a provider is configured (`modelServiceable`) and that the requested model is in the org list, and nothing else. There is no notion of "this project may not use model X" or "only these people can try model Y".

That makes three common needs awkward:

- Cost control: keep expensive models to the people or projects that need them.
- Data residency: a sensitive project should only reach models hosted in an approved region, while the rest of the org can use a region-restricted provider or anything else.
- Trials: let a small group try a new model before it goes to everyone.

Goals: allow or deny models per org, project, group and user; enforce it on the server for every model call, not only in the picker; cover crons, loops, subagents and the title model; no behaviour change unless an admin configures something.

Non-goals: per-model spend budgets or rate limits (separate ADR), provider key management, changing how defaults resolve, and per-message model routing.

Options I looked at:

- A. Per-scope allowlists. Actually read `webui_model_configs` at project and personal scope instead of always using the org row. Smallest change, but an allowlist alone cannot say "everyone except this project", lists drift from each other, and groups have nowhere to live.
- B. A small policy object per scope: `allow` and `deny` lists of model ids or patterns (for example a provider prefix), at org, project, group and user scope, with clear precedence. A bit more work, but it covers all three cases and reads well in an audit log.
- C. Reuse the existing config scopes only, as A but with "inherit / replace" semantics like base models. Familiar, but still no deny and no groups.
- D. Role based: models attached to roles, roles given to people. Fits large orgs, but QM has no general RBAC today and this would be the first piece of it, which feels like the wrong place to start.

I'd go with B, built on the same scope ids and artifact-map pattern as `base_model_configs`, so it feels like the other scoped settings and A becomes the special case of a policy with only `allow`.

Precedence:

- The effective set starts from what the org has enabled today (the existing picker list or catalog). Policies can only narrow it or grant from it, never add a model the org has not configured.
- Most specific scope wins for allow: user, then project, then group, then org.
- Deny overrides allow at any scope. A project deny cannot be lifted by a user allow, which is what makes the data residency case safe.
- The effective set for a turn is the intersection of what the user may use and what the project or scope the turn runs in may use. A personal allow does not leak into a restricted project.
- Org admins can override (for example to debug), recorded in the audit log, and never silently.

Enforcement:

- One resolver, `effectiveModels(principal, scope)`, used by the picker, `getSurfaceConfig`, turn validation, and the model call path itself, so a direct API or Slack request cannot bypass the picker. A refusal returns a clear reason instead of a bare 403 (see #952 for the current confusion).
- Crons, loops and monitors resolve against their owner scope and the owner principal at fire time, not at creation time. Subagents inherit the parent turn's effective set. The title and auxiliary model and the `fallback` purpose runtime are checked too. If the configured one is not allowed, fall back to an allowed default for that scope, or skip titling, rather than calling a denied model.
- Defaults: if a scope's default (`base_model_configs`) is not in its effective set, the admin UI warns when saving, and at turn time the next allowed default is used.
- Existing sessions on a model that is now disallowed: the next turn is refused with a message offering to switch to an allowed model, rather than switching silently. Running turns finish. Scheduled jobs on a denied model are paused with a visible reason, not dropped.

Admin UI and API: a "Model access" card next to the existing harness/model card, available at org, project and group scope (also closing the org-only gap in #589 and #821), plus a per-user view under members. `GET`/`PUT` on the existing admin scope-config resource for a new `modelAccess` key, and a read-only "effective models for this person in this project" endpoint so admins can check the result.

Audit: `model_access.update` with actor, scope and before and after; `model_access.refused` (sampled or rate-limited) for turns or jobs refused by policy; `model_access.admin_override` when an admin bypasses it.

Migration and defaults: additive. With no policies set, the resolver returns exactly today's org set, so nothing changes until someone configures a policy. The `webui_model_configs` org list keeps its meaning as the org baseline.

Security: enforcement must be on the server and on every path that reaches a provider, including the gateway and custom providers. Policies reference model ids, so overlays and gateway aliases need to resolve to a canonical id before matching, or a deny can be bypassed by an alias. Users should not be able to see the contents of other scopes' policies, only their own effective list. Pattern matching should be simple prefixes, not regex.

Related: #952 (validation falls back to defaults and refuses picker models), #589 and #821 (harness/model card only at org scope), #1094 (team entitlements for shared MCP servers, a similar shape), #1319 (fallback model when changing harnesses).

Open calls if the direction looks right: whether groups should be a new object or reuse Slack channel membership; whether personal scope policies can be set by the user themselves (only to narrow) or by admins only; whether a denied scheduled job should pause or fall back to an allowed default; whether harness approval should move into the same policy later; and whether provider-level rules (for example "only models served from region X") belong here or in provider config. Happy for you to implement once you're aligned.
