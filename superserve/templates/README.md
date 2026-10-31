# Agent template

`qm-agent.ts` builds the `qm-agent-<release>` template used by the Superserve
sandbox backend.

## Contents

The template uses `ubuntu:24.04` on linux/amd64 and includes:

- Shell and file utilities, Git, curl, jq, and SSH.
- Node and npm, Python with a virtual environment at `/opt/agent-venv`.
- Coding-agent CLIs, `gh`, `aws`, and `x-api`.

Tool versions are pinned in the build script. Downloaded Node and CLI archives
are checksum-verified. Python and pip wrappers select the virtual environment
regardless of the exec environment's `PATH`. Commands run as root; QM sets `HOME`
to `SUPERSERVE_HOME_DIR` (default `/root`) and uses `<home>/workspace`.

Deployment tools and skills are installed during provisioning. The optional
browser engine is not included.

The default Superserve sandbox has 8 vCPUs, 16384 MiB (16 GiB) memory, and
32768 MiB (32 GiB) disk. The disk includes the OS and toolchain as well as workspace files,
dependencies, package caches, and build output. Override these with `--vcpu`,
`--memory-mib`, and `--disk-mib` when building. CPU, memory, and disk capacity are set
on the template, not at sandbox creation.

## Build

```sh
export SUPERSERVE_API_KEY=your-superserve-api-key
node superserve/templates/qm-agent.ts --release 0.1.0 --wait
```

`--release` names the template; use the release tag your deployment runs.
`--wait` streams logs until the build completes. Without it, the script returns
after queuing the build. Use `--base-url` or `SUPERSERVE_BASE_URL` to override the
API endpoint.

A ready template with the same name is reused. Failed builds are replaced;
`--force` also replaces a ready template. Names are unique within a team.

Set `SUPERSERVE_TEMPLATE=qm-agent-<release>` on core after the build succeeds.
The backend requires a ready template with this toolchain.

Rebuilding under the same name does not update existing sandboxes. Changing
`SUPERSERVE_TEMPLATE` to a different name replaces them and deletes their resident
files. Export needed files first; see [updates and retention](../../docs/superserve.md#updates-and-retention).

## Increase sandbox capacity

Existing templates and sandboxes keep their original capacity when these defaults
change. Passing `--vcpu`, `--memory-mib`, or `--disk-mib` with an already-ready
template name also reuses that template without resizing it.

To roll out larger sandboxes:

1. Pause ongoing jobs, commit and push source changes to Git, and export other
   needed resident files before replacing sandboxes.
2. Build under a new template name, for example:
   `node superserve/templates/qm-agent.ts --release 0.1.0-8cpu-16ram-32disk --vcpu 8 --memory-mib 16384 --disk-mib 32768 --wait`.
3. Verify it with
   `node superserve/templates/verify-qm-agent.ts --template qm-agent-0.1.0-8cpu-16ram-32disk`.
4. Set `SUPERSERVE_TEMPLATE=qm-agent-0.1.0-8cpu-16ram-32disk` on core and deploy. This replaces
   existing scope sandboxes on use and deletes their old resident files; it does
   not resize them in place. Restore exported work into the new sandboxes.
5. Check `nproc`, `free -h`, and `df -h /root/workspace` in a new sandbox, then
   rerun representative builds and full typechecking before resuming heavy jobs.

Use your deployment's release tag in place of `0.1.0`. A distinct suffix keeps the
old template available during verification. `--force` rebuilds a same-name
template but does not upgrade existing sandboxes. Confirm the requested shape is supported and allow
for the increased CPU, memory, and storage in provider quotas and costs before
rollout.

## Verify

```sh
node superserve/templates/verify-qm-agent.ts --release 0.1.0
```

The verifier creates a sandbox, checks its tools, workspace, Python environment,
and command timeout behavior, then deletes it. It exits nonzero if verification
or cleanup fails. `--template` selects a template directly instead of by release.

`--keep` retains the sandbox for inspection and schedules deletion one hour after
it pauses. Otherwise, automatic deletion on pause backs up explicit cleanup,
including when the verifier is interrupted.
