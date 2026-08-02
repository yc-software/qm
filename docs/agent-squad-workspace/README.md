# Agent Squad Workspace

**Status: Proposed.** Agent Squad Workspace is a planned extension of QM. Unless a
statement links to current QM code, tests, or an accepted decision, it is a target and
not an available product capability.

## Intended audience and outcome

This section is the shared starting point for product owners, contributors, quality
reviewers, security reviewers, and operators designing a bounded multi-agent workspace.
The intended outcome is a team-oriented environment in which specialized agents divide
work, communicate, review results, and produce verifiable delivery evidence without
bypassing identity, permission, audit, or sandbox boundaries.

## Current foundation and planned extension

| Area                   | Current QM evidence                           | Proposed Agent Squad extension                                                         |
| ---------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Identity and access    | `src/identity/`, `src/acl/`, `SECURITY.md`    | AgentProfile configuration, validated Agent principal semantics, and delegation checks |
| Durable execution      | `src/runs/`, `src/tasks/`, `src/persistence/` | Task/TaskAttempt separation, dependency-aware coordination, and resumable workflows    |
| Isolated work          | `src/sandbox/`, `src/resolution/`             | Per-agent execution context with authorized shared project resources                   |
| Projects and artifacts | `src/projects/`, `src/files/`                 | Structured task inputs, outputs, artifacts, and acceptance evidence                    |
| Audit and policy       | `src/audit/`, `src/policy/`                   | Initiator, executor, delegation chain, approval, and review attribution                |
| Surfaces               | `plugins/web-ui/`, `src/slack/`               | Squad configuration, goal submission, progress, review, and approval views             |

The current directories show reusable QM foundations, not proof that the proposed
multi-agent behaviors already exist. The accepted planning baseline keeps Project as the
MVP Workspace compatibility anchor and keeps Run/Worker/Orchestrator/Harness/Sandbox as
the execution data plane; Squad, Task DAG, Delegation, and acceptance are a new control
plane.

## Shared terminology

These are the accepted planning terms from the project architecture baseline. They
remain proposed repository contracts until implemented and recorded in accepted ADRs:

- **Workspace**: an authorized project collaboration boundary containing resources,
  tasks, artifacts, and policy. The MVP maps this boundary to the existing QM Project
  rather than introducing a second identity domain.
- **Squad / SquadMember**: a Workspace-scoped orchestration template whose members
  reference AgentProfiles and define leader, responsibilities, and versioned routing
  rules.
- **AgentProfile**: an organization-level reusable configuration for role, prompt,
  approved harness/model, skills, tool policy, and budget ceiling. It does not hold Task
  state.
- **Task**: an accountable unit of work with an owner, inputs, outputs, state, and
  acceptance criteria.
- **TaskAttempt**: one execution attempt with an AgentProfile/Squad configuration
  snapshot, related Run IDs, cost, sandbox route, and termination reason. A retry creates
  a new Attempt instead of overwriting history.
- **Dependency**: a prerequisite relationship that constrains when a Task may run.
- **Delegation**: an attributed transfer of bounded work and authority from one actor to
  another.
- **Message**: a structured collaboration record such as delegation, question,
  progress, review feedback, or result.
- **Artifact / TaskArtifact**: a durable output plus its input, output, or evidence
  relationship to a Task, retaining producer Attempt, hash, and visible scope.
- **Review / Check / AcceptanceDecision**: reviewer opinion, machine evidence, and the
  decision that satisfies a Task's delivery gate. A successful Run or an Agent's
  completion claim alone is not acceptance.

## Required invariants

The extension design must preserve these current QM boundaries unless an accepted ADR
explicitly changes them with migration and security review:

- Core, not model output or sandbox code, enforces identity, scope, grants, delivery,
  and deterministic effect gates.
- Delegation cannot grant authority the delegator does not hold.
- Durable tasks, messages, approvals, audit records, and recoverable workflow state do
  not rely on one process's memory.
- Shared conclusions and artifacts are authorized explicitly; private process context
  does not become squad-visible by default.
- Every high-risk action has an attributable initiator, executor, delegation chain, and
  approval result where required.
- Completion requires specified evidence such as tests, review, or human approval.
- A Run completion ends an Attempt; it does not directly accept a Task.
- Planned security controls do not erase the limitations documented in
  [`SECURITY.md`](../../SECURITY.md).

## Documentation set and readiness gates

Create these documents only when they contain reviewable substance:

| Path                          | Minimum content before implementation depends on it                                          | Accountable role   |
| ----------------------------- | -------------------------------------------------------------------------------------------- | ------------------ |
| `domain-model.md`             | Entity identity, ownership, state, lifecycle, durability, and relationships                  | Architecture owner |
| `architecture.md`             | Current flow, extension boundaries, data ownership, integration points, and ADR links        | Architecture owner |
| `api-and-message-protocol.md` | Schemas, authorization, ordering, idempotency, errors, retries, versioning, and examples     | Owning developer   |
| `permissions-and-audit.md`    | Principal/action/resource matrix, delegation constraints, approvals, and audit events        | Security owner     |
| `failure-recovery.md`         | Failure taxonomy, retry ownership, cancellation, compensation, resume, and operator recovery | Platform operator  |
| `testing-and-acceptance.md`   | Success, error, permission, concurrency, idempotency, recovery, and regression evidence      | Quality owner      |

Use the templates listed in the [documentation index](../README.md#maintainers) and
follow the [`documentation policy`](../documentation-policy.md). A future implementation
PR must update affected current-state documents and remove or revise superseded proposal
text.

## Known open decisions

- Whether an Agent is a non-human principal, an AgentProfile attached to an existing
  principal, or both; this requires a threat-model spike before sharing credentials.
- The authoritative Task state machine and dependency scheduling semantics. The current
  recommendation is `draft -> ready -> running -> awaiting_review -> accepted`, plus
  `blocked`, `failed`, and `cancelled`, with only accepted dependencies becoming ready.
- How delegation narrows permissions, budget, time, tools, and resource scope.
- Message delivery guarantees, ordering, deduplication, retention, and visibility.
- Artifact ownership and merge behavior across isolated execution environments.
- Required Review, Check, AcceptanceDecision, and human approval gates.
- Cancellation, partial failure, retries, compensation, and orphan recovery.

The recommended first vertical slice is one existing QM Project as the Workspace, one
fixed Squad, a Leader producing two schema-validated dependent Tasks, TaskAttempts backed
by existing Runs, Artifact and Check evidence, independent Review and AcceptanceDecision,
then a Leader summary using only accepted outputs. Dynamic routing, automatic merging,
and a second workflow engine remain out of scope until this slice is verified.

Resolve these through feature specifications and ADRs before describing their behavior
as current.
