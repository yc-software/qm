# DigitalOcean Managed Agents sandboxes

The `do-managed-agents` backend runs each QM scope on a DigitalOcean Managed Agents microVM. QM keeps its own agent loop; sessions start with `agent: none`, so DigitalOcean supplies the machine and nothing else.

## Set it up

1. Create a DigitalOcean API token with Managed Agents access.
2. Point core at it:

   ```sh
   SANDBOX_BACKEND=do-managed-agents
   DO_AGENTS_API_TOKEN=your-token
   ```

That's enough to run. Sessions land on DigitalOcean's bare base image.

## Optional

**A QM template.** For an image with the tools agents usually reach for (Node, git, jq, ripgrep, Python), register one on your team. You need Docker, an authenticated `doctl`, and a container registry:

```sh
deploy/do-managed-agents/register-template.sh
DO_AGENTS_TEMPLATE=qm-sandbox
```

Templates belong to a team, so each team registers its own. Rerun the script after changing the Dockerfile.

**A snapshot bucket.** Set `DO_AGENTS_SNAPSHOT_S3_BUCKET` and QM backs up each computer's home directory to it when the computer parks, restores it into a replacement session if the old one is gone, and restarts a wedged computer by backing up its home and replacing the session. Without a bucket, QM takes a DigitalOcean checkpoint when a computer parks and restarts by rolling back to it. DigitalOcean counts each checkpoint at the computer's full allocated size (about 104 GiB at the default size) against the team's checkpoint quota, so this only suits a handful of computers, and a checkpoint is deleted with its session. A deployment on DigitalOcean can keep the bucket in Spaces: set `AWS_ENDPOINT_URL_S3` to the region's Spaces endpoint (for example `https://sfo3.digitaloceanspaces.com`) and `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` to a Spaces key. Backups currently move through DigitalOcean's file transfer API at well under 1 MB/s, so a large home takes minutes and the 10-minute snapshot timeout bounds it to roughly 150 MB.

**No QM egress proxy.** `EGRESS_PROXY_URL` doesn't apply to this provider. DigitalOcean sends a restricted session's traffic through its own in-VM proxy (`HTTPS_PROXY=http://169.254.169.254:3128`) and blocks direct connections, even to allowed hosts, so QM's proxy variables would replace DigitalOcean's and leave the session with no network. Sessions keep DigitalOcean's default open egress and the profile reports no enforcement.

Other knobs: `DO_AGENTS_SIZE_SLUG`, `DO_AGENTS_IDLE_TIMEOUT_SEC`, `DO_AGENTS_NAME_PREFIX` (use a distinct one per deployment sharing a team), `DO_AGENTS_SNAPSHOT_INTERVAL_SEC`, and `DO_AGENTS_API_BASE_URL`.

## Good to know

- Commands and file transfers go over a port-forward to the microVM rather than DigitalOcean's REST exec, which caps output and runtime. Long commands are bounded only by `SANDBOX_TIMEOUT_SEC`.
- QM doesn't reap idle machines itself. DigitalOcean's idle timeout does, and paused sessions still count against team quota.
- Sessions allow `bash` outright, since QM already runs its own approval gates.
- `scripts/managed-agents-sandbox-smoke.ts` checks a token and template end to end before you point a deployment at them.
