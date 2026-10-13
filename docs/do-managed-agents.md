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

**A snapshot bucket.** When a scope parks, QM takes a DigitalOcean checkpoint, which lets it roll a wedged computer back in place. A checkpoint is tied to its session, though, so if the session is deleted the checkpoint goes with it. Set `DO_AGENTS_SNAPSHOT_S3_BUCKET` to also keep a copy of the home directory that survives that. Without it, the copy lives in core's memory and is lost when core restarts.

**An egress proxy.** Set `DO_AGENTS_EGRESS_PROXY_URL` and the proxy host becomes the session's only allowed destination.

Other knobs: `DO_AGENTS_SIZE_SLUG`, `DO_AGENTS_IDLE_TIMEOUT_SEC`, `DO_AGENTS_NAME_PREFIX` (use a distinct one per deployment sharing a team), `DO_AGENTS_SNAPSHOT_INTERVAL_SEC`, and `DO_AGENTS_API_BASE_URL`.

## Good to know

- Commands and file transfers go over a port-forward to the microVM rather than DigitalOcean's REST exec, which caps output and runtime. Long commands are bounded only by `SANDBOX_TIMEOUT_SEC`.
- QM doesn't reap idle machines itself. DigitalOcean's idle timeout does, and paused sessions still count against team quota.
- Sessions allow `bash` outright, since QM already runs its own approval gates.
- `scripts/managed-agents-sandbox-smoke.ts` checks a token and template end to end before you point a deployment at them.
