import type { CronsModule } from "./crons.ts";
import type { CredentialsModule } from "./credentials.ts";
import type { ApiAppModule } from "./api-app.ts";
import type { StoresModule } from "./stores.ts";
import type { DeploymentLayerModule } from "./deployment-layer.ts";
import type { OutboundModule } from "./outbound.ts";
import type { MemoryModule } from "./memory.ts";
import type { OrchestratorModule } from "./orchestrator.ts";
import type { RunsModule } from "./runs.ts";
import type { HarnessModule } from "./harness.ts";
import type { FilesModule } from "./files.ts";
import type { Head } from "./late.ts";
import { createStagedEnvelopes } from "../slack/envelope-staging.ts";
import { createSessionStatusStore } from "../slack/session-status.ts";
import { createTaskAckStore } from "../slack/task-ack.ts";
import { createHandledEvents } from "../slack/message-gating.ts";
import { createInboxRealtime } from "../inbox/realtime.ts";
import { createKeychainApprovals } from "../credentials/keychain-approval.ts";
import { createSlackCoreClient } from "../api/slack-core-client.ts";
import { auxiliaryModelForProvider } from "../model/pi-models.ts";
import { tenantConfig } from "../tenants/tenant-config.ts";

type SlackCoreInputs = Pick<Head, "config"> & {
  crons: CronsModule;
  credentials: CredentialsModule;
  apiApp: ApiAppModule;
  stores: StoresModule;
  deploymentLayer: DeploymentLayerModule;
  outbound: OutboundModule;
  memory: MemoryModule;
  orchestrator: OrchestratorModule;
  runs: RunsModule;
  harness: HarnessModule;
  files: FilesModule;
};

export function buildSlackCore(deps: SlackCoreInputs) {
  const { crons, inboxItems, recordInboxEvent, monitors } = deps.crons;
  const { keychain } = deps.credentials;
  const { app, askResolution } = deps.apiApp;
  const { identity, sessions, featureFlags, leaderLease, configStore, databaseUrl, every } = deps.stores;
  const { auditLog } = deps.deploymentLayer;
  const { outbound, slackSurface } = deps.outbound;
  const { memory } = deps.memory;
  const { surfaceCache, ackEmojiPicks } = deps.orchestrator;
  const { processes, runs, turnStream } = deps.runs;
  const { config } = deps;
  const { fallback, harness } = deps.harness;
  const { blobTransfer, errors } = deps.files;

  const inboxRealtime = createInboxRealtime({
    crons,
    items: inboxItems,
    record: recordInboxEvent,
  });
  const keychainApprovals = createKeychainApprovals({
    keychain,
    app,
    identity,
    sessions,
    audit: auditLog,
    outbound,
    resume: (ask, grant) => askResolution(ask, grant),
  });
  const slackHandledEvents = createHandledEvents(databaseUrl);
  const slackCore = createSlackCoreClient({
    identity,
    memory,
    ...(keychainApprovals ? { keychainApprovals } : {}),
    surfaceCache,
    taskAcknowledgements: createTaskAckStore(databaseUrl),
    sessionStatus: createSessionStatusStore(databaseUrl),
    statusActivity: { processes, monitors, sessions, publicWebUrl: () => tenantConfig(config).publicWebUrl },
    featureFlags,
    inboxEvent: (event) => inboxRealtime.onConversationEvent(event),
    app,
    leaderLease,
    stagedEnvelopes: createStagedEnvelopes(databaseUrl),
    handledEvents: slackHandledEvents,
    config: configStore,
    runtimeFallback: fallback,
    blobTransfer,
    slack: slackSurface.slack,
    errors,
    runs,
    turnStream,
    ackPicks: ackEmojiPicks,
    ackModelId: () => auxiliaryModelForProvider("anthropic"),
    brandingDefault: () => tenantConfig(config).brandingDefault,
    ...(harness.models.pickAckEmoji ? { pickAckEmoji: (t, c) => harness.models.pickAckEmoji!(t, c) } : {}),
  });
  every("slack:envelope-replay", 60_000, () => slackCore.upkeep.run("replayEnvelopes"));
  every("slack:session-status", 60_000, () => slackCore.upkeep.run("reconcileStatus"));
  every("slack:task-acks", 60_000, () => slackCore.upkeep.run("reconcileTaskAcks"));
  every("slack:emoji-catalog", 6 * 60 * 60_000, () => slackCore.upkeep.run("publishEmojiCatalog"));
  const handledEventCutoff = () => Date.now() - 24 * 60 * 60_000;
  every("slack:handled-events", 60 * 60_000, () => slackHandledEvents.deleteBefore(handledEventCutoff()));
  return { slackCore, keychainApprovals };
}

export type SlackCoreModule = ReturnType<typeof buildSlackCore>;
