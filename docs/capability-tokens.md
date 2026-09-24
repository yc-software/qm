# Capability token encoding and rollout

Room capabilities carry participant assertions for authorization. Large rosters appear
in both the publishing and keychain audiences, so uncompressed tokens can exceed HTTP
header limits before a request reaches core. Increasing core's header limit does not
fix limits imposed by upstream proxies.

`CAPABILITY_TOKEN_COMPRESSION=1` enables compression of claim payloads larger than
4096 bytes for every capability audience. The signed envelope contains a base64url
raw-DEFLATE payload. Verification authenticates the envelope before inflating it,
limits decoded claims to 1 MiB, and applies the existing claim checks. Small tokens
retain their existing encoding. Tokens remain self-contained across replicas and
restarts; no authorization state is moved into a process-local cache. Compression
reduces roster repetition but is not a fixed-size token: unusually large or poorly
compressible claims can still exceed a deployment's header limit.

Compression is off by default for a staged protocol rollout:

1. Keep `CAPABILITY_TOKEN_COMPRESSION` unset or `0` while deploying this verifier to
   every core API replica, worker, and separately deployed egress proxy. Complete the
   blue-green drain of older replicas before enabling issuance.
2. Refresh saved copies of the file upload helper from `/v1/files/upload-client`;
   older copies cannot decode compressed tokens.
3. Set `CAPABILITY_TOKEN_COMPRESSION=1` on every process that issues capabilities,
   including core and workers, and restart them. New turns receive compact tokens;
   already-issued oversized tokens are not rewritten, so retry in a new turn.

To disable issuance, set the switch to `0`. Both encodings remain readable regardless
of that switch. Do not roll verifiers back to a version predating compression until
all compressed tokens have expired or been revoked. Sandbox tokens normally live
48 hours; other capability audiences may have longer lifetimes, so inventory those
before rolling back. Leaving the updated verifiers in place is the safe rollback.

## Participant consolidation

`CAPABILITY_TOKEN_PARTICIPANTS=1` enables a versioned `participants-v1` envelope.
Its `claims` contains the non-roster claims. `participants.records` stores each
distinct principal assertion once; `participants.scope` and
`participants.keychain` are ordered index lists reconstructing `members` and
`keychainMembers`. Compression, when enabled, wraps this envelope.

These audiences are not interchangeable. The publishing roster becomes the
`members` scope assertion used by scope, search and scheduling checks. The internal
participants in the current turn become `keychainMembers`, used to check shared
connection grants. An owner-only scheduled run can therefore have a larger room
publishing roster while its keychain audience contains only the owner.
Slack's directory can also withhold a publishing roster for incomplete,
externally shared or guest-containing rooms.

The verifier reconstructs the existing claims before authorization. It preserves
missing versus empty lists, order, duplicates, guest status, team memberships and
all principal metadata. Records with the same ID but different assertions remain
separate, including differing display names. Consequently some real rosters
deduplicate less than identical synthetic rosters. This change consolidates token
storage; it does not unify policy meanings or rewrite the conversation model.

| Issued token                    | Compression-only reader | Participant-aware reader |
| ------------------------------- | ----------------------- | ------------------------ |
| Legacy HMAC or plain JWS        | Accepted                | Accepted                 |
| Compressed ordinary claims      | Accepted                | Accepted                 |
| Participant envelope            | Rejected                | Accepted                 |
| Compressed participant envelope | Rejected                | Accepted                 |

Participant issuance defaults off independently of compression. Deploy the new
reader to all core replicas, workers and egress proxies, drain old replicas, and
refresh saved Python upload helpers before enabling it. That helper only reads
actor and scope for resume-state binding; server verification remains authoritative.
Disable participant issuance to roll back without changing readers. Keep the new
readers until all issued participant tokens have expired or been revoked, including
long-lived credential capabilities.

Verification authenticates before decoding, rejects invalid references and mixed
legacy/envelope fields, and limits reconstructed claims to 1 MiB before allocating
expanded records. Reconstructed records are independent objects, matching JSON
decoding rather than introducing shared mutable authorization state.

Regression coverage includes all four encoding combinations through sandbox
issuance, distinct execution/keychain audiences through connection grant checks,
upload resumption across encodings, absent and empty rosters, differing assertions
for the same ID, signature tampering, key rotation, expiry, invalid indices and
reference amplification. Before merging, independent security review still needs
to assess protocol compatibility and authorization preservation. Neither
consolidation nor compression guarantees a fixed header size.

A synthetic 120-person roster with identical scope/keychain assertions measured
32,939 bytes as plain JWS, 17,659 with participant references, 1,806 with compression
alone, and 2,051 with both. Reference arrays can make compressed tokens larger
because DEFLATE already removes repeated roster text. This protocol should not
be enabled solely as an additional header-size optimization; its added migration
and maintenance cost needs a separate justification.
