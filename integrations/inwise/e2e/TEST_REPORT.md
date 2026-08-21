# QM deployed bridge smoke-test report

Status: **PASS**

Date: **2026-08-12**

## Tested revisions

- Inwise OSS base: `528226e3d1e9991bc0175fd2b12f4aed09f97876`
- Adapter location: `integrations/inwise` in QM PR branch `agent/inwise-oss-meeting-layer`
- QM upstream: `291faf194c1df2fcb5bc38c4c974da782e201d02`
- QM source: `https://github.com/yc-software/qm.git`

## Live environment

- Windows 11 host with Docker Desktop 4.64.0 and Linux containers.
- QM Docker control-plane commands executed through Ubuntu 24.04 WSL with Node.js 24.14.1.
- QM core built from the tested upstream source checkout.
- QM sandbox image built by `qm sandbox build` from `node:24-slim` with the staged Inwise executable.
- Installed Inwise Desktop MCP server reachable at `127.0.0.1:43117`.
- Temporary local relay reachable from the sandbox through `host.docker.internal:18787`.

## Passing assertions

1. `qm check` accepted one executable tool and one skill.
2. `qm sandbox build` produced `inwise-qm-e2e:local` and verified `inwise` on `PATH`.
3. `qm up --build-from <tested-qm-checkout>` started Postgres and a source-built QM core.
4. QM core accepted deployment-layer hash `28738a4fd5d8`.
5. `qm conformance` passed `config.v1`, `sandbox.descriptors`, `secrets.computed-set`, and `runtime.layer-resolved`.
6. The `inwise` CLI ran inside the QM-built Docker sandbox and created a pairing.
7. The host edge connector claimed that pairing after verifying the real local Inwise MCP endpoint.
8. The sandbox and laptop derived and confirmed the same short authentication code before permitting any tool call.
9. The sandboxed CLI completed an encrypted `get_connection_status` call and a read-only `search_meetings` probe through relay → edge → local MCP.
10. The probe used a deliberately nonexistent marker, did not request a transcript, and suppressed the query result from test output.
11. The test used a random QM organization ID and removed its temporary credentials, containers, and data volumes after completion.

## Result emitted by the runner

```json
{
  "ok": true,
  "qmCore": "live",
  "qmConformance": "passed",
  "qmOrgId": "inwise-qm-e2e-b944843c",
  "sandboxImage": "inwise-qm-e2e:local",
  "sandboxCliPairing": "passed",
  "keyConfirmation": "passed",
  "localInwiseMcp": "queried",
  "transcriptContentRead": false
}
```

## Boundary of this proof

This is a real deployed QM control plane, deployment layer, sandbox image, bridge, and local Inwise MCP test. It is not a model-driven agent-turn test. The fixture intentionally uses `HARNESS=mock`; QM requires an operator-owned Fly sandbox app and provider credentials for a real model-driven turn on its Docker target. The sandboxed CLI is invoked directly for the bridge assertion.

QM upstream also reports that `check --live` is not implemented for the Docker target. The supported live `qm conformance` gate passed instead.
