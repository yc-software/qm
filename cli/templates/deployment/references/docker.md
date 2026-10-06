# Local Docker

Run QM on the operator's own machine with `target: "docker"`. This is a peer
hosting option to Fly and AWS, not a cloud-account prerequisite. The host must
remain running for QM to stay available; the operator owns backups and updates.

## Preflight and configuration

Run these on the intended host and confirm the active Docker context with the
operator. Do not silently deploy onto the assistant's computer instead:

```bash
docker context show
docker info
docker buildx version
```

Use a local Linux-container Docker engine with a readable Unix Docker socket.
The local agent-computer backend gives trusted core access to that socket,
which is host-level authority. Confirm this is acceptable. Do not expose the
Docker daemon over an unauthenticated TCP endpoint.

Initialize with `qm init . --org <slug> --target docker` using the package
command in `deployment.md`. The default scaffold enables only core and web UI.
Before setup, merge the following into `qm.config.jsonc` to enable the full
signed-in experience and local agent computers:

```json
{
  "services": ["core", "web-ui", "admin", "portal", "auth"],
  "publicUrl": "http://localhost:8081",
  "sandbox": { "backend": "local" },
  "secretEnv": { "core": { "ADMIN_GRANTS": "ADMIN_GRANTS" } },
  "env": {
    "core": { "HARNESS": "pi" },
    "auth": { "AUTH_EMAIL_TRANSPORT": "smtp" }
  }
}
```

Preserve other choices, including the model or gateway configuration. With the
default base port 8080, the portal is at 8081 and direct web UI at 8082; use the
portal for sign-in. If changing `basePort`, update `publicUrl` to basePort + 1.
Confirm the ports are free. Docker publishes service ports on host interfaces,
not just loopback: keep them firewalled from untrusted networks, including the
direct core/web ports. A localhost URL alone does not restrict port exposure.
For remote access, configure a trusted HTTPS front door and matching public
origin deliberately; do not expose the raw stack as a shortcut.

Follow `sign-in.md` for password onboarding without email transport, or choose
another sign-in route. Set `ADMIN_GRANTS` and the email allowlist before setup. The broker requires
an `AUTH_EMAIL_TRANSPORT` selection even for password-only onboarding; choosing
`smtp` does not require email credentials when email setup is declined.
Set `PUBLIC_API_URL` in `.env` to a core URL reachable from the agent containers,
normally `http://host.docker.internal:8080` (adjust for `basePort`). Do not use
`localhost` for this value: inside an agent container it points to that container,
not core. Verify connectivity with a real agent tool call.

`qm up` builds a local agent runtime from the pinned sandbox base and gives
each agent computer its own container and persistent home volume. No Fly,
AWS, or hosted sandbox credential is needed for this route.

## Deploy and verify

```bash
npm exec qm -- setup
npm exec qm -- check
npm exec qm -- plan
npm exec qm -- up
npm exec qm -- doctor
npm exec qm -- status
npm exec qm -- conformance
npm exec qm -- outputs --json
```

Docker reads the private `.env` directly; `secrets push` requires no upload.
`check --live` and `rollback` are not implemented for Docker. Do not report a
private live session canary as passed. Instead, require healthy services,
conformance, real administrator sign-in through the portal, a web response and
generated sidebar title, and the agent-computer proof below. Repeat `qm up` and
confirm it reconciles the same deployment and preserves its data. Complete the
connector and optional Slack checks from `deployment.md`; external OAuth
providers may require a callback origin other than localhost.

## Agent-computer proof

Ask the signed-in agent to write a fresh UUID to
`/root/workspace/qm-computer-proof.txt`. On the Docker host, select its container
using the exact scope ID and organization labels:

```bash
docker ps --filter label=qm.sandbox=1 --filter label=qm.org=<org-id> \
  --filter label=qm.scope=<scope-id> --format '{{.ID}}'
docker exec <one-matching-container-id> cat /root/workspace/qm-computer-proof.txt
```

Require exactly one matching container and the same UUID, not merely a claim in
the transcript. A missing or ambiguous match is a failed proof.

## Operations and data

```bash
npm exec qm -- status
npm exec qm -- logs core --follow
npm exec qm -- down
```

`down` removes the stack containers but preserves database/core volumes. It is
not a complete cleanup of agent containers and their home volumes. Never use
`down --purge` without separate approval: it deletes database/core volumes.
Back up durable data before upgrades; recover by restoring the known-good
package/config/image pins and running `qm up`, with compatible data restoration
if a migration requires it. Docker does not provide a `qm rollback` command.
