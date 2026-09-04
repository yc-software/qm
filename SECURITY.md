# Security policy

QM is designed to isolate each person's data and activity by scope. It is early,
experimental software: that design goal is not a promise that data cannot leak,
a certification, or a substitute for a deployment-specific security review.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through this repository's
**Security → Report a vulnerability** flow. Do not open a public issue, discussion,
or pull request with exploit details.

Include the affected revision, configuration, impact, and the smallest reproduction
you can safely provide. We will acknowledge the report, investigate it, and coordinate
disclosure with you. Do not access data that is not yours or test against deployments
you do not own.

## Threat model and limitations

This is a public summary of the current security model. This
summary highlights material limitations; it is not exhaustive and does not promise
that planned controls will ship.

### Scope

QM's interactive agent surfaces currently assume one organization of authenticated
internal users. Guests and external users are outside that interaction boundary,
apart from a deployment's explicit, admin-controlled exception for internal users in
Slack rooms that include external participants. Published apps are a separate,
deliberate exception: an owner can distribute a capability link to visitors outside
the organization. Holding that link authorizes reach to that app only; it does not
create a QM principal or authorize interaction with the agent or control plane. QM is
not a hardened public or multi-tenant service boundary.

### Protected assets and actors

The assets in scope include credentials and capability tokens, conversation and model
request data, memory, files and workspaces, deployment data, audit records, and side
effects made in connected systems. Relevant actors include internal users, org
admins, deployment operators, the model-driven agent, sandbox processes, surface
plugins, model and browser providers, and connected services.

The security goals are to prevent unauthorized cross-scope reads, writes, and
deliveries; keep credentials within their authorized scope; authenticate actors; and
preserve attribution and audit evidence. QM does not guarantee correct model output
or continuous availability.

### Trust boundaries and operator assumptions

- The deployment operator controls the cloud account, network, identity provider,
  database, object storage, runtime configuration, encryption keys, and initial admin
  grants. QM does not protect a deployment from a malicious or compromised operator.
- An org admin is a privileged content reader, not only a policy administrator.
  Admin content reads are scope-authorized and audited, but require no additional
  user approval.
- Model providers receive the prompt and request data sent to them. Browser providers
  receive browser tasks and traffic, and browser egress uses their network. Operators
  must evaluate those providers and their retention policies.
- The agent and software it runs in a sandbox are not trusted to make authorization
  decisions. Core is intended to enforce identity, scope, grants, delivery, and
  deterministic effect gates around them. The sandbox remains a sensitive boundary
  because it executes model-generated commands and can hold usable credentials.
- Surface and connector inputs are untrusted data. Authentication proves the source
  or initiating principal where implemented; it does not make the content safe.
- A published app and its runtime are a separate trust boundary. App code receives
  visitor requests and data, may hold explicitly supplied app environment, and may
  use configured per-app acting-as access. QM keeps ambient author credentials out of
  the app, but does not review app code or guarantee how it handles visitor data.

### What the controls do and do not guarantee

QM resolves a principal and scope for each turn, separates scope workspaces, uses
signed ingress and capability tokens, applies grants and audience checks, and records
security-relevant actions. These controls are designed to reduce cross-scope access
and make actions attributable. They are not a formal non-interference proof or a
guarantee that the model cannot disclose data.

Command approvals, content screening, and egress policy are defense in depth. Their
effect depends on the selected posture, configured rules, available classifier, and
sandbox backend. Audit records support investigation; they do not prevent an action.
Encryption at rest protects stored secret material from direct storage reads, not
plaintext credentials while a process is using them. An approval means a human
accepted the displayed action under the information available at that time, not that
the resulting behavior is safe.

### Deliberately portal-only actions

Three actions are intentionally excluded from the agent self-API, even though the
web portal offers them. They look like capability-parity gaps in an audit; they are
walls, not gaps, and should not be "fixed" without revisiting the reasoning here.

- **Admin grant changes.** Granting or revoking org-admin rights happens only in the
  portal, on an authenticated admin's own turn. If the agent could change grants, a
  prompt-injected or compromised agent process could escalate its own operator's
  privileges — or demote everyone else's.
- **Impersonation.** The agent always acts as the principal resolved for the turn.
  There is no self-API route to act as a different principal, because every
  authorization decision downstream keys off that identity; a switchable identity
  would turn one confused turn into another person's authority.
- **Command-approval decisions.** Approving a gated command is a human judgment made
  on the approver's own turn. An agent-reachable approval route would collapse the
  human-in-the-loop gate into a single model decision, which is exactly what the
  gate exists to prevent.

The common shape: each is a decision that authorizes _future_ agent behavior, so the
decision itself must come from outside the agent. Parity work should route around
these, not through them.

### Known limitations

- **Command policy is bypassable.** It classifies shell text and catches configured or
  common dangerous forms, but obfuscation, encoding, or writing and then executing a
  script can evade it. It is a speed bump against mistakes and injection, not a
  sandbox boundary.
- **Browser actions sit outside some core gates.** Actions inside the browser runner
  do not re-enter command policy or human-in-the-loop approval. They rely on
  task-level consent and the runner's spend checks. Browser traffic exits through the
  browser provider rather than QM's egress proxy.
- **Sandbox credentials are plaintext while in use.** Credentials and capability
  tokens materialized as environment variables or files are readable by processes in
  that sandbox. Scope isolation and auditing limit exposure, and short-lived
  capabilities expire, but those controls do not stop a compromised agent process
  from spending or exfiltrating usable credentials.
- **Credential purposes are not enforced authorization.** Core enforces the grant's
  owner, audience, once-or-standing mode, expiry, revocation, and audit. The stated
  purpose travels with the credential as an instruction to the model and an audit
  field; core does not determine whether a later command stays within that purpose.
  Once a credential is materialized into a sandbox, the purpose text does not confine
  how a compromised agent process can use it.
- **Security screening is incomplete and heuristic.** Auto screens supported,
  provenance-labelled external text and supported tool results. Command and
  background-process output, opaque or multimodal results, raw webhook payloads, and
  replay remediation across a shadow-to-enforcement cutover are not all covered.
  Classifier approval is not authorization and cannot guarantee prompt-injection
  resistance.
- **Audience-floor filtering has known gaps.** Model-context entries do not yet carry
  complete origin labels for every granted read, so mixed-permission filtering is
  incomplete. The ambient Slack judge path also does not yet repeat the full
  internal-only check used by addressed turns.
- **Egress enforcement is conditional.** Force-through egress depends on backend
  network enforcement, and core does not yet reject every backend that is too coarse
  for the requested policy. Deployment-runtime egress enforcement is not built.
- **Admins can read sensitive content.** A scope-authorized admin can directly read
  transcripts, captured provider requests, documents, memory, connector and keychain
  metadata, mirrored message bodies, ambient-judge inputs, user details, and skill
  bodies. The read is audited, not separately consent-gated.
- **Durable data can outlive user expectations.** Sessions, memory, and exact model
  request captures persist when durable stores are enabled, and request capture is on
  by default. File artifacts have no expiry, and artifact retirement and byte
  reclamation are not implemented, so artifacts and deduplicated bytes can accumulate
  indefinitely.
- **Published-app capability links are bearer authorization.** Anyone who obtains a
  link can reach that app without establishing an identity, and the link is not bound
  to an intended recipient. The gateway removes the token from the address bar and
  places it in a one-day browser cookie, but copied links remain usable and app ACL
  changes do not revoke individual link holders.
- **Portal sessions have residual risk.** A signed portal session defaults to eight
  hours and renews on use. Logout clears the browser cookie but cannot revoke an
  already copied session token before its expiration.
- **Some model-provider paths bypass the intended gateway.** The ambient Slack judge's
  model call does not yet use the ModelGateway, and the OpenCode adapter currently
  supplies its provider key to the supervised sidecar.
- **Some governance and data-loss controls are absent.** Standing-instruction edits
  are not uniformly bounded by an org floor or human approval, governance changes are
  not uniformly versioned or revertible, provider-side token revocation and an org
  kill switch are incomplete, and secret scanning on file write is not implemented.

## Dependency cooldown

To blunt npm supply-chain attacks (compromised maintainer publishes a malicious
version that is caught and yanked within hours), newly published package versions must
age for **7 days** before they can enter a lockfile. This is enforced by
`min-release-age=7` in `.npmrc` (honored by npm ≥ 11.10.0, pinned via `.node-version`).
The cooldown gates `npm install`/`npm update`; CI installs with `npm ci` from the
committed lockfiles and is unaffected. Urgent security fixes can be pulled in ahead of
the window by installing the exact version explicitly.

## Supported versions

Security fixes are made on the latest release and the `main` branch. Older releases
may require upgrading.

Public source releases must start from a fresh export; publishing a private
repository's existing history is explicitly unsupported.
