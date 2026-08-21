# Deployed QM bridge smoke-test fixture

This fixture uses QM's Docker target and sandbox builder with the mock harness. The live test builds and deploys QM core from the selected source checkout, synchronizes the Inwise deployment layer, builds a minimal Node-based image through QM's real sandbox builder, runs the sandboxed `inwise` CLI, performs authenticated key confirmation with the host edge connector, and queries the real loopback Inwise MCP server.

Prerequisites:

- Docker Desktop with Linux containers.
- Inwise Desktop running with the local MCP server enabled at `127.0.0.1:43117`.
- A current `yc-software/qm` checkout with dependencies installed, exposed through `QM_REPO`.
- Port `18787` available for the temporary relay and port `8080` available for QM core.

Run from `integrations/qm`:

```bash
npm ci
QM_REPO=/path/to/yc-software/qm npm run test:deployed
```

QM's Docker-target CLI currently uses `/bin/sh`, so native Windows runs also need WSL with Node.js 24 and Docker Desktop integration:

```powershell
$env:QM_REPO = 'C:\path\to\qm'
$env:QM_WSL_NODE = '/path/to/node-v24/bin/node'
npm run test:deployed
```

The script uses generated secrets and isolated temporary credentials. It removes its Docker credential volume, test containers, and test data volumes on completion. It never requests or prints transcript content; the read-path probe searches for a deliberately nonexistent marker.

This proves a real local QM control-plane deployment and QM-built sandbox image. It does not prove a model-driven agent turn because QM's Docker target needs an operator-owned Fly sandbox app for real agent execution; the fixture uses `HARNESS=mock` and invokes the installed CLI directly inside the built sandbox.
