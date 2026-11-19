# Private computer context — implementation in progress

This checkpoint is local and incomplete. Do not treat the resource-level tests as full computer isolation or rollout approval.

Implemented locally: private conversations cannot select shared computers even under open sharing; private resource flags and a separate private default slot; owner-personal privacy/provenance inheritance; immutable privacy on reservation retries; private-aware resource lists and backend I/O checks when a context facade is used. All orchestrator turns now receive the context facade and a router bound to it. Ordinary and private default handles use separate turn-cache entries. Trusted teardown/file cleanup retains its original lifecycle service so a late privacy transition can still clean up previously authorized handles.

Not finished: complete job/child/background coverage, native canary qualification and the remaining execution-path audit. Do not merge or claim complete until these are proved.

## Stored shapes

No new SQL table, column, key, index, constraint or enum. Existing JSON records add optional fields. Every original field is retained. The versioned cutover described below now classifies historical personal resources and moves their default pointers. SourceProvenance retains {sensitivity:"ordinary"|"unknown"|"sensitive"|"restricted",sources:ScopeId[],sourceUnknown:boolean}.

Invented before: resource {id:"example",backend:"local",ownerScopeId:"personal:alice",backingScopeId:"sandbox-example",name:"Analysis",createdBy:"alice",createdAt:"2026-01-01T00:00:00Z",legacy:false,state:"ready"}; default {sandboxId:"ordinary-id"}. New private resource: all the same resource keys plus personalOnly:true and sourceProvenance:{sensitivity:"ordinary",sources:["personal:alice"],sourceUnknown:false}. Selecting it privately changes the default row to {sandboxId:"ordinary-id",privateSandboxId:"example"}. Clearing the private selection sets only privateSandboxId:null. Ordinary selection remains independent. The current code never converts an ordinary machine to private during a turn.

## SandboxResource

### Before

```typescript
export interface SandboxResource {
  id: string;
  backend: SandboxBackendName;
  ownerScopeId: ScopeId;
  backingScopeId: string;
  name: string;
  createdBy: string;
  createdAt: string;
  legacy: boolean;
  state: "unverified" | "provisioning" | "ready" | "failed" | "retired";
  availableActions?: string[];
  cleanupPending?: boolean;
  holders?: string[];
  spec?: AgentComputerSpec;
  error?: string;
  jobOnly?: boolean;
  memoryGb?: number;
  swarmId?: string;
  personUsed?: true;
}
```

### Local implementation

```typescript
export interface SandboxResource {
  personalOnly?: true;
  sourceProvenance?: SourceProvenance;
  id: string;
  backend: SandboxBackendName;
  ownerScopeId: ScopeId;
  backingScopeId: string;
  name: string;
  createdBy: string;
  createdAt: string;
  legacy: boolean;
  state: "unverified" | "provisioning" | "ready" | "failed" | "retired";
  availableActions?: string[];
  cleanupPending?: boolean;
  holders?: string[];
  spec?: AgentComputerSpec;
  error?: string;
  jobOnly?: boolean;
  memoryGb?: number;
  swarmId?: string;
  personUsed?: true;
}
```

## SandboxDefault

### Before

```typescript
export interface SandboxDefault {
  sandboxId: string | null;
}
```

### Local implementation

```typescript
export interface SandboxDefault {
  sandboxId: string | null;
  privateSandboxId?: string | null;
}
```

## SandboxResources

### Before

```typescript
export interface SandboxResources {
  profiles(): SandboxProviderProfile[];
  forTurn(turn: { actorId: string; scopeId: ScopeId; isCurrent: () => Promise<boolean> }): SandboxResources;
  initialize(): Promise<void>;
  list(
    actorId: string,
    scopeId: ScopeId,
  ): Promise<{
    sandboxes: SandboxResource[];
    defaultSandboxId: string | null;
    defaultMode: "none" | "selected";
    providers: SandboxProviderProfile[];
  }>;
  create(
    actorId: string,
    scopeId: ScopeId,
    backend: string,
    name?: string,
    reservationId?: string,
    jobOnly?: boolean,
    memoryGb?: number,
    swarmId?: string,
    personUsed?: boolean,
  ): Promise<SandboxResource>;
  eachJobComputer(work: (computer: SandboxResource) => Promise<void>): Promise<void>;
  retireJobComputer(id: string, seenState: SandboxResource["state"]): Promise<void>;
  access(actorId: string, id: string): Promise<SandboxResource>;
  status(actorId: string, id: string): Promise<ComputerStatus>;
  restart(actorId: string, id: string, memoryGb?: number): Promise<void>;
  retire(actorId: string, id: string): Promise<void>;
  notePersonUse(id: string): Promise<SandboxResource>;
  use<T>(id: string, action: () => Promise<T>, exclusive?: boolean): Promise<T>;
  hold(id: string, runId: string): Promise<void>;
  recordLoad(id: string, sample: LoadSample): Promise<void>;
  load(id: string): Promise<LoadSample | null>;
  release(id: string, runId: string | undefined, isLive: (runId: string) => Promise<boolean>): Promise<boolean>;
  setDefault(actorId: string, scopeId: ScopeId, id: string | null): Promise<void>;
  resolve(scopeId: ScopeId): Promise<SandboxResource | null>;
  get(id: string): Promise<SandboxResource>;
  getMany(ids: readonly string[]): Promise<SandboxResource[]>;
  defaultBackend(): Promise<SandboxBackendName>;
}
```

### Local implementation

```typescript
export interface SandboxResources {
  profiles(): SandboxProviderProfile[];
  forTurn(turn: {
    actorId: string;
    scopeId: ScopeId;
    isCurrent: () => Promise<boolean>;
    privacy?: SandboxPrivacyContext;
  }): SandboxResources;
  initialize(): Promise<void>;
  authorizeScratch(scopeId: ScopeId, personalOnly: boolean): Promise<void>;
  list(
    actorId: string,
    scopeId: ScopeId,
  ): Promise<{
    sandboxes: SandboxResource[];
    defaultSandboxId: string | null;
    defaultMode: "none" | "selected";
    providers: SandboxProviderProfile[];
  }>;
  create(
    actorId: string,
    scopeId: ScopeId,
    backend: string,
    name?: string,
    reservationId?: string,
    jobOnly?: boolean,
    memoryGb?: number,
    swarmId?: string,
    personUsed?: boolean,
  ): Promise<SandboxResource>;
  eachJobComputer(work: (computer: SandboxResource) => Promise<void>): Promise<void>;
  retireJobComputer(id: string, seenState: SandboxResource["state"]): Promise<void>;
  access(actorId: string, id: string): Promise<SandboxResource>;
  status(actorId: string, id: string): Promise<ComputerStatus>;
  restart(actorId: string, id: string, memoryGb?: number): Promise<void>;
  retire(actorId: string, id: string): Promise<void>;
  notePersonUse(id: string): Promise<SandboxResource>;
  use<T>(id: string, action: () => Promise<T>, exclusive?: boolean): Promise<T>;
  hold(id: string, runId: string): Promise<void>;
  recordLoad(id: string, sample: LoadSample): Promise<void>;
  load(id: string): Promise<LoadSample | null>;
  release(id: string, runId: string | undefined, isLive: (runId: string) => Promise<boolean>): Promise<boolean>;
  setDefault(actorId: string, scopeId: ScopeId, id: string | null): Promise<void>;
  resolve(scopeId: ScopeId): Promise<SandboxResource | null>;
  get(id: string): Promise<SandboxResource>;
  getMany(ids: readonly string[]): Promise<SandboxResource[]>;
  defaultBackend(): Promise<SandboxBackendName>;
}
```

The createSandboxResources constructor retains all previous options and adds privacy?:SandboxPrivacyContext. The new context type is:

```typescript
export interface SandboxPrivacyContext {
  current(): Promise<PrivateContext>;
  sessions: Pick<SessionStore, "recordContextProvenance">;
}
```

OrchestratorDeps retains every original field and adds optional sandboxForTurn:(resources:SandboxResources)=>Sandbox and cleanupSandbox:Sandbox. TurnSandboxContext adds optional privateContext:()=>Promise<PrivateContext>. createTurnSandboxAccess accepts that same trusted callback. None are user settings or provider modes; the existing private conversation determines routing. The callback refreshes persisted session state. Existing Sandbox provider interfaces are unchanged.

## Remaining security work

Computer API credentials now carry a signed computer binding and independent private-read grant. Native host credentials remain separate. The default, explicit, and job provisioning paths use the canonical resource flag; ordinary scratch gets no private authority. Credentials without the new private-read grant retain ordinary access but cannot read private managed data. A conversation becoming private does not upgrade an ordinary computer's old token. HTTP private file, skill, memory, conversation, computer catalog, attachment, and admin-read boundaries preserve and enforce this distinction. Native scoped context constructors explicitly carry their trusted private-read authority.

Conversation mutation inherits the target's privacy before changing participant state and again before returning metadata. A real HTTP regression demonstrated the previous metadata leak and passes with this fix. Git access tokens now carry the same independent signed privateRead grant in their context: personalOnly alone does not authorize private app source. Legacy Git credentials must be reissued for private app access. Ordinary existing links cannot gain private access after an app becomes private.

Private scratch now uses the provider disposable path, a separate privacy namespace and computer-bound credentials. Every scratch I/O operation through the contextual router rechecks current conversation privacy. Historical persistent-machine classification now uses the cutover below; scratch does not restore or publish ordinary personal home snapshots. Registered jobs, process recovery, credentials, isolated children, and swarm bindings need the same authority. The get/resolve/use facade must cover actual model I/O while preserving trusted maintenance operations. Admin resource routes and HTTP outbound attachment collection now use request context and the matching router.

Historical personal machines cannot be assumed clean. The versioned cutover below preserves their backing data and classifies them private with unknown provenance. Shared-owned resources keep their ownership. Identify any known shared QA computer that held private data and quarantine or clean it explicitly. Do not infer privacy from names at runtime. Do not claim control of arbitrary external network data from these managed-resource checks.

## Evidence so far

The four new privacy/provisioning regressions fail against the previous computer modules: private execution on a shared machine, private ordinary-scratch access, reuse after a late private transition, and privacy changing during an outstanding provision. Logs: /tmp/qm-private-computer-privacy-baseline.log and /tmp/qm-private-computer-open-red.log. The baseline archive is8d8614c; those computer modules are unchanged througha6481a6.

The earlier four-file routing/pool/document/private-trigger batch passes, including26 pool cases. New resource cases verify separate defaults, shared/admin refusal, durable session taint, and rejection of an already-provisioned ordinary handle after a private resource read. The resource suite passes56/58; both load-probe failures reproduce on the unchanged baseline because the local test host lacks Linux /proc. Typecheck and changed-file ESLint pass.

An asynchronous privacy read initially moved before pending-provision registration, breaking the existing synchronous invalidation contract and stalling the pool test. The two owned test children were stopped after process/database inspection; provisioning now registers pending work synchronously and rechecks privacy after awaiting it. The complete26-case pool suite passes. These are local implementation checks; no native private-computer proof or full-boundary acceptance is claimed. This remains a local implementation checkpoint, not a pushed or native-qualified boundary.

## Credential and context payloads

All existing fields are retained. The following complete interfaces show the previous and local shapes. No SQL column, index, constraint, enum or environment setting is added. Existing signed envelope versions and compression remain unchanged. Missing privateRead on verified control-plane tokens normalizes to false; ordinary-computer tokens clamp it to false even if another producer requested true. Newly minted native control-plane tokens get true unless explicitly restricted. Private computer tokens also remove org/team memory-write grants. Other capability audiences retain their existing behavior.

### CapabilityClaims: Before

```typescript
export interface CapabilityClaims {
  tenant?: string;
  externalSlack?: true;
  actorId: string;
  browserModel?: string;
  browserAccount?: "company" | "personal" | "openai" | "anthropic";
  aud?: string;
  scopeId: ScopeId;
  audienceScopeId?: ScopeId;
  scopeVersion?: string;
  timezone?: string;
  destination?: Destination;
  destinations?: CandidateDestination[];
  defaultDestinationKey?: string;
  credentials?: string[];
  ownerConnections?: boolean;
  members?: Principal[];
  keychainMembers?: Principal[];
  privateScope?: boolean;
  personalOnly?: true;
  egress?: EgressPolicy;
  blob?: BlobGrant;
  drop?: string;
  memory?: MemoryAccess;
  liveActor?: boolean;
  runId?: string;
  sessionId?: string;
  origin?: SessionOrigin;
  runAttempt?: number;
  runLeaseToken?: string;
  deployment?: string;
  botActor?: boolean;
  liveAuthor?: boolean;
  actAsActor?: boolean;
  triggered?: boolean;
  threadRef?: string;
  surface?: string;
  liveReplies?: boolean;
  exp: number;
}
```

### CapabilityClaims: Local implementation

```typescript
export interface CapabilityClaims {
  computer?: ComputerCapability;
  privateRead?: boolean;
  tenant?: string;
  externalSlack?: true;
  actorId: string;
  browserModel?: string;
  browserAccount?: "company" | "personal" | "openai" | "anthropic";
  aud?: string;
  scopeId: ScopeId;
  audienceScopeId?: ScopeId;
  scopeVersion?: string;
  timezone?: string;
  destination?: Destination;
  destinations?: CandidateDestination[];
  defaultDestinationKey?: string;
  credentials?: string[];
  ownerConnections?: boolean;
  members?: Principal[];
  keychainMembers?: Principal[];
  privateScope?: boolean;
  personalOnly?: true;
  egress?: EgressPolicy;
  blob?: BlobGrant;
  drop?: string;
  memory?: MemoryAccess;
  liveActor?: boolean;
  runId?: string;
  sessionId?: string;
  origin?: SessionOrigin;
  runAttempt?: number;
  runLeaseToken?: string;
  deployment?: string;
  botActor?: boolean;
  liveAuthor?: boolean;
  actAsActor?: boolean;
  triggered?: boolean;
  threadRef?: string;
  surface?: string;
  liveReplies?: boolean;
  exp: number;
}
```

### PrivateContext: Before

```typescript
export interface PrivateContext {
  actorId: string;
  scopeId?: ScopeId;
  audienceScopeId?: ScopeId;
  sessionId?: string;
  personalOnly?: true;
  botActor?: boolean;
  sourceProvenance?: SourceProvenance;
}
```

### PrivateContext: Local implementation

```typescript
export interface PrivateContext {
  computer?: ComputerCapability;
  privateRead?: boolean;
  actorId: string;
  scopeId?: ScopeId;
  audienceScopeId?: ScopeId;
  sessionId?: string;
  personalOnly?: true;
  botActor?: boolean;
  sourceProvenance?: SourceProvenance;
}
```

### MemoryDisclosure: Before

```typescript
export interface MemoryDisclosure {
  actor: Principal;
  targetScope: ScopeId;
  audienceScopeId?: ScopeId;
  nativeScopes: readonly ScopeId[];
  audience: readonly Principal[];
  open: boolean;
  notebookOnly?: boolean;
  config?: Pick<ScopedConfigStore, "resolveSharingPostureDurable">;
  isCurrentSharedScopeMember?: IsCurrentSharedScopeMember;
  currentScopeMembers?: CurrentScopeMembers;
  onDisclosure?: (facts: readonly MemoryProvenance[]) => Promise<boolean>;
  nativeSources?: (scopes: readonly ScopeId[]) => Promise<readonly ScopeId[]>;
}
```

### MemoryDisclosure: Local implementation

```typescript
export interface MemoryDisclosure {
  computer?: ComputerCapability;
  privateRead?: boolean;
  actor: Principal;
  targetScope: ScopeId;
  audienceScopeId?: ScopeId;
  nativeScopes: readonly ScopeId[];
  audience: readonly Principal[];
  open: boolean;
  notebookOnly?: boolean;
  config?: Pick<ScopedConfigStore, "resolveSharingPostureDurable">;
  isCurrentSharedScopeMember?: IsCurrentSharedScopeMember;
  currentScopeMembers?: CurrentScopeMembers;
  onDisclosure?: (facts: readonly MemoryProvenance[]) => Promise<boolean>;
  nativeSources?: (scopes: readonly ScopeId[]) => Promise<readonly ScopeId[]>;
}
```

The new shared binding shape is:

```typescript
export interface ComputerCapability {
  personalOnly: boolean;
  resourceId?: string;
}
```

DeployGitAccess is unchanged at the envelope level:

```typescript
export interface DeployGitAccess {
  context?: DeployGitContext;
  deploymentId: string;
  permission: "read" | "write";
  principalId?: string;
  version: 1;
  exp: number;
}
```

DeployGitContext remains Omit<PrivateContext,"actorId"|"sourceProvenance">; the full old/new PrivateContext interfaces above account for its two additional optional fields. Issuance now always includes context.privateRead. Verification rejects malformed values; private access requires true independently of context.personalOnly, and a computer with personalOnly:false is still refused. Existing ordinary Git links remain usable for ordinary source; old links cannot acquire private access. Provider-managed Git principal authorization is unchanged.

Invented payload examples: a previous control-plane payload {actorId:"alice",scopeId:"personal:alice",sessionId:"chat",aud:"control-plane",exp:2000000000000} becomes the same payload plus privateRead:true for native host use. Its ordinary-computer counterpart adds computer:{personalOnly:false,resourceId:"ordinary-id"},privateRead:false. A private-computer counterpart uses computer:{personalOnly:true,resourceId:"private-id"},privateRead:true,personalOnly:true. Expiry, tenant binding and other original claims remain in each actual payload. An old Git context {scopeId:"personal:alice",sessionId:"chat",personalOnly:true} must be reissued with privateRead:true before it can read private source; personalOnly is not retroactively treated as permission.

Rollout is not yet qualified: stop/drain old workers and old credential producers before enabling the private computer boundary. The historical computer/default cutover below has run in the isolated local QA database; production rollout remains unqualified. Do not mix old workers that expose native host tokens to ordinary computers with new private-data handlers.

## Credential checkpoint verification

The metadata mutation regression failed on the pre-fix code through actual HTTP, returning the private conversation thread reference: /tmp/qm-computer-metadata-red.log. The corrected computer API file and file/Git token tests pass in /tmp/qm-computer-metadata-green.log; that first batch's sole failure was the old expected Git-context payload shape. The corrected expected shape passes in /tmp/qm-computer-authority-regressions.log: 7/7 files, covering 22 private-app, 15 capability-token, 11 trigger, 17 skill-release, 8 schedule-publication, 26 pool and 27 open-continuity cases. The separate computer API, file-release and Git token files pass. Typecheck passes. Those earlier results did not cover migration, scratch or background paths; later checkpoints below cover the first two. Background-path audit remains incomplete.

Independent reviewer /root/private_outputs_plan_review: Accept, 95/100 for the two credential/API findings on the working diff after a6481a6. It confirmed pre/post mutation inheritance and the independent signed Git grant; it excluded scratch, migration and broader boundary completion. The reviewer requested rerunning the updated expected shape; the seven-file batch above satisfies that request. This is not a full-head lens acceptance or substituted model coverage.

## Scheduled execution history checkpoint

An ordinary schedule can produce a private execution session without changing the schedule template. Its saved reply now inherits the execution session's privacy/provenance before history is returned. This uses one batched SessionStore.getMany lookup. The existing inheritSessionContext helper gains optional threadRefs:readonly string[]=[] alongside sourceIds; requested missing IDs or thread references fail closed. All previous ID-only callers retain their behavior.

The internal App interface previously had no equivalent batch inheritance method. It now adds exactly:

```typescript
inheritSessionContext(
  context: PrivateContext,
  sourceIds: readonly string[],
  threadRefs?: readonly string[],
): Promise<Set<string>>;
```

No HTTP request or response shape changes, stored fields, SQL changes or configuration are introduced. Refused history uses the existing forbidden response. Authorized native reads persist context inheritance; ordinary-computer reads cannot acquire private authority. The schedule stays ordinary. Reply-bearing or explicit-session rows require a resolvable execution context; orphan replies are withheld rather than returned without provenance. Existing scheduler producer census: skipped/error/loop rows carry status/note, exact-text trigger delivery does not produce a saved reply, and dynamic reply text comes from the run outcome (scheduler.ts/run-trigger.ts). Genuinely sessionless status/note records retain their behavior.

The new late-private execution regression reproduced saved private reply leakage through getCronRuns before the fix (/tmp/qm-private-fire-history-red.log). It now tests ordinary-computer refusal, native inheritance, unchanged template privacy and refusal of orphan replies. The actual HTTP computer-boundary test additionally exercises /v1/crons/:id/runs with ordinary and private computer credentials; /tmp/qm-private-fire-history-http.log passes2/2. Independent reviewer /root/private_outputs_plan_review accepted95 after the orphan-reply correction; its assessment excludes unfinished computer migration/scratch/background work. Final batch /tmp/qm-private-fire-history-final.log passes3/3 files (12 private-trigger,8 private schedule publication,2 computer HTTP cases). Typecheck and affected-file ESLint pass (/tmp/qm-private-fire-history-final-types.log and /tmp/qm-private-fire-history-final-lint.log).

## Disposable computer implementation

Scratch keeps the existing provider creation/destruction path and remains disposable. Its per-turn cache and provider key distinguish ordinary and private computers. A late private read obtains a new private scratch computer and destroys both at cleanup; an outstanding ordinary provision is rechecked before return. The contextual router authorizes scratch provisioning and every command/file/process/blob operation from current durable session privacy and scope membership. Old ordinary handles stop working after a private transition. Trusted lifecycle cleanup uses its base router and remains able to destroy old handles.

SandboxResources adds authorizeScratch(scopeId:ScopeId,personalOnly:boolean):Promise<void>; it had no such method before. TurnSandboxContext.computerEnv now receives a ComputerCapability binding rather than an entire SandboxResource; native production credentials are minted from that binding. The previous committed interface had no computerEnv callback. This is internal wiring, not a user setting or provider choice. Scratch has no resourceId; its privacy comes from the current conversation, while registered computers use their canonical resource flag/ID. Neither computer receives the native host token.

The only production scratch option producer is createTurnSandboxes. Its unique turn key now ends in :ordinary or :private. Existing fields/semantics remain; no SQL, persistent resource JSON, API endpoint or environment setting changes. The full affected provider/handle shapes follow.

### SandboxHandle: Before

```typescript
export interface SandboxHandle {
  resourceId?: string;
  providerSandboxId?: string;
  id: string;
  rootDir: string;
  homeDir?: string;
  coldStart?: boolean;
  env?: Record<string, string>;
  scratch?: boolean;
  backend?: string;
  scopeId?: string;
}
```

### SandboxHandle: Local implementation

```typescript
export interface SandboxHandle {
  resourceId?: string;
  providerSandboxId?: string;
  id: string;
  rootDir: string;
  homeDir?: string;
  coldStart?: boolean;
  env?: Record<string, string>;
  scratch?: boolean;
  personalOnly?: true;
  backend?: string;
  scopeId?: string;
}
```

### ProvisionOptions: Before

```typescript
export interface ProvisionOptions {
  sandboxId?: string;
  env?: Record<string, string>;
  egress?: EgressPolicy;
  egressToken?: string;
  scratch?: { key: string };
  onStatus?: (text: string) => void;
  memoryGb?: number;
}
```

### ProvisionOptions: Local implementation

```typescript
export interface ProvisionOptions {
  sandboxId?: string;
  env?: Record<string, string>;
  egress?: EgressPolicy;
  egressToken?: string;
  scratch?: { key: string; personalOnly?: true };
  onStatus?: (text: string) => void;
  memoryGb?: number;
}
```

Invented before/after options: {scratch:{key:"turn:chat:run"}} becomes {scratch:{key:"turn:chat:run:ordinary"}} for ordinary work or {scratch:{key:"turn:chat:run:private",personalOnly:true}} for private work. A previous scratch handle {id:"provider-id",rootDir:"/workspace",scratch:true,scopeId:"personal:alice"} retains those fields and adds personalOnly:true only for private work. These ephemeral handle/options fields are not a migration or a persisted authorization registry.

Provider audit: local uses ensureScratch rather than ensureContainer; AWS launches a fresh body without a scope/hydration key; Sprites exec-base calls createScratch; smolmachines, E2B, Modal, superserve, Porter, Agent37 and managed-agents select their separate scratch creation branches; Render uses its scratch store/body. Persistent home hydration remains in resident-scope creation, not scratch creation. No provider implementation changed. Native provider canary qualification is still required.

Scratch routing/open/pool batch passes3/3 files. Resource and tenant batch passes both tenant files and all new privacy cases; resource suite remains56/58 with the same two baseline Linux-/proc-dependent load-probe failures. Typecheck passes. Logs: /tmp/qm-private-scratch-routing.log, /tmp/qm-private-scratch-resources.log, /tmp/qm-private-scratch-types.log. Independent scratch review accepted94. The final affected batch passed routing and actual HTTP files; child-isolation initially failed on macOS /var versus /private/var aliases, then the full file passed with TMPDIR=/private/tmp. Logs: /tmp/qm-private-scratch-affected.log and /tmp/qm-private-scratch-child-canonical-temp.log. No source/test assertion was changed to hide that platform condition. Changed-file ESLint passes.

## Historical personal-computer cutover

upgradePrivateSandboxDefaults runs after legacy import and before SandboxResources initialization completes. It uses the existing per-tenant sandbox_resource_rollout map and an advisory lock. The new marker key private-defaults-v1 has the existing complete value shape {activatedAt:string}; its previous state was absent. The marker is written last. Partial completed updates are safe on retry, and new ordinary computers created after the marker are not reclassified.

Every historical personal-owned resource that lacks personalOnly gets personalOnly:true plus sourceProvenance merged with UNTRACKED_PROVENANCE and its existing owner scope. Prior sensitivity and sources are retained; sourceUnknown becomes true. Every other SandboxResource field shown above is retained exactly, including id, backend, backingScopeId, ownerScopeId, state, timestamps, holders, sizing and lifecycle metadata. Already-private resources retain their provenance. Shared-owned resources are not reclassified. No provider calls, file copies, snapshot operations or disk deletion occur in the cutover.

Every ordinary default pointer selecting a now-private resource is cleared. If that resource belongs to the same scope and privateSandboxId was absent, it moves into that private slot. Explicit private selection, including null, is preserved. A pointer from a different scope is cleared without assigning someone else's private default. All other default keys are retained. Ordinary work can create a new clean computer with an independent backing ID. Old backing/snapshot keys stay reachable only through the classified private resource; there is no ordinary fallback to its old personal home. Known shared QA machines containing prior private test data still require explicit inspection/quarantine before claiming that audit complete.

Invented before resource: {id:"old",backend:"local",ownerScopeId:"personal:alice",backingScopeId:"personal:alice",name:"Existing scoped computer",createdBy:"system",createdAt:"2026-01-01T00:00:00Z",legacy:true,state:"ready"}. After: the same complete row plus personalOnly:true,sourceProvenance:{sensitivity:"unknown",sources:["personal:alice"],sourceUnknown:true}. Before default {sandboxId:"old"} becomes {sandboxId:null,privateSandboxId:"old"}. The same pointer under a foreign scope becomes {sandboxId:null}. An existing explicit {sandboxId:"old",privateSandboxId:null} becomes {sandboxId:null,privateSandboxId:null}. The full resource/default interfaces above account for every field; no SQL table/column/index/constraint/enum is added.

The current watched isolated dev core applied marker private-defaults-v1 at2026-11-19T08:40:19.039Z; this was observed directly in its QA Postgres. /readyz returned200. No production instance was migrated. Rollout must drain old workers/producers before enabling this boundary; running this code beside workers that still expose native credentials is unsupported.

The migration regression exercises concurrent callers, retained disk bytes, unknown provenance, shared-owned resource preservation, default separation, marker idempotence and a clean ordinary computer created after cutover. /tmp/qm-private-computer-migration-tests.log passes the migration/new privacy cases and both other affected files (actual HTTP and trigger privacy); the resource file remains57/59 with the same two Linux-/proc load-probe failures. Independent migration review accepted94; it excludes production rollout authorization. Final typecheck/lint logs: /tmp/qm-private-computer-migration-final-types.log and /tmp/qm-private-computer-migration-final-lint.log.
