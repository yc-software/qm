# Google Workspace Action Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Enforce explicit one-time trash approvals without giving agent code unrestricted Google OAuth tokens.

**Architecture:** A core Google service validates allowlisted requests and calls Google with the current person's server-held token. Existing dynamic tools, durable approval records, and approval cards provide the interaction.

**Tech Stack:** TypeScript, Node >=24.15.0, existing Postgres stores and test runner.

**Spec:** docs/superpowers/specs/2026-09-18-google-action-controls-design.md

## Global Constraints

No new code comments. No private organization identifiers. No new dependencies. No permanent deletion. No raw OAuth tokens in agent results, environment, or credential materialization when guarded mode is enabled.

## Task 1: Trusted Google service

Files: src/connectors/google-workspace.ts; test/google-workspace.test.ts.

Interface: export GOOGLE_WORKSPACE_HOSTS, googleWorkspaceToolDefs, createGoogleWorkspaceService(opts). opts: {principalId:string, accountType?:string, tokens:ConnectorTokenStore, fetchImpl?:typeof fetch, authorize:(command:string,key:string)=>boolean, audit?:(event:{action:string,resource:string,status:string})=>void}. Return {call(name:string,args:Record<string,unknown>):Promise<string>}. Throw NeedsApproval with one-time grantModes for trash; throw ordinary validation errors otherwise. Parent integrates tool dispatch and supplies actor-bound authorization.

- [x] Write tests using a fake fetch that records URL/method/body and returns minimal Google JSON.
- [x] Verify tests fail before implementation.
- [x] Implement allowlisted Drive and document requests and authoritative trash preview.
- [x] Test blocked DELETE, trashed metadata, alternate hosts/paths, method override, redirects, invalid IDs, folder size/pagination, approval-before-write, exact snapshot binding, successful editing and uploads.
- [x] Run node --test test/google-workspace.test.ts; independently review.

## Task 2: Credential confinement

Files: src/credentials/keychain.ts; src/wiring.ts; credential tests.

Interface: createKeychain gets optional blockedConnectorMaterializationHosts: readonly string[]. Guarded wiring passes GOOGLE_WORKSPACE_HOSTS. All materialization/derived-auth routes deny those connector credentials without breaking core connectorAccessToken access or metadata/status/refresh.

- [x] Add failing tests for own/grant/standing/derived auth and server-only token retrieval.
- [x] Implement shared guard at materialization helpers and filter standing injection safely.
- [x] Search all raw token and derived credential exports and test every applicable path.
- [x] Run affected keychain tests; independently review.

## Task 3: Approval and tool integration

Files: src/tools/primitives.ts; src/harness/agent-tools.ts; src/harness/harness.ts; src/core/orchestrator.ts; src/types.ts; relevant orchestrator/tool tests.

- [x] Add failing tests for dynamic tool NeedsApproval propagation and per-request grant-mode restrictions.
- [x] Carry grantModes through NeedsApproval, harness pending approvals, and durable approval records.
- [x] Enforce per-record grant modes for every approval, not only security-screen release.
- [x] Compose trusted Google tools with existing MCP tool descriptors in guarded mode; dispatch core service directly and preserve existing MCP behavior.
- [x] Skip raw Google injection across all provider hosts; expose personal operations only where current actor's keychain is authorized; use core keychain without operator fallback.
- [x] Ensure once-only trash cannot use persistent grants and retain existing requester binding.
- [x] Run affected auth, keychain, tools, approval tests, typecheck and lint.

## Task 4: Acceptance and rollout

- [x] Independent adversarial security review; resolve findings.
- [ ] Boot dev instance using the skill, test exact approval/deny/approve UI with synthetic Google transport, and capture a demo.
- [ ] Scrub upstream history and prepare PR only after live QA.
- [ ] Assess production update compatibility and shared/cached credential cutover before deployment.
- [ ] Record precise shipped versus pending status; do not describe tests or policy as live until verified.
