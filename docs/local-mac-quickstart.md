# Local Mac Quickstart: Running QM Backend & Desktop App

This guide documents how to boot the local QM instance and connect the `/Applications/QM.app` Mac desktop client without errors.

---

## 1. Prerequisites

- **Docker Desktop**: Must be running (provides the local PostgreSQL 16 container `qm-dev-postgres` on port `55432`).
- **Target Database Org**: The local development database is bound to org ID `sharechat` (`qm_dev_d5aeb89c65de`).

---

## 2. Booting the Local QM Instance

Run the dev instance supervisor with the matching organization ID and `--no-watch` flag:

```bash
DEV_INSTANCE_ORG_ID=sharechat bash scripts/dev-instance.sh up --surface web --no-watch
```

### Why these flags matter

- **`DEV_INSTANCE_ORG_ID=sharechat`**: Avoids the startup crash `database belongs to org sharechat, not acme` when connecting to the existing PostgreSQL state.
- **`--no-watch`**: Prevents rapid restart loops triggered by filesystem events in transient folders (e.g. Python bytecode/`__pycache__` in `skills-seed`).
- **`--surface web`**: Boots the core API, local Docker sandbox, and Web/Portal front door without requiring Slack app credentials.

---

## 3. Port Map & Local Endpoints

Once booted on slot `pool3`:

- **Portal (Front Door / Web UI)**: `http://localhost:8115`
- **Core API**: `http://localhost:8083`
- **Postgres Container**: `127.0.0.1:55432` (`qm-dev-postgres`)

---

## 4. Connecting `/Applications/QM.app` (Desktop Client)

The desktop Electron app expects the portal URL stored in:
`~/Library/Application Support/QM/instance.json`

```json
{ "url": "http://localhost:8115/" }
```

If the desktop app displays **"Could not connect to QM"**:

1. Ensure the backend is booted (`curl -I http://localhost:8115/` returns an HTTP response).
2. In the QM Mac app window, click **OK** and press **Cmd + R** (or select **View** -> **Reload**).
3. Alternatively, open `http://localhost:8115/` in any browser.

---

## 5. Stopping the Local Instance

To tear down the supervisor and release the port slot:

```bash
bash scripts/dev-instance.sh down
```
