# Sandbox configuration

Use the admin skill's authorization rules and load `cloud-cli` or `github-gitlab`
when the change needs their access. An admin grant does not supply repository or
cloud credentials. If access is missing, identify the required repository or
provider permission; do not claim the setting is editable through the admin API.

## Find the setting's owner

- Live database connection capacity uses the org `sandbox-settings` resource
  described in the admin skill. Read the saved override and deployment default
  before changing it. A saved override takes precedence over changes to
  `DATABASE_SANDBOX_POOL_MAX` in the deployment.
- Provider selection, machine size, images, execution limits, idle behavior,
  snapshots, and provider credentials come from the running core or worker's
  deployment configuration. The agent computer's own environment is not evidence
  of what core loaded.
- Identify the running release and its configuration source. Read that version's
  provider documentation or `src/config.ts`, `src/wiring.ts`, and the relevant
  `src/sandbox/` implementation to determine names, units, defaults, precedence,
  and when a change takes effect. Inspect provider SDK settings when applicable;
  do not maintain a second list of every supported field here.

## Edit the existing configuration

Follow the deployment repository's instructions. Package deployments use their
pinned `@yc-software/qm` CLI and `qm.config.jsonc`; source forks may keep private
configuration in `deploy/layers/<org>/`. Other deployments use their existing
infrastructure manifests or provider configuration.

In CLI deployments, provider settings consumed by core normally belong in
`env.core`; preserve matching settings on separately deployed workers. The
`sandbox.env` field configures the agent computer and is not a substitute for
core's provider settings. Put credentials in the deployment's existing secret
store, using `secretEnv` mappings where supported. Inspect only the necessary
non-secret values and secret references; never dump environments or secret values.

Change the durable source of truth so a later deployment does not undo the edit.
Validate with that deployment's existing checks and inspect the resulting plan
before applying it. For CLI deployments, use `qm check` and `qm plan` through the
pinned CLI. These checks do not prove provider credentials or remote capacity.

Distinguish a saved change from an applied one. Provider environment changes
require the affected processes to restart through the authorized deployment
workflow; existing computers may keep their old settings or be replaced on their
next operation. Explain that effect for the selected provider before applying.
Changing snapshot destinations does not migrate existing recovery data. After
application, verify the requested behavior with a small sandbox operation and
report the changed setting, application status, and any unverified effect.
