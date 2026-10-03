# Gate consequential connector writes at the effect, not the command string

**Status:** idea, for discussion

## The gap (already in the threat model)

SECURITY.md already lists both halves of this as known limitations, so nothing here is a disclosure. The proposal is to actually close them for the case that matters most: consequential external writes made by a connector.

- "Command policy is bypassable … a speed bump against mistakes and injection, not a sandbox boundary."
- "Sandbox credentials are plaintext while in use … [the controls] do not stop a compromised agent process from spending or exfiltrating usable credentials."

Play it out for a per-user connector that performs consequential writes to an external API. The write approval is a regex over the command string, and the credential reaches the sandbox as a plain env var. That leaves the gate defeated two independent ways: the shell can assemble the gated command outside the scanner's view (it reconstructs expansion only in command-name position, not in argument position), and any process can use the bearer token straight against the allowlisted host without ever running the connector's CLI. The egress proxy checks only the host, so it cannot tell the connector's request from a raw one to the same host.

Right now the only real containment is to run such a connector in an isolated scope. That bounds *which host and credential* are exposed, but not *which action* is allowed. Inside the scope the write is still ungated.

## The idea

The design intent already points here: "core is intended to enforce … deterministic effect gates around [the untrusted sandbox]." So gate the effect — the outbound write itself — where the shell cannot reconstruct around it, instead of the command string that is supposed to produce it.

Two moves, the first extending something that already exists:

1. **Deliver consequential-write connectors through the credential broker rather than as env vars.** The broker already keeps the secret server-side, makes the HTTPS call itself, and scopes by host + method + path-prefix. It refuses `delivery: "env"` today, which is exactly how these connectors ship. Route the connector through it and the raw token never enters the sandbox; core sees the real method/path/body instead of a bare host.

2. **Make a gated write require an action-bound, single-use approval at the broker.** Hash the specific request (method + destination + body) and require a matching one-shot token to let it through. A human approval mints the token; the sandbox cannot. This also closes a smaller existing gap: a command approval today binds to the matched regex pattern, not to the approved command, so one "once" approval can be spent by a different command that happens to match the same pattern.

## What it buys

- The command-policy string matcher stops being load-bearing for external writes. It stays the documented speed bump for local, sandbox-blast-radius things like `rm` and `git`.
- Connectors stop needing an isolated scope to be safe: the credential is no longer ambient, and the gate sits on the real effect.
- An approval means "this exact write was approved," bound to the bytes.

Which actions count as consequential stays admin policy with a fail-closed default, the same as command approvals today.

## Open questions

- Scope: only consequential writes (POST/PUT/PATCH/DELETE to a connector host), or every brokered call?
- Does the action-bound token become a new capability-token audience, or an extension of the credential claim?
- Migration path for connectors currently delivered as env vars.

Happy to burn our tokens on the implementation if the shape sounds right.
