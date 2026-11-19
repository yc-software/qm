# Private trigger checkpoint: payload disclosure

Base: 5358438f4776. Implemented code; private trigger execution verified in the live development instance. No configuration, SQL table, key, index, constraint, enum or migration changes. Existing ordinary records remain ordinary; there is no historical private-trigger field to backfill. Deploy core/workers together before relying on these fields; older workers do not enforce them. New internal context fields are trusted in-process inputs and are rejected in public create/patch JSON. API resource responses include the persisted optional privacy fields; no existing field is removed.

Cron, webhook, monitor and loop JSON gain optional `personalOnly: true` and `sourceProvenance`. Existing fields are preserved. Creates and updates merge provenance and retain private status. Private records require owner-personal scope and owner-only delivery. Bound loops and cron rows both retain the same privacy. Identity-based deduplication includes canonical privacy metadata so ordinary and private jobs cannot collapse together. `TurnRequest.contextProvenance` is an internal queued-turn field, copied into the session before model execution. The creation-only `context` object is not stored on trigger records.

Invented representative cron JSON before: `{"id":"example","owner":"alice","createdBy":"alice","ownerScopeId":"personal:alice","enabled":true,"createdAt":1,"schedule":{"everyMs":3600000},"action":"Make a report","destination":{"type":"principal","target":"alice"}}`. After: all those fields, plus `"personalOnly":true,"sourceProvenance":{"sensitivity":"restricted","sources":["personal:alice"],"sourceUnknown":true}`. Ordinary rows are unchanged.

## src/triggers/types.ts

### Before

```typescript
export interface TriggerBase {
  id: string;
  ownerScopeId: ScopeId;
  owner: string;
  createdBy: string;
  ownerConsentedAt?: number;
  botActor?: boolean;
  taskAuthor?: "automation";
  destination?: Destination;
  enabled: boolean;
  createdAt: number;
  lastFiredAt?: number;
}

export interface CronSchedule {
  cron?: string;
  timezone?: string;
  everyMs?: number;
  firstFireAt?: number;
}

export interface CronFireLogEntry {
  fireKey: string;
  threadRef: string;
  firedAt: number;
  scheduledAt?: number;
  status?: TurnResult["status"] | "running";
  endedAt?: number;
  note?: string;
  reply?: string;
  sessionId?: string;
}

export interface CronScript {
  command: string;
  credentials?: string[];
  sandboxId?: string;
}

export interface CronFireNote {
  text: string;
  at: number;
  by?: string;
}

export interface Cron extends TriggerBase {
  runtime?: RuntimeChoice | null;
  schedule: CronSchedule;
  nextFireAt?: number;
  lastAttemptAt?: number;
  deferUntil?: number;
  title?: string;
  archived?: boolean;
  action?: string;
  message?: string;
  loopId?: string;
  createdAt: number;
  sessionRef?: string;
  script?: CronScript;

  lastFireNote?: CronFireNote;
}

interface WebhookVerification {
  scheme: "hmac-sha256" | "github" | "slack" | "stripe" | "linear" | "token" | "standard-webhooks";
  secret?: string;
}

interface WebhookFilter {
  path: string;
  in: string[];
}

export interface Webhook extends TriggerBase {
  action: string;
  verification: WebhookVerification;
  filters?: WebhookFilter[];
  lastDeliveryId?: string;
  lastError?: string;
}

export interface Monitor extends TriggerBase {
  processId: string;
  command: string;
  purpose?: string;
  threadRef: string;
  instructions?: string;
  pattern?: string;
  cursor: number;
  tail?: string;
  expiresAt: number;
  lastError?: string;
}
```

### After

```typescript
export interface TriggerBase {
  personalOnly?: true;
  sourceProvenance?: import("../memory/facts.ts").SourceProvenance;
  id: string;
  ownerScopeId: ScopeId;
  owner: string;
  createdBy: string;
  ownerConsentedAt?: number;
  botActor?: boolean;
  taskAuthor?: "automation";
  destination?: Destination;
  enabled: boolean;
  createdAt: number;
  lastFiredAt?: number;
}

export interface CronSchedule {
  cron?: string;
  timezone?: string;
  everyMs?: number;
  firstFireAt?: number;
}

export interface CronFireLogEntry {
  fireKey: string;
  threadRef: string;
  firedAt: number;
  scheduledAt?: number;
  status?: TurnResult["status"] | "running";
  endedAt?: number;
  note?: string;
  reply?: string;
  sessionId?: string;
}

export interface CronScript {
  command: string;
  credentials?: string[];
  sandboxId?: string;
}

export interface CronFireNote {
  text: string;
  at: number;
  by?: string;
}

export interface Cron extends TriggerBase {
  runtime?: RuntimeChoice | null;
  schedule: CronSchedule;
  nextFireAt?: number;
  lastAttemptAt?: number;
  deferUntil?: number;
  title?: string;
  archived?: boolean;
  action?: string;
  message?: string;
  loopId?: string;
  createdAt: number;
  sessionRef?: string;
  script?: CronScript;

  lastFireNote?: CronFireNote;
}

interface WebhookVerification {
  scheme: "hmac-sha256" | "github" | "slack" | "stripe" | "linear" | "token" | "standard-webhooks";
  secret?: string;
}

interface WebhookFilter {
  path: string;
  in: string[];
}

export interface Webhook extends TriggerBase {
  action: string;
  verification: WebhookVerification;
  filters?: WebhookFilter[];
  lastDeliveryId?: string;
  lastError?: string;
}

export interface Monitor extends TriggerBase {
  processId: string;
  command: string;
  purpose?: string;
  threadRef: string;
  instructions?: string;
  pattern?: string;
  cursor: number;
  tail?: string;
  expiresAt: number;
  lastError?: string;
}
```

## src/triggers/trigger-store.ts

### Before

```typescript
export interface CreateTriggerInput {
  ownerScopeId: ScopeId;
  owner: string;
  createdBy: string;
  destination?: Destination;
  ownerConsentedAt?: number;
  botActor?: boolean;
  taskAuthor?: "automation";
}
```

### After

```typescript
export interface CreateTriggerInput {
  personalOnly?: true;
  sourceProvenance?: SourceProvenance;
  context?: import("../sessions/private-context.ts").PrivateContext;
  ownerScopeId: ScopeId;
  owner: string;
  createdBy: string;
  destination?: Destination;
  ownerConsentedAt?: number;
  botActor?: boolean;
  taskAuthor?: "automation";
}
```

## src/cron/cron-store.ts

### Before

```typescript
export interface CreateCronInput extends CreateTriggerInput {
  runtime?: Cron["runtime"];
  enabled?: boolean;
  schedule: Cron["schedule"];
  title?: string;
  action?: string;
  message?: string;
  loopId?: string;
  sessionRef?: string;
  script?: CronScript;
}

export interface CronPatch {
  runtime?: Cron["runtime"];
  title?: string;
  action?: string;
  message?: string;
  schedule?: CronSchedule;
  enabled?: boolean;
  archived?: boolean;
  destination?: Destination;
  owner?: string;
  taskAuthor?: "automation" | null;
  sessionRef?: string | null;
  script?: CronScript | null;
}
```

### After

```typescript
export interface CreateCronInput extends CreateTriggerInput {
  runtime?: Cron["runtime"];
  enabled?: boolean;
  schedule: Cron["schedule"];
  title?: string;
  action?: string;
  message?: string;
  loopId?: string;
  sessionRef?: string;
  script?: CronScript;
}

export interface CronPatch {
  personalOnly?: true;
  sourceProvenance?: import("../memory/facts.ts").SourceProvenance;
  runtime?: Cron["runtime"];
  title?: string;
  action?: string;
  message?: string;
  schedule?: CronSchedule;
  enabled?: boolean;
  archived?: boolean;
  destination?: Destination;
  owner?: string;
  taskAuthor?: "automation" | null;
  sessionRef?: string | null;
  script?: CronScript | null;
}
```

## src/loops/loop-store.ts

### Before

```typescript
export interface LoopPatch {
  name?: string;
  icon?: string | null;
  purpose?: string;
  successCondition?: string;
  successChecks?: string[];
  destination?: Destination | null;
  shipActions?: ShipActionPolicy[];
  caps?: LoopCaps;
  governor?: LoopGovernorConfig;
  triage?: LoopTriageConfig;
  cronId?: string;
  state?: LoopState;
  playbookEdit?: PlaybookEdit;
  taskAuthor?: "automation" | null;
  restore?: Loop;
  quarantineClearedBy?: string;
  quarantineClearedAt?: number;
}
```

### After

```typescript
export interface LoopPatch {
  personalOnly?: true;
  sourceProvenance?: Loop["sourceProvenance"];
  name?: string;
  icon?: string | null;
  purpose?: string;
  successCondition?: string;
  successChecks?: string[];
  destination?: Destination | null;
  shipActions?: ShipActionPolicy[];
  caps?: LoopCaps;
  governor?: LoopGovernorConfig;
  triage?: LoopTriageConfig;
  cronId?: string;
  state?: LoopState;
  playbookEdit?: PlaybookEdit;
  taskAuthor?: "automation" | null;
  restore?: Loop;
  quarantineClearedBy?: string;
  quarantineClearedAt?: number;
}
```

## src/memory/facts.ts

### Before

```typescript
export interface MemoryProvenance {
  sensitivity: MemorySensitivity;
  sources: ScopeId[];
  sourceUnknown: boolean;
  personalOnly?: true;
}

export type SourceProvenance = Pick<MemoryProvenance, "sensitivity" | "sources" | "sourceUnknown">;
```

### After

```typescript
export interface MemoryProvenance {
  sensitivity: MemorySensitivity;
  sources: ScopeId[];
  sourceUnknown: boolean;
  personalOnly?: true;
}

export type SourceProvenance = Pick<MemoryProvenance, "sensitivity" | "sources" | "sourceUnknown">;
```

## src/sessions/private-context.ts

### Before

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

### After

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

## src/types.ts

### Before

```typescript
export interface TurnRequest {
  desktopClientId?: string;
  clientSurface?: ClientSurface;
  midTurn?: "steer" | "queue";
  surfaceOrigin?: TurnSurfaceOrigin;
  sessionSenderId?: string;
  delegatingRunId?: string;
  privateSessionMessage?: true;
  sessionMessageDepth?: number;
  surface: string;
  scopeVersion?: string;
  deliveryTarget?: string;
  deliveryWebhook?: DeliveryWebhook;
  deliveryCandidates?: { target: string; label: string }[];
  actor: ActorAssertion;
  conversation: {
    kind: ConversationKind;
    threadRef: string;
    channelRef?: string;
    channelName?: string;
    audience?: ActorAssertion[];
    isPrivate?: boolean;
    isMpim?: boolean;
    publishMembers?: ActorAssertion[];
  };
  text: string;
  origin?: TurnOrigin;
  gatewayContext?: GatewayContext;
  cronScript?: import("./triggers/types.ts").CronScript;
  infrequentCron?: boolean;
  personaId?: string;
  botActor?: boolean;
  conversationHeader?: string;
  priorTurns?: ConversationTurn[];
  overheard?: OverheardMessage[];
  detectContext?: string;
  detectOpener?: string;
  attachments?: IncomingAttachment[];
  inboundNotes?: string[];
  model?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
  readOnly?: boolean;
  skipMemory?: boolean;
  memoryNotebookOnly?: boolean;
  surfaceTools?: boolean;
  addressed?: boolean;
  liveReplies?: boolean;
  envelopeWrapped?: boolean;
  displayText?: string;
  turnWallClockMs?: number;
  timezone?: string;
  approval?: { requestId: string; approved: boolean; scope?: ApprovalScope };
  proactiveOpener?: boolean;
  spawned?: boolean;
  idempotencyKey?: string;
  redeliveryKey?: string;
  async?: boolean;
  clientTools?: ClientToolDeclaration[];
  surfaceBriefing?: SurfaceBriefing;
}
```

### After

```typescript
export interface TurnRequest {
  contextProvenance?: import("./memory/facts.ts").MemoryProvenance;
  desktopClientId?: string;
  clientSurface?: ClientSurface;
  midTurn?: "steer" | "queue";
  surfaceOrigin?: TurnSurfaceOrigin;
  sessionSenderId?: string;
  delegatingRunId?: string;
  privateSessionMessage?: true;
  sessionMessageDepth?: number;
  surface: string;
  scopeVersion?: string;
  deliveryTarget?: string;
  deliveryWebhook?: DeliveryWebhook;
  deliveryCandidates?: { target: string; label: string }[];
  actor: ActorAssertion;
  conversation: {
    kind: ConversationKind;
    threadRef: string;
    channelRef?: string;
    channelName?: string;
    audience?: ActorAssertion[];
    isPrivate?: boolean;
    isMpim?: boolean;
    publishMembers?: ActorAssertion[];
  };
  text: string;
  origin?: TurnOrigin;
  gatewayContext?: GatewayContext;
  cronScript?: import("./triggers/types.ts").CronScript;
  infrequentCron?: boolean;
  personaId?: string;
  botActor?: boolean;
  conversationHeader?: string;
  priorTurns?: ConversationTurn[];
  overheard?: OverheardMessage[];
  detectContext?: string;
  detectOpener?: string;
  attachments?: IncomingAttachment[];
  inboundNotes?: string[];
  model?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
  readOnly?: boolean;
  skipMemory?: boolean;
  memoryNotebookOnly?: boolean;
  surfaceTools?: boolean;
  addressed?: boolean;
  liveReplies?: boolean;
  envelopeWrapped?: boolean;
  displayText?: string;
  turnWallClockMs?: number;
  timezone?: string;
  approval?: { requestId: string; approved: boolean; scope?: ApprovalScope };
  proactiveOpener?: boolean;
  spawned?: boolean;
  idempotencyKey?: string;
  redeliveryKey?: string;
  async?: boolean;
  clientTools?: ClientToolDeclaration[];
  surfaceBriefing?: SurfaceBriefing;
}
```

## Validation and limits

Affected 16-file batch passed; final loop boundary batch 3/3 passed, including 11 private-trigger cases. The same new test file against base 5358438 fails through the real paths. Typecheck, ESLint and formatting pass. Native Excel created one private schedule, manually fired it successfully, and disabled it; SQL verified private owner scope, equal source provenance on its execution session, no tool calls in the fired turn and exactly one owner-only output in the outbox. The development instance has no delivery plugin, so delivery remains queued. Independent checkpoint review: private_outputs_plan_review, Accept 93/100. Explicit release and managed-computer isolation are separate outstanding work; this is not a full-head Wall review.
