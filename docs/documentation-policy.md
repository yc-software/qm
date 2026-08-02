# Documentation policy

This policy keeps product, implementation, operations, and validation material from
competing as sources of truth.

## Status and evidence

Every new design or product document must state one of these statuses near its title:

- **Current**: verified against the referenced code, test, configuration, or released
  behavior.
- **Proposed**: a decision or capability that is not yet implemented or accepted.
- **Template**: a reusable structure with no behavioral claim.
- **Historical**: retained for context and not a description of current behavior.

Do not infer implementation from a roadmap, issue, mockup, or proposed ADR. Statements
about current behavior should cite the owning code path, executable check, or normative
contract. If evidence is unavailable, label the statement `To verify` and name the
verification needed.

## Sources of truth

| Subject                            | Primary source                                                      | Supporting material                                  |
| ---------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| Current product scope              | `README.md`                                                         | Plugin READMEs                                       |
| Runtime behavior                   | `src/`, `plugins/`, `cli/src/`                                      | Tests beside the owning package                      |
| Local commands and prerequisites   | `package.json`, package-level `package.json` files, `.node-version` | Contributor guides                                   |
| Deployment directory and lifecycle | `docs/deploy-directory.md`                                          | `cli/README.md`, generated `deployment.md`           |
| Configuration names                | Schemas and `.env.example`                                          | Deployment and plugin guides                         |
| Security and trust boundaries      | `SECURITY.md` and authorization code/tests                          | Feature specifications and ADRs                      |
| Architectural rationale            | Accepted records in `adrs/`                                         | Current architecture documents                       |
| Agent Squad Workspace scope        | `docs/agent-squad-workspace/README.md`                              | Accepted ADRs and implemented feature specifications |
| Test and acceptance evidence       | Executable tests and CI workflow                                    | Dated test plans and acceptance records              |

When two documents repeat a fact, one must name the primary source and the other should
link to it instead of maintaining a second copy. Generated deployment runbooks are an
intentional exception: their template is authoritative, and generated copies are bound
to the CLI version that created them.

## Information architecture

Use these locations for new material:

```text
README.md                         current public product overview
docs/README.md                    documentation navigation
docs/agent-squad-workspace/       planned and current extension documentation
docs/templates/                   reusable document templates
adrs/                             change proposals and accepted decision records
cli/README.md                     CLI-specific user contract
plugins/<name>/README.md          plugin-specific behavior and setup
deploy/**/README.md               deployment template and fixture boundaries
```

Agent Squad Workspace documents should use the following paths when the corresponding
work begins. Do not create a placeholder that could be mistaken for an implemented
contract:

```text
docs/agent-squad-workspace/domain-model.md
docs/agent-squad-workspace/architecture.md
docs/agent-squad-workspace/api-and-message-protocol.md
docs/agent-squad-workspace/permissions-and-audit.md
docs/agent-squad-workspace/failure-recovery.md
docs/agent-squad-workspace/testing-and-acceptance.md
```

## Naming and links

- Use lowercase kebab-case Markdown filenames. ADRs additionally use a four-digit
  sequence: `NNNN-short-decision.md`.
- Use relative repository links and descriptive labels. Do not link to runtime-local
  paths.
- Link to a directory only when it contains a `README.md`; otherwise link to a file.
- Prefer stable headings over line-number links.
- Keep one H1 per standalone document and use sentence-case headings.
- Put commands in fenced blocks and state their working directory and prerequisites
  when those are not obvious.

## Ownership and update triggers

Ownership is role-based until the repository adds a `CODEOWNERS` policy.

| Material                           | Accountable role      | Required update trigger                                                    |
| ---------------------------------- | --------------------- | -------------------------------------------------------------------------- |
| Product overview and feature specs | Product owner         | User-visible scope or workflow changes                                     |
| Architecture and ADRs              | Architecture owner    | Boundary, dependency, data model, or trade-off changes                     |
| API and message protocols          | Owning developer      | Route, schema, state, compatibility, or error changes                      |
| Deployment and runbooks            | Platform operator     | Config, prerequisite, topology, recovery, or command changes               |
| Permissions, audit, and security   | Security owner        | Principal, grant, approval, secret, trust-boundary, or audit-event changes |
| Test plans and acceptance records  | Quality owner         | Acceptance criteria, test matrix, or release-gate changes                  |
| Navigation and templates           | Documentation steward | New, moved, superseded, or removed documents                               |

The implementation owner updates affected documents in the same pull request. The
accountable role verifies behavioral claims; the documentation steward verifies status,
placement, links, and readability. High-risk security or operational changes require the
corresponding owner even when the text change is small.

## Review checklist

- The audience, status, prerequisites, scope, and out-of-scope behavior are explicit.
- Current claims have repository evidence; proposals are not written in the present
  tense.
- Commands and paths exist and use repository-pinned tooling.
- Permissions, audit effects, errors, rollback, and failure recovery are covered when
  applicable.
- Related navigation and cross-links are updated.
- `npm run format:check` passes; affected contract tests run when a normative document
  is executable test input.
