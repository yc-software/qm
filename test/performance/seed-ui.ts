import type { KeychainCredential, KeychainGrant, KeychainAsk } from "../../src/credentials/keychain.ts";
import type { ConnectorStatusRecord } from "../../src/credentials/connector-status.ts";
import type { Project } from "../../src/projects/project-store.ts";
import type { Deployment } from "../../src/deploy/deploy-store.ts";
import type { StoredModelOverlay } from "../../src/model/model-overlay-store.ts";
import type { PersistedBaseModel, PersistedSoul, PersistedWebuiModels } from "../../src/resolution/config-store.ts";
import type { PersistedUiState } from "../../src/surfaces/ui-state.ts";
import type { Skill } from "../../src/skills/skill-store.ts";
import type { Cron, Loop, LoopItem, Monitor, PendingApprovalRecord } from "../../src/types.ts";
import { deriveConnectorKey, encryptSecret } from "../../src/connectors/connector-client-store.ts";
import { fitCounts, payloadLengths, payloadText, quantileBounds, syntheticId, type SeedPlan } from "./seed.ts";

export const UI_MAPS: Record<string, string[]> = {
  keychain_credentials: ["ownerId"],
  keychain_grants: ["ownerId"],
  keychain_asks: [],
  deployments: [],
  projects: [],
  monitors: [],
  approvals: [],
  loops: [],
  loop_items: ["loopId"],
  base_model_configs: [],
  soul_configs: [],
  connector_status: [],
  model_registry: [],
  crons: [],
  skills: [],
  web_ui_state: [],
  webui_model_configs: [],
};

export function uiRows(plan: SeedPlan): Array<{ table: string; id: string; json: unknown }> {
  const rows: Array<{ table: string; id: string; json: unknown }> = [];
  const admin = plan.cohorts.max!.principalId;
  const principals = [admin, ...plan.principals.map((p) => p.principalId).filter((p) => p !== admin)];
  const scopes = ["org:perf", `personal:${admin}`, ...plan.scopes.filter((s) => s !== `personal:${admin}`)];
  const secretKey = deriveConnectorKey("QM performance synthetic fixture key", "keychain");
  const credentials: KeychainCredential[] = [];
  for (const table of Object.keys(UI_MAPS)) {
    const count = plan.targets[table] ?? 0;
    const measured =
      plan.aggregates.ui_payloads?.find((row) => row.table === table) ?? plan.aggregates[`ui_payload_${table}`]?.[0];
    const average = measured ? Number(measured.avg_payload_bytes ?? measured.avg_json_bytes) : undefined;
    const lengths = measured
      ? payloadLengths(
          {
            ...measured,
            payload_bytes: measured.payload_bytes ?? measured.json_bytes,
            max_payload_bytes: measured.max_payload_bytes ?? measured.max_json_bytes,
          },
          "payload_bytes",
          average,
        )
      : undefined;
    const fullLengths =
      measured && count && plan.scale === 1
        ? fitCounts(
            quantileBounds(
              count,
              (measured.payload_bytes ?? measured.json_bytes) as number[],
              Number(measured.max_payload_bytes ?? measured.max_json_bytes),
            ),
            Math.round(Number(average) * count),
          )
        : undefined;
    for (let i = 1; i <= count; i++) {
      const owner = principals[(i - 1) % principals.length]!;
      const scope = scopes[(i - 1) % scopes.length]!;
      const at = plan.anchorTime - i * 1000;
      let id = syntheticId(table, i);
      let json: unknown;
      const trigger = { id, owner, ownerScopeId: scope, createdBy: owner, enabled: false, createdAt: at };
      if (table === "keychain_credentials") {
        const credential = {
          id,
          ownerId: owner,
          orgId: "perf",
          service: `QM performance credential ${i}`,
          kind: "env",
          envKey: `QM_FIXTURE_${i}`,
          secretEnc: encryptSecret(`synthetic-${id}`, secretKey),
          fingerprint: `synthetic-${id}`,
          createdAt: at,
          updatedAt: at,
        } satisfies KeychainCredential;
        credentials.push(credential);
        json = credential;
      } else if (table === "keychain_grants") {
        const credential = credentials[(i - 1) % credentials.length];
        if (!credential) throw new Error("Credential grants require fixture credentials");
        json = {
          id,
          credentialId: credential.id,
          ownerId: credential.ownerId,
          orgId: "perf",
          audienceScopeId: scope,
          mode: "standing",
          purpose: "QM performance synthetic grant",
          status: "revoked",
          createdAt: at,
          revokedAt: at,
        } satisfies KeychainGrant;
      } else if (table === "keychain_asks") {
        const credential = credentials[(i - 1) % credentials.length];
        if (!credential) throw new Error("Credential asks require fixture credentials");
        json = {
          id,
          credentialId: credential.id,
          ownerId: credential.ownerId,
          requesterId: admin,
          orgId: "perf",
          requesterScopeId: `personal:${admin}`,
          purpose: "QM performance expired credential request",
          status: "expired",
          createdAt: at - 1000,
          expiresAt: at,
          resolvedAt: at,
        } satisfies KeychainAsk;
      } else if (table === "deployments") {
        json = {
          id,
          ownerScopeId: scope,
          createdBy: owner,
          name: `perf-deployment-${i}`,
          displayName: `QM performance deployment ${i}`,
          currentVersion: 1,
          status: "stopped",
          endpoint: null,
          versions: [
            {
              version: 1,
              createdAt: at,
              entrypoint: "fixture",
              snapshotDir: `/nonexistent-qm-performance-fixture/${id}`,
            },
          ],
        } satisfies Deployment;
      } else if (table === "projects") {
        id = syntheticId("project", i);
        json = {
          id,
          orgId: "perf",
          name: `QM performance project ${i}`,
          ownerId: owner,
          memberIds: [...new Set([owner, admin])],
          createdAt: at,
          updatedAt: at,
        } satisfies Project;
      } else if (table === "monitors") {
        json = {
          ...trigger,
          processId: syntheticId("process", i),
          command: "QM performance monitor",
          threadRef: plan.cases.short!.threadRef,
          cursor: 0,
          expiresAt: plan.anchorTime + 365 * 86_400_000,
        } satisfies Monitor;
      } else if (table === "approvals") {
        json = {
          sessionId: plan.sessions[(i - 1) % plan.sessions.length]!.thread,
          command: "QM performance pending approval",
          createdAt: at,
          reason: "Synthetic fixture",
          summary: `QM performance approval ${i}`,
          blocksInput: false,
          kind: "approval",
        } satisfies PendingApprovalRecord;
      } else if (table === "loops") {
        json = {
          ...trigger,
          ...(i <= 2
            ? {
                owner: admin,
                ownerScopeId: `personal:${admin}`,
                surface: `inbox:${i === 1 ? "slack" : "gmail"}`,
                sources: [i === 1 ? "slack" : "gmail"],
              }
            : {}),
          name: `QM performance loop ${i}`,
          playbook: "Synthetic fixture",
          playbookVersion: 1,
          playbookHistory: [],
          policyVersion: 1,
          successCondition: "No external actions",
          shipActions: [],
          state: "paused",
          health: "healthy",
        } satisfies Loop;
      } else if (table === "loop_items") {
        if (!plan.targets.loops) throw new Error("Loop items require fixture loops");
        json = {
          id,
          loopId: syntheticId("loops", 1 + ((i - 1) % plan.targets.loops)),
          sourceKey: `perf-source-${i}`,
          sourceSummary: `QM performance item ${i}`,
          status: i === 1 ? "ready" : "shipped",
          source: "slack",
          sourcePayload: {
            source: "slack",
            title: `QM performance item ${i}`,
            snippet: "Synthetic fixture inbox item",
            from: "Performance user",
          },
          inboxPreview: {
            title: `QM performance item ${i}`,
            snippet: "Synthetic fixture inbox item",
            from: "Performance user",
          },
          attempts: 1,
          runIds: [],
          outputIds: [],
          createdAt: at,
          updatedAt: at,
        } satisfies LoopItem;
      } else if (table === "base_model_configs") {
        id = scope;
        json = { scopeId: scope, modelId: "gpt-4.1" } satisfies PersistedBaseModel;
      } else if (table === "soul_configs") {
        id = scope;
        json = {
          scopeId: scope,
          content: "QM performance fixture",
          version: 1,
          updatedAt: at,
          updatedBy: owner,
          history: [],
        } satisfies PersistedSoul;
      } else if (table === "connector_status") {
        id = owner;
        json = {
          principalId: owner,
          checkedAt: plan.anchorTime,
          providers: { google: { connected: false }, github: { connected: false } },
        } satisfies ConnectorStatusRecord;
      } else if (table === "model_registry") {
        id = `qm-perf-model-${i}`;
        json = {
          spec: {
            id,
            name: `QM performance model ${i}`,
            provider: "openai",
            template: "gpt-4.1",
            contextWindow: 128000,
            maxTokens: 4096,
            cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
            base: true,
            webui: true,
            auxiliary: false,
            fastMode: false,
          },
          disabled: true,
          updatedAt: at,
          updatedBy: admin,
        } satisfies StoredModelOverlay;
      } else if (table === "crons") {
        id = `perf-cron-${i - 1}`;
        json = {
          ...trigger,
          id,
          title: `QM performance cron ${i}`,
          schedule: { everyMs: 86_400_000 },
          action: "Synthetic fixture",
          runAs: "owner",
          archived: false,
          fireLog: [],
        } satisfies Cron;
      } else if (table === "skills") {
        json = {
          id,
          scopeId: scope,
          manifest: {
            name: `perf-skill-${i}`,
            description: "QM performance skill",
            body: "Synthetic fixture",
            requiredCapabilities: [],
          },
          status: i <= 2 ? "published" : "draft",
          signature: "",
          createdBy: owner,
          version: 1,
          grantedCapabilities: [],
          approvals: [],
          createdAt: at,
        } satisfies Skill;
      } else if (table === "web_ui_state") {
        id = `${owner}#split-canvas`;
        json = { value: { v: 2, active: false, updatedAt: at }, updatedAt: at } satisfies PersistedUiState;
      } else if (table === "webui_model_configs") {
        id = scope;
        json = { scopeId: scope, ids: ["gpt-4.1"] } satisfies PersistedWebuiModels;
      }
      if (json === undefined) throw new Error(`Missing fixture shape for ${table}`);
      if (lengths) {
        const bucket =
          count > 1 ? Math.floor(((i - 1) * (lengths.length - 1)) / (count - 1)) : Math.floor(lengths.length / 2);
        const gap = (fullLengths?.[i - 1] ?? lengths[bucket]!) - Buffer.byteLength(JSON.stringify(json));
        const record = json as Record<string, unknown>;
        if (table === "keychain_credentials" && gap > 0) {
          const plainBytes = Math.floor(((String(record.secretEnc).length + gap - 45) * 3) / 4);
          record.secretEnc = encryptSecret(payloadText(`${table}:${i}`, plainBytes), secretKey);
        } else if (gap >= 17) {
          const ratio = Math.min(1, Number(measured!.avg_stored_bytes) / Number(average) / 0.65);
          record.fixtureData = payloadText(`${table}:${i}`, gap - 17, ratio);
        }
      }
      rows.push({ table, id, json });
    }
  }
  return rows;
}
