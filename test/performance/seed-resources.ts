import type pg from "pg";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { createDeployStore } from "../../src/deploy/deploy-store.ts";
import { createPostgresChannelPolicyStore } from "../../src/surface-cache/channel-policy-store.ts";
import { createPostgresTaskStore } from "../../src/tasks/postgres-task-store.ts";
import { createPostgresFileUploadStore, type FileUpload } from "../../src/files/file-upload-store.ts";
import { createPostgresEnvironmentStore } from "../../src/environments/environment-store.ts";
import { defaultOrgPolicy } from "../../src/policy/command-policy.ts";
import type {
  PersistedCommandPolicy,
  PersistedSecurityPosture,
  PersistedSharingPosture,
  PersistedScopedFlag,
  PersistedSlackEmojiCatalog,
} from "../../src/resolution/config-store.ts";
import { FEATURE_NAMES } from "../../src/feature-flags.ts";
import type { ScopeLivenessRecord } from "../../src/credentials/resident-auth.ts";
import type { McpServer } from "../../src/mcp/mcp-server-store.ts";
import type { SuggestedActivityProfile } from "../../src/suggestions/activities.ts";
import type { WebhookHistory } from "../../src/webhooks/webhook-store.ts";
import type { CommandApprovalGrant, LoopOutput, Webhook } from "../../src/types.ts";
import type { SessionShare } from "../../src/sessions/session-share.ts";
import type { SwarmStorage } from "../../src/swarms/swarm-store.ts";
import { SWARM_DEFAULTS } from "../../src/swarms/swarm-settings.ts";
import type { SandboxResource, SandboxDefault, SandboxResourceRollout } from "../../src/sandbox/sandbox-resources.ts";
import type { SandboxRoute } from "../../src/sandbox/sandbox-routing.ts";
import type { DeactivationRecord } from "../../src/identity/identity-service.ts";
import { principalId, syntheticId, type SeedPlan } from "./seed.ts";

export const RESOURCE_MAPS: Record<string, string[]> = {
  command_policies: [],
  security_postures: [],
  sharing_postures: [],
  interactive_fast_mode_flag: [],
  individual_model_auth_flag: [],
  credential_liveness: [],
  feature_flags: [],
  mcp_servers: [],
  suggested_activity_profiles: [],
  webhooks: [],
  webhook_history: [],
  loop_outputs: ["itemId"],
  approval_grants: [],
  session_shares: [],
  swarms: ["pending"],
  sandbox_routing: [],
  sandbox_defaults: [],
  sandbox_resources: [],
  sandbox_resource_rollout: [],
  deactivated_principals: [],
  slack_emoji_catalog: [],
};

export function registerResourceSchemas(url: string): void {
  createPostgresChannelPolicyStore(url);
  createPostgresTaskStore(url);
  createPostgresFileUploadStore(url);
  createPostgresEnvironmentStore(url);
  createDeployStore({ pg: createPgPool(url) });
}

export function resourceRows(plan: SeedPlan): Array<{ table: string; id: string; json: unknown }> {
  const rows: Array<{ table: string; id: string; json: unknown }> = [];
  const admin = plan.cohorts.max!.principalId;
  const principals = [admin, ...plan.principals.map((p) => p.principalId).filter((id) => id !== admin)];
  const scopes = ["org:perf", ...plan.scopes];
  const browserCases = Object.values(plan.cases);
  for (const table of Object.keys(RESOURCE_MAPS)) {
    for (let i = 1; i <= (plan.targets[table] ?? 0); i++) {
      const owner = principals[(i - 1) % principals.length]!;
      const scope = scopes[(i - 1) % scopes.length]!;
      const fixtureCase = browserCases[(i - 1) % browserCases.length]!;
      const at = plan.anchorTime - i * 1000;
      let id = syntheticId(table, i);
      let json: unknown;
      if (table === "command_policies") {
        id = scope;
        json = { scopeId: scope, policy: defaultOrgPolicy() } satisfies PersistedCommandPolicy;
      } else if (table === "security_postures") {
        id = scope;
        json = { scopeId: scope, posture: "auto" } satisfies PersistedSecurityPosture;
      } else if (table === "sharing_postures") {
        id = scope;
        json = { scopeId: scope, posture: "isolated" } satisfies PersistedSharingPosture;
      } else if (table === "interactive_fast_mode_flag" || table === "individual_model_auth_flag") {
        id = scope;
        json = { scopeId: scope, on: false } satisfies PersistedScopedFlag;
      } else if (table === "credential_liveness") {
        id = scope;
        json = {
          scopeId: scope,
          checkedAt: at,
          connectors: { gh: "absent", glab: "absent", gcloud: "absent" },
        } satisfies ScopeLivenessRecord;
      } else if (table === "feature_flags") {
        const measured = plan.aggregates.feature_flag_names;
        const name = measured ? String(measured[i - 1]?.name ?? "") : FEATURE_NAMES[i - 1];
        if (!name)
          throw new Error("Measured feature flags include unsupported names; supply reviewed active/retired counts");
        if (measured && Number(measured[i - 1]?.rows) !== 1)
          throw new Error("Feature flag names must be unique singleton rows");
        const enabled = plan.aggregates.feature_flag_scope_counts?.find((row) => row.name === name);
        const personal = Number(enabled?.personal_scopes ?? 0);
        const org = Number(enabled?.org_scopes ?? 0);
        if (personal > principals.length || org > 1 || personal + org !== Number(enabled?.enabled_scopes ?? 0))
          throw new Error("Unsupported feature scope population");
        id = name;
        json = {
          featureName: name,
          enabledScopes: [...(org ? ["org:perf"] : []), ...principals.slice(0, personal).map((id) => `personal:${id}`)],
          updatedAt: at,
          updatedBy: admin,
        };
      } else if (table === "mcp_servers") {
        id = `perf-mcp-${i}`;
        json = {
          id,
          name: `QM performance MCP ${i}`,
          url: "https://fixture.example.invalid/mcp",
          auth: "none",
          enabled: false,
          readOnly: true,
          updatedAt: at,
          updatedBy: admin,
        } satisfies McpServer;
      } else if (table === "suggested_activity_profiles") {
        id = owner;
        json = {
          timezone: "UTC",
          lastSeenAt: at,
          autoPaused: true,
          seeds: [
            {
              id: "perf-review",
              title: "Review the performance fixture",
              prompt: "Review synthetic performance measurements.",
              icon: "🔎",
            },
          ],
        } satisfies SuggestedActivityProfile;
      } else if (table === "webhooks") {
        json = {
          id,
          owner,
          ownerScopeId: scope,
          createdBy: owner,
          createdAt: at,
          enabled: false,
          action: "QM performance inactive webhook",
          verification: { scheme: "hmac-sha256", secret: "synthetic-fixture-only" },
        } satisfies Webhook;
      } else if (table === "webhook_history") {
        if (!plan.targets.webhooks) throw new Error("Webhook history requires webhook rows");
        id = syntheticId("webhooks", 1 + ((i - 1) % plan.targets.webhooks));
        json = {
          events: [{ deliveryId: `perf-delivery-${i}`, receivedAt: at, payload: "QM performance webhook event" }],
        } satisfies WebhookHistory;
      } else if (table === "loop_outputs") {
        if (!plan.targets.loop_items || !plan.targets.loops) throw new Error("Loop output relationships are missing");
        const item = 1 + ((i - 1) % plan.targets.loop_items);
        json = {
          id,
          loopId: syntheticId("loops", 1 + ((item - 1) % plan.targets.loops)),
          itemId: syntheticId("loop_items", item),
          attemptId: `perf-attempt-${i}`,
          shipAction: "fixture",
          title: "QM performance expired output",
          state: "expired",
          capturedBy: "ledger",
          createdAt: at,
          updatedAt: at,
        } satisfies LoopOutput;
      } else if (table === "approval_grants") {
        json = {
          actorId: fixtureCase.principalId,
          command: `printf QM_fixture_${i}`,
          scope: "session",
          sessionId: fixtureCase.sessionId,
          createdAt: at,
        } satisfies CommandApprovalGrant;
      } else if (table === "session_shares") {
        id = `perf-share-${i}`;
        json = {
          token: id,
          sessionId: fixtureCase.sessionId,
          audience: "internal",
          createdBy: fixtureCase.principalId,
          createdAt: at,
          visibility: { minSeq: 0, maxSeq: 0, minCreatedAt: at, maxCreatedAt: at },
          messages: [{ role: "user", text: "QM performance shared message" }],
          files: [],
        } satisfies SessionShare;
      } else if (table === "swarms") {
        const actor = { id: owner, type: "internal" as const };
        json = {
          id,
          scopeId: scope,
          ownerId: owner,
          participants: [owner],
          createdAt: at - 1000,
          expiresAt: at,
          template: {
            text: "QM performance inactive swarm",
            actor,
            conversation: { kind: "dm", threadRef: fixtureCase.threadRef, audience: [actor] },
            origin: { kind: "human" },
          },
          settings: { ...SWARM_DEFAULTS },
          backend: "local",
          members: [],
          messages: [],
          spawnRequests: {},
          messageRequests: {},
          notificationCount: 0,
          pending: false,
        } satisfies SwarmStorage;
      } else if (table === "sandbox_routing") {
        id = scope;
        json = { backend: "local", reason: "QM performance isolated fixture" } satisfies SandboxRoute;
      } else if (table === "sandbox_defaults") {
        id = scope;
        json = { sandboxId: null } satisfies SandboxDefault;
      } else if (table === "sandbox_resources") {
        json = {
          id,
          backend: "local",
          ownerScopeId: scope,
          backingScopeId: scope,
          name: `QM performance inactive computer ${i}`,
          createdBy: owner,
          createdAt: new Date(at).toISOString(),
          legacy: false,
          state: "failed",
          error: "Synthetic inactive fixture",
          availableActions: [],
          cleanupPending: false,
        } satisfies SandboxResource;
      } else if (table === "sandbox_resource_rollout") {
        id = "explicit-defaults";
        json = { activatedAt: new Date(at).toISOString() } satisfies SandboxResourceRollout;
      } else if (table === "deactivated_principals") {
        id = principalId(plan.principals.length + i);
        json = { principalId: id, source: "manual", at } satisfies DeactivationRecord;
      } else if (table === "slack_emoji_catalog") {
        id = scope;
        json = {
          scopeId: scope,
          emoji: { qm_performance: "alias:white_check_mark" },
          updatedAt: at,
        } satisfies PersistedSlackEmojiCatalog;
      }
      if (json === undefined) throw new Error(`Missing resource fixture shape: ${table}`);
      rows.push({ table, id, json });
    }
  }
  return rows;
}

export async function seedResourceRelations(client: pg.Client, plan: SeedPlan): Promise<void> {
  const at = plan.anchorTime;
  const owner = plan.cohorts.max!.principalId;
  const session = plan.sessions.find((s) => s.id === plan.cases.long!.sessionId)!;
  for (let i = 1; i <= (plan.targets.channel_policy ?? 0); i++)
    await client.query(
      "INSERT INTO channel_policy(org_id,container,orders,bots,ambient_enabled,set_by,updated_at) VALUES('perf',$1,$2,'{}',false,$3,$4)",
      [`perf-${i}`, "QM performance disabled ambient policy", owner, at - i],
    );
  for (let i = 1; i <= (plan.targets.channel_policy_history ?? 0); i++)
    await client.query(
      "INSERT INTO channel_policy_history(org_id,container,orders,bots,ambient_enabled,set_by,session_id,created_at) VALUES('perf',$1,$2,'{}',false,$3,$4,$5)",
      [
        `perf-${1 + ((i - 1) % Math.max(1, plan.targets.channel_policy ?? 0))}`,
        "QM performance policy revision",
        owner,
        session.id,
        at - i,
      ],
    );
  for (let i = 1; i <= (plan.targets.deployment_access ?? 0); i++) {
    if (i > (plan.targets.deployments ?? 0)) throw new Error("Deployment access rows exceed deployments");
    await client.query("INSERT INTO deployment_access(id,last_access_at) VALUES($1,$2)", [
      syntheticId("deployments", i),
      at - i,
    ]);
  }
  for (let i = 1; i <= (plan.targets.tasks ?? 0); i++)
    await client.query(
      "INSERT INTO tasks(id,session_id,origin_run_id,title,status,created_at,updated_at) VALUES($1,$2,$3,$4,'completed',$5,$6)",
      [
        syntheticId("task", i),
        session.id,
        syntheticId("run", session.n),
        `QM performance completed task ${i}`,
        at - 2000,
        at - 1000,
      ],
    );
  for (let i = 1; i <= (plan.targets.task_events ?? 0); i++) {
    if (!plan.targets.tasks) throw new Error("Task events require tasks");
    const created = i <= plan.targets.tasks;
    const completes = !created || i + plan.targets.tasks > (plan.targets.task_events ?? 0);
    await client.query(
      "INSERT INTO task_events(task_id,run_id,type,from_status,to_status,created_at) VALUES($1,$2,$3,$4,$5,$6)",
      [
        syntheticId("task", 1 + ((i - 1) % plan.targets.tasks)),
        syntheticId("run", session.n),
        created ? "created" : "status_changed",
        created ? null : "pending",
        completes ? "completed" : "pending",
        at - (created ? 2000 : 1000),
      ],
    );
  }
  for (let i = 1; i <= (plan.targets.file_uploads ?? 0); i++) {
    const upload = {
      id: syntheticId("upload", i),
      actorId: owner,
      scopeId: session.scope,
      name: `QM performance upload ${i}.txt`,
      mimetype: "text/plain",
      sizeBytes: 1024,
      partSize: 1024,
      checksums: [],
      uploadId: `perf-upload-${i}`,
      state: "complete",
      expiresAt: at,
      createdAt: at - i,
    } satisfies FileUpload;
    await client.query(
      "INSERT INTO file_uploads(id,actor_id,state,size_bytes,expires_at,data) VALUES($1,$2,$3,$4,$5,$6)",
      [upload.id, upload.actorId, upload.state, upload.sizeBytes, upload.expiresAt, JSON.stringify(upload)],
    );
  }
  for (let i = 1; i <= (plan.targets.environments ?? 0); i++)
    await client.query(
      "INSERT INTO environments(id,org_id,name,owner_actor_id,created_at,updated_at) VALUES($1,'perf',$2,$3,$4,$4)",
      [syntheticId("environment", i), `QM performance environment ${i}`, owner, at - i],
    );
  await client.query(
    "UPDATE loop_items i SET json=jsonb_set(i.json,'{outputIds}',o.ids) FROM (SELECT json->>'itemId' AS item_id,jsonb_agg(id ORDER BY id) AS ids FROM loop_outputs GROUP BY json->>'itemId') o WHERE i.id=o.item_id",
  );
}
