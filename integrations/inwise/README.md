# Inwise OSS for QM

This directory is a first vertical slice for connecting a user's local Inwise OSS meeting memory to a QM sandbox without an Inwise Cloud account.

The bridge has three trust zones:

```text
QM sandbox                 self-hosted relay                 user's laptop
inwise CLI  -- HTTPS -->   opaque request router  <-- HTTPS --  edge connector
     |                     (cannot decrypt data)                  |
     +-- encrypted X25519/AES-GCM envelopes ----------------------+-- local MCP
                                                                    127.0.0.1 only
```

The CLI and laptop exchange X25519 public keys during a short-lived pairing. The user confirms a short authentication code calculated independently at both endpoints before the CLI permits a tool call. Meeting requests and responses are encrypted with AES-256-GCM before they reach the relay. After code confirmation, the relay cannot silently substitute its own keys or decrypt the payloads. The relay persists routing credentials as SHA-256 hashes and never receives the endpoint private keys. It does see timing, device labels, pairing IDs, and ciphertext sizes.

## User experience

1. In a personal QM conversation, the user says, “Connect my Inwise.”
2. QM runs `inwise auth login`. It shows a short-lived pairing code and a laptop command.
3. With Inwise Desktop running, the user runs that command on the laptop. The edge verifies the local MCP endpoint, claims the code, stores device credentials locally, and prints a verification code.
4. In QM, the user runs `inwise auth confirm VERIFICATION_CODE`. QM rejects it if its independently calculated code differs. No Inwise query is allowed before this succeeds.
5. The user starts `inwise-qm-edge serve`. A production desktop integration should auto-start this worker after explicit approval.
6. The user can now ask, “What did we decide about the launch?” or “Prepare me for my meeting with Ada.” QM searches Inwise and answers with meeting context.
7. If the laptop or Inwise Desktop is offline, the request fails clearly. There is no cloud-data fallback.

The initial release is intentionally read-only and personal-scope only. Shared-channel access should remain disabled until QM can cryptographically bind the acting user and audience to the per-user credential.

## Build and test

Requires Node.js 22 or newer.

```bash
cd integrations/qm
npm ci
npm test
```

The deployed Docker proof additionally requires a current QM source checkout, Docker, and a running Inwise Desktop MCP endpoint:

```bash
QM_REPO=/path/to/yc-software/qm npm run test:deployed
```

Windows also needs a Node.js 24 Linux binary in WSL through `QM_WSL_NODE`. See the [deployed fixture](./e2e/README.md) and its [passing test report](./e2e/TEST_REPORT.md).

For local development, start a relay:

```bash
npm run build
INWISE_QM_PUBLIC_URL=http://127.0.0.1:8787 node dist/relay/index.js
```

In a separate shell, create the QM-side pairing:

```bash
INWISE_QM_CONFIG=./qm-credentials.local.json \
  node dist/cli/index.js auth login --relay http://127.0.0.1:8787
```

On the laptop with Inwise Desktop running:

```bash
INWISE_QM_EDGE_CONFIG=./edge-credentials.local.json \
  node dist/edge/index.js pair --relay http://127.0.0.1:8787 --code PAIRING_CODE
INWISE_QM_EDGE_CONFIG=./edge-credentials.local.json \
  node dist/edge/index.js serve
```

Then refresh the QM-side status and query Inwise:

```bash
INWISE_QM_CONFIG=./qm-credentials.local.json node dist/cli/index.js auth confirm VERIFICATION_CODE
INWISE_QM_CONFIG=./qm-credentials.local.json node dist/cli/index.js auth status
INWISE_QM_CONFIG=./qm-credentials.local.json node dist/cli/index.js meetings search "launch"
```

## Relay deployment

The relay is a single Node process. Configure:

- `PORT` — listener port, default `8787`.
- `INWISE_QM_PUBLIC_URL` — externally reachable HTTPS origin used in pairing instructions.
- `INWISE_QM_STATE_FILE` — persistent pairing store, default `./data/qm-relay.json`.
- `INWISE_QM_REQUEST_TIMEOUT_MS` — request timeout, default 45 seconds.

Terminate TLS at a trusted reverse proxy and restrict request body sizes there as well. Back up the state file as a secret. Run exactly one relay process in this version: pending requests are held in memory, so horizontal scaling needs a shared broker.

## Add to a QM deployment directory

1. Build this package and install the resulting `inwise` binary plus its Node runtime files in the sandbox image. QM's deployment contract requires `install.binary` to exist on `PATH`; the descriptor alone does not install npm dependencies.
2. Copy `qm/tool.json` to `sandbox/tools/inwise/tool.json`.
3. Copy `skill/SKILL.md` to `sandbox/skills/inwise-meeting-memory/SKILL.md`.
4. Replace `relay.example.com` in `tool.json` with the relay's exact hostname.
5. Set the non-secret sandbox environment variable `INWISE_QM_RELAY_URL=https://your-relay.example`.
6. Run the QM deployment gates: `qm check`, `qm doctor`, publish the sandbox image, `qm plan`, `qm up --yes`, then `qm check --live`.

See QM's [deployment directory contract](https://github.com/yc-software/qm/blob/main/docs/deploy-directory.md) for the authoritative packaging rules.

## What this proves—and what remains

This implementation proves the core OSS path: local-only Inwise MCP, outbound laptop connectivity, sandbox CLI, authenticated pairing, encrypted routing, safe tool allowlisting, and QM skill/descriptor packaging.

Before calling it production-ready, add:

- Inwise Desktop settings UI, OS service auto-start, and a visible per-request activity indicator.
- Device list, revoke, credential rotation, relay key/rate limits, and abuse monitoring.
- A durable shared broker for multi-replica relay deployments.
- A model-driven agent-turn test using an operator-owned QM Fly sandbox app and provider credentials.
- A QM-enforced personal-scope identity binding instead of relying only on deployment policy and skill instructions.
- Security review and threat-model documentation for metadata exposure, compromised sandboxes, and compromised laptops.

Do not enable the three existing Inwise MCP write tools in this integration until a scoped approval and audit design exists.
