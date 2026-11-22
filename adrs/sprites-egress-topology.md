## Fail-closed sandbox egress, and an egress proxy the deploy contract provisions

We're deploying QM v0.1.4 on the Fly target with the Sprites sandbox
backend, in the security posture where the portal is the only public
surface and agent workloads are expected to run under egress control.

**What we observe at v0.1.4:** with `SANDBOX_BACKEND=sprites` and no
`SPRITES_EGRESS_PROXY_URL`, core logs a startup warning that sandboxes will
run with **no egress enforcement** — and then continues. The Fly deploy
contract does not provision an egress proxy service, derive a URL for one,
or surface the omission in `check`/`doctor`. So the out-of-the-box native
deployment quietly runs agent sandboxes fail-open, in a system whose
security model elsewhere (command policy floor, broker, postures) is
conspicuously fail-closed. A careful operator catches the warning in logs;
an ordinary operator ships it.

There's also a topology wrinkle: the Sprites backend needs the proxy to be
reachable from Sprites' infrastructure, i.e. publicly addressable — which
changes the "portal is the only public surface" story that the default
deployment otherwise supports, and adds an always-on service the operator
never priced.

**What we'd like:**

1. **Fail closed by default.** If the configured sandbox backend supports
   egress enforcement and no enforcement is configured, refuse to create
   sandboxes (not refuse to boot — the rest of the org is fine). An
   explicit `sandbox.egress = "unenforced"` config opt-out can preserve the
   current behavior for people who genuinely want it, and gives audits one
   greppable line.
2. **`check`/`doctor` coverage.** Preflight should fail the same way it
   fails for missing secrets: "sprites backend configured, no egress proxy,
   no explicit opt-out."
3. **A provisioned proxy in the Fly contract.** The deploy contract already
   materializes multiple services; an `egress-proxy` service (authenticated,
   deny-by-default, allowlist from config, minimal machine) with its URL
   derived and injected as `SPRITES_EGRESS_PROXY_URL` would make the secure
   topology the default topology. Documenting its public-reachability
   requirement and rough cost alongside the other services would let
   operators price it honestly.
4. **Documented allowlist semantics.** Whatever the proxy enforces, the
   operator needs to read back what a sandbox can reach — ideally the same
   place the command policy is read back.

We're happy to test a contract change on a live Fly deployment and
contribute the preflight checks.
