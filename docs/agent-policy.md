# Managed-agent policy hook

An optional, operator-supplied policy can decide, per principal and thread, whether a turn
runs, whether a cron fires, which skills are visible, and whether each tool call goes ahead.
With no policy configured, or when the policy binds no subject for a turn, nothing changes.

## Configuring

Set `AGENT_POLICY_MODULE` to the path of an ES module that exports `createAgentPolicy()`.
The module is loaded lazily on first use and must return an object with `resolve` and
`admit` (the `AgentPolicy` interface in `src/auth/agent-policy.ts`). Embedders that call `buildApp` directly can pass `agentPolicy` in the overrides
instead.

```js
export function createAgentPolicy() {
  return {
    async resolve(context) {
      return null;
    },
    async admit(context, binding, operation) {
      return false;
    },
  };
}
```

## Interface

`resolve(context)` returns `null` for subjects the policy does not manage, or a binding
`{ subjectId, revision, grants? }`. `context` carries `principalId` and, where known,
`threadRef`, `runId`, `scopeId`, the cron `trigger`, and `runtime: true` for agent-runtime
calls.

`admit(context, binding, operation)` must return exactly `true` to allow the operation.
Operations are:

- `{ kind: "turn" }` before an interactive, webhook, monitor or loop turn runs.
- `{ kind: "cron", payloadDigest }` before a cron fires. The digest covers the stored task,
  title, owner, scope, destination, schedule, runtime and unattended grants, and for a
  loop-backed cron the loop's procedure (playbook, success condition and checks, sources,
  ship actions, caps, governor, triage, destination) and its ship grants. The loop service
  takes one frozen snapshot of loop, cron and ship grants, admits it, and runs every stage,
  triage and auto-ship from it. Later reads can only narrow it (a revoked grant or a paused
  loop), never widen it, so an approval is pinned to the exact payload. A policy error
  records a `failed` fire.
- `{ kind: "skill", resource: { id, digest } }` for each skill a bound subject could see.
- `{ kind: "tool", name, input }` before every tool call of a bound turn. Methods on nested
  tool namespaces are named with a dotted path, for example `admin.call` or
  `sessionSyscalls.open`.

Errors thrown by `resolve` or `admit` propagate, so an unavailable policy fails closed.

## What a bound turn gets

- Only skills that are already visible to the principal, published, listed in
  `binding.grants` with the same `digest`, and admitted. The digest (`agentSkillDigest`)
  covers the skill's id, version, scope, manifest, files, executable bits, capabilities
  and pack bundle, so any content change needs a new grant. The skill catalog API returns
  the digest alongside each skill when a policy is configured.
- No session history, prior turns, overheard messages, recent delivery notes, or memory.
- An empty scratch sandbox with no workspace layers, connector environment, owner keychain,
  or process reconciliation, destroyed at the end of the turn. Persistent sandboxes
  (`sandbox_id`), the sandbox inventory, and cross-channel reach are unavailable.
- Every tool call re-resolved and admitted. Before each call, materialized skill trees
  whose grant or content no longer matches are removed; on a denial or policy error all
  of them are removed. A skill grant is resolved after the sandbox is provisioned, in the
  same queued critical section as its file writes; writes and removals share that queue, a
  tree is tracked before its files are written and forgotten only once it is deleted, and a
  failed deletion fails the call and is retried on the next one.
- A denied cron fire is recorded as `refused` and the cron is disabled.
