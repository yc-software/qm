## Immediate single-caller revocation for brokered credentials

We're deploying QM for a small business, using the org credential broker the
way it seems designed to be used: service credentials stay broker-delivered so
agent-driven background work never holds a secret, and several scopes (people,
rooms, scheduled jobs) share one service credential through grants.

**What we observe at v0.1.4:** removing a `service-cred` ACL grant stops new
capability tokens from being minted with that entitlement, but a
capability token that was already minted keeps working until it expires —
up to about an hour. Disabling the credential takes effect on the next broker
call, but it cuts every caller at once. So the operator's realistic options
when one caller misbehaves are "wait out the hour" or "take down everyone."

**What we'd like:** a way to cut one caller's use of one credential that
takes effect on the next broker call, without rotating the key and without
disabling the credential for the other callers.

We don't have a strong opinion on the mechanism. Three shapes that seem
compatible with the current design, from the outside:

1. Re-check the grant at broker call time. The broker already does a per-call
   read to decrypt the credential; reading the current grant state alongside
   it would make ACL removal immediate. One extra store read per brokered
   call, possibly joinable with the existing one.
2. A revocation epoch on grants: tokens carry the epoch at mint; the broker
   rejects tokens whose epoch is older than the grant's current epoch.
3. Much shorter capability TTL for credential entitlements specifically, with
   silent refresh — this narrows the window rather than closing it, so it's
   the weakest of the three.

**Why we care enough to write this:** we run an acceptance suite before
letting any deployment touch systems that can spend money or contact
customers, and one of its checks is "revoke one caller while another caller's
service continues, prove it, and audit it." QM passes the rest of the broker
checks in that suite by design (entitlement, pinned host, method and path
allowlists, per-use audit, secret never entering the sandbox) — this is the
one gap. We're happy to validate a change against a live deployment and
report back, and to share the acceptance check itself if that's useful.
