# Agent37 as an agent-computer backend

Vishnu from Agent37 here. You asked whether we could host qm. The honest answer is that the part of qm that wants hosting is the agent computer, so this is a fifth sandbox backend, next to Sprites, smolmachines, Porter and AWS.

Agent37 rents isolated Linux machines over a small REST API: create, exec, start, stop, delete. Each one keeps its disk, goes to sleep when idle, and comes back when the next command arrives. That is the lifecycle your Sprites and smolmachines backends already assume, so the mapping is direct: one Agent37 instance per qm scope, created on first use, named after the scope so an operator can recognise it in their Agent37 dashboard, deleted when qm tears the scope down.

What the PR adds

- `SANDBOX_BACKEND=agent37` with `AGENT37_API_KEY`. Optional knobs: `AGENT37_API_BASE_URL`, `AGENT37_NAME_PREFIX`, `AGENT37_TEMPLATE`, `AGENT37_CPUS`, `AGENT37_MEMORY_GB`, `AGENT37_DISK_GB`, `AGENT37_EGRESS_PROXY_URL`, and the shared `SANDBOX_TIMEOUT_SEC`.
- `src/sandbox/agent37-sandbox.ts`, modeled on the smolmachines backend. Provision creates the instance and waits for it to run. Run is our exec endpoint. Teardown with destroy deletes the instance. Files move over the same exec endpoint in base64 chunks, the way the Porter backend does it, because our API has no separate file transfer. Process sessions, home backup, ro layers and blob staging come from the shared exec helpers unchanged.
- Exec on our side returns within 280 seconds and caps each stream at 512 KiB. Longer commands run detached and are polled; larger output is spooled to disk and read back in chunks, so the agent never sees a truncated result.
- A command sent to a sleeping instance starts it first, then runs. That is a retry inside the backend, not a heartbeat; the provider decides when a machine sleeps.
- Profile: `writablePersistence: "resident_disk"`, `processSessions: true`, `egressEnforcement: "none"`. Our sandboxes reach the public internet and nothing private, but there is no per-domain allowlist, so the backend declares none rather than pretend.

What it does not do

- No idle reaping and no snapshot to the workspace. The disk is the machine's own and survives sleep, stop and start.
- No image plumbing. The default template, `agent37-qm-computer`, is built from your `sandbox-base` image and published on our side, so the tools qm expects are the tools it gets. A different Agent37 template can be named with `AGENT37_TEMPLATE`.
- No new CLI target. `qm init` still deploys the core to Fly, AWS or Porter; this only changes where the computers live.

Tests run against an in-process fake of our API, so CI needs no Agent37 account. We would rather this live upstream than in a fork, and we will keep it green as the sandbox contract moves.
