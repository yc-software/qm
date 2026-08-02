# Documentation audit: 2026-08-02

**Status: Current audit.** This report describes the repository at the audited revision.
It does not claim that planned Agent Squad Workspace capabilities exist.

**Audited revision:** `7f2c916`

## Scope and method

The audit covered repository Markdown, root and package scripts, CI workflow, API route
layout, and the directories that own identity, ACL, audit, tasks, runs, projects,
workspaces, and persistence. Generated skill content and third-party reference material
under `skills-seed/` were classified as product assets rather than maintainer
documentation.

Claims were checked against repository paths. Commands were taken from `package.json`,
package-level manifests, or the CLI documentation. This audit did not deploy QM or
exercise provider-specific infrastructure.

## Inventory

| Area                  | Existing source                                                                  | Assessment                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Product overview      | `README.md`                                                                      | Strong current overview, architecture sketch, security posture, deployment entry, and links                                                 |
| First deployment      | `docs/getting-started.md`                                                        | Accurate but narrowly focused on organization deployment; not a contributor quick start                                                     |
| Deployment contract   | `docs/deploy-directory.md`, `cli/README.md`                                      | Detailed and partly executable through `test/deploy-directory-doc.test.ts`                                                                  |
| Operator workflow     | `deployment.md`, `cli/templates/deployment/`, `deploy/README.md`                 | Clear authority chain, but information is distributed across template and provider references                                               |
| Configuration         | `.env.example`, deployment contract, plugin READMEs                              | Names are documented near owners; no unified configuration index by audience                                                                |
| Contribution          | `AGENTS.md`, `CONTRIBUTING.md`                                                   | Strong repository rules and proposal path; no concise environment setup or change-to-test matrix                                            |
| Architecture          | `README.md` and module layout                                                    | Only a high-level diagram; no maintained component, data, or request-flow architecture document                                             |
| Decisions             | `adrs/`                                                                          | No decision records existed; `CONTRIBUTING.md` routes proposals there, but status and decision lifecycle were unspecified                   |
| HTTP API              | `src/api/routes/`, plugin READMEs                                                | Route behavior exists in code and scattered module docs; no API index, schema catalog, compatibility policy, or error model                 |
| Agent protocol        | `src/api/agent-api-catalog.ts`, `src/api/contract.ts`                            | Implementation exists; no audience-facing protocol contract                                                                                 |
| Permissions and audit | `SECURITY.md`, `src/acl/`, `src/audit/`, related tests                           | Threat model is strong; principal/action/resource mapping and audit event catalog are absent                                                |
| Testing               | Root and package scripts, `.github/workflows/cicd.yml`, `cli/test/e2e/README.md` | Broad automated coverage; no test strategy, test-data guide, or acceptance evidence format                                                  |
| Operations            | Generated deployment runbook and provider references                             | Deployment is detailed; incident triage, backup/restore drills, degraded-mode behavior, and service-level runbooks are fragmented or absent |
| Plugins and Slack     | `plugins/*/README.md`, `src/slack/README.md`                                     | Useful local contracts, but style, prerequisites, and freshness signals vary                                                                |
| Agent Squad Workspace | None before this change                                                          | Product intent, current/planned boundary, domain terms, protocols, delegation, review, and recovery need dedicated documentation            |

## Findings

### High priority

1. There was no repository-wide documentation entry point. Readers had to infer the
   route from the root README and directory names. `docs/README.md` now provides the
   audience-based navigation.
2. Current QM behavior and the planned Agent Squad Workspace extension had no explicit
   separation. The new extension landing page uses current/planned labels and reserves
   the required domain, protocol, security, audit, recovery, and testing documents.
3. API and agent-message contracts are not documented as contracts. Future protocol
   work needs request/response schemas, authorization, idempotency, ordering, errors,
   compatibility, and audit effects before implementation can be independently tested.
4. There is no maintained detailed architecture source. A checked-in architecture
   baseline must establish component ownership, durable data, execution boundaries, and
   request/task flows before an accepted Agent Squad design depends on them.
5. Documentation ownership and update triggers were absent. The new policy assigns
   accountable roles without inventing people or a `CODEOWNERS` configuration.

### Medium priority

1. A contributor can find commands in manifests but not a single environment setup and
   affected-test guide. Add a contributor development guide after verifying the minimal
   local services and credentials.
2. Deployment documentation is intentionally layered but repeats entry instructions.
   Keep `docs/deploy-directory.md` normative, the generated template operational, and
   other pages as links plus context.
3. Tests are extensive but acceptance evidence is not standardized. The test-plan and
   acceptance-record templates provide a starting format without replacing executable
   tests.
4. Security documentation describes threats and limitations but not an authorization
   matrix or audit event catalog. Agent delegation must not ship until those extension
   contracts are explicit and tested negatively.
5. Runbooks cover deployment better than incidents and recovery. Per-service symptoms,
   diagnostics, mitigation, rollback, data safety, escalation, and post-recovery checks
   remain to be written.

### Specific stale or unverifiable content

- `plugins/web-ui/README.md` cited `ADR-0003 D2/D4`, but no such record exists in
  `adrs/` or elsewhere in the repository. This change removes the unresolved citation;
  current behavior remains testable in `test/file-channel-share.test.ts`.
- Plugin READMEs use references such as `spec section` without a checked-in spec. Treat
  those labels as historical context, not navigable evidence, until the source document
  is restored or the references are replaced with current contracts.
- Several operational claims require cloud accounts, credentials, or live services.
  They are documented but were not independently exercised in this audit.

## Target information architecture

| Reader                       | Start                    | Next authoritative sources                                                       |
| ---------------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| Product user                 | `README.md`              | Current surface guide, security policy, deployment start                         |
| Contributor                  | `docs/README.md`         | `AGENTS.md`, contributor setup, architecture, ADRs, API contracts, test strategy |
| Platform operator            | `deployment.md`          | Generated runbook, deployment contract, service runbooks, recovery procedures    |
| Security reviewer            | `SECURITY.md`            | Permission matrix, audit catalog, protocol authorization, negative tests         |
| Product and quality reviewer | Agent Squad landing page | Feature specs, test plans, acceptance records, known limitations                 |

The detailed placement and single-source rules are in
[`documentation-policy.md`](./documentation-policy.md).

## Prioritized roadmap

| Priority | Deliverable                                                 | Owner                               | Exit evidence                                                                                 |
| -------- | ----------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------- |
| P0       | QM architecture baseline and Agent Squad extension boundary | Architecture owner                  | Current flow and data claims cite code/tests; proposed changes are separate                   |
| P0       | First vertical-slice feature specification and ADR set      | Product and architecture owners     | Scope, alternatives, permission boundaries, failure states, and acceptance criteria approved  |
| P0       | API/message and delegation protocol contract                | Owning developer and security owner | Schemas, authorization, audit, idempotency, ordering, retries, and compatibility are testable |
| P1       | Contributor development and test guide                      | Developer and quality owner         | Clean checkout can run documented focused checks with stated prerequisites                    |
| P1       | Permission matrix and audit event catalog                   | Security owner                      | Positive and negative access cases map to tests and recorded events                           |
| P1       | Failure recovery and operator runbooks                      | Platform operator                   | Failure drills include safe diagnosis, mitigation, rollback, and verification                 |
| P1       | Test strategy and release acceptance record                 | Quality owner                       | CI/local gates and evidence ownership are explicit                                            |
| P2       | Automated internal-link and documentation freshness checks  | Documentation steward               | CI detects broken relative links and stale generated contracts                                |

The project architecture baseline completed during this audit. Its accepted planning
terms are reflected in the Agent Squad landing page: Project-compatible Workspace,
AgentProfile, Task/TaskAttempt, Delegation, Message, Artifact/TaskArtifact, and
Review/Check/AcceptanceDecision. A checked-in architecture document remains P0 because
the project issue is not a durable repository source of truth.
