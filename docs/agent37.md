# Running QM on Agent37

QM can use Agent37 for agent computers (`SANDBOX_BACKEND=agent37`) and published apps
(`DEPLOY_PROVIDER=agent37`). These settings work independently.

Create an API key in the [Agent37 dashboard](https://agent37.com/dashboard/cloud/api-keys):

```bash
DEPLOY_PROVIDER=agent37
AGENT37_API_KEY=sk_live_...
```

The first publish creates a `qm-app-runner` template using `node:24-bookworm-slim`.
Each app gets its own instance and public HTTPS URL. Republish and rollback reuse the
instance, preserving its URL and `/data` directory.

## Settings

| Setting                       | Default                                                | Purpose                                                                          |
| ----------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `AGENT37_DEPLOY_API_KEY`      | `AGENT37_API_KEY`                                      | Use a separate workspace for apps.                                               |
| `AGENT37_DEPLOY_API_BASE_URL` | `AGENT37_API_BASE_URL`, then `https://api.agent37.com` | API address.                                                                     |
| `AGENT37_DEPLOY_NAME_PREFIX`  | `AGENT37_NAME_PREFIX`, then `qm`                       | Instance name prefix.                                                            |
| `AGENT37_DEPLOY_TEMPLATE`     | `qm-app-runner`                                        | Workspace template, created if absent.                                           |
| `AGENT37_DEPLOY_RUNNER_IMAGE` | `node:24-bookworm-slim`                                | Image used when creating the template. Must include Node.js, sh, tar and base64. |
| `AGENT37_DEPLOY_CPUS`         | `2`                                                    | vCPU count.                                                                      |
| `AGENT37_DEPLOY_MEMORY_GB`    | `4`                                                    | RAM in GB.                                                                       |
| `AGENT37_DEPLOY_DISK_GB`      | `4`                                                    | Disk in GB.                                                                      |
| `AGENT37_DEPLOY_APP_PORT`     | `3000`                                                 | App listener, exported as `PORT`. Choose an unreserved port.                     |
| `AGENT37_DEPLOY_ALWAYS_ON`    | Off                                                    | Set to `1` or `true` to keep every app awake.                                    |

CPU and RAM must match an Agent37 shape: 2/4, 4/8, 8/16 or 16/32.
Blank key, API address and name-prefix overrides use the shared setting.
Every app counts against the workspace's instance limit and is billed to that workspace.

## App startup

The template waits for `/app/.qm-start.sh`. QM uploads the app files, then writes this
script with the app's environment and start command. The template launches it on boot,
so the app returns after sleep or restart. Republish replaces `/app` and restarts the
instance. Apps should store persistent files in `/data`, available as `DATA_DIR`.

A custom template must leave `default_port` unset, wait for an executable
`/app/.qm-start.sh`, and run it with output redirected to `/tmp/qm-app.log`.
The initial instance must boot before QM can upload the app. App readiness uses Node.js.

## Sleep and data

Apps sleep when idle and wake when visited. Idle apps pay for disk storage.
The per-app always-on setting disables sleep for that app; the global setting disables
it for every app. QM's idle reaper leaves these instances running under Agent37's sleep policy.

Deleting a deployment deletes its instance and data. Republish and rollback preserve
`/data` and replace the app files.

## Public URLs

The app URL is public and can be accessed directly without QM sign-in. QM's own sharing
controls apply to visits through QM. Apps needing authentication at the direct URL must
provide it themselves.
