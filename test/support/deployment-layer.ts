import {
  createDeploymentLayerStore,
  type DeploymentLayerBundle,
  type StoredDeploymentLayer,
} from "../../src/deployment/deployment-layer-store.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { testDatabaseUrl } from "./test-database.ts";
import { createNoopAdvisoryLock, createPostgresAdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { createSkillStore } from "../../src/skills/skill-store.ts";
import { emptyDeploymentLayer } from "../../src/deployment/load-layer.ts";
import { scopeId } from "../../src/types.ts";

export const tool = (advertise: string): DeploymentLayerBundle["tools"][number] => ({
  path: "tools/acme/tool.json",
  content: JSON.stringify({
    id: "acme",
    advertise,
    hints: ["Use acme for company data."],
    auth: {
      check: "acme auth status",
      reauth: "acme auth login",
      credentialPaths: [{ path: ".config/acme", kind: "directory" }],
    },
    approvals: [{ command: "deploy", decision: "deny" }],
  }),
});

export const skill: DeploymentLayerBundle["skills"] = [
  {
    path: "skills/acme/SKILL.md",
    content: "---\nname: acme\ndescription: Use Acme systems.\n---\nRun the acme tool.\n",
  },
];

type LayerHead = Pick<StoredDeploymentLayer, "contentHash" | "pendingAudits">;
export const readLayer = async (databaseUrl: string): Promise<LayerHead | null> =>
  ((
    await createPgPool(databaseUrl).q(
      `SELECT content_hash AS "contentHash", pending_audits AS "pendingAudits" FROM deployment_layer`,
    )
  )[0] as LayerHead | undefined) ?? null;

export async function putLayer(databaseUrl: string, r: StoredDeploymentLayer): Promise<void> {
  const { q } = createPgPool(databaseUrl);
  await q(`DELETE FROM deployment_layer`);
  await q(`INSERT INTO deployment_layer SELECT * FROM jsonb_populate_record(NULL::deployment_layer, $1)`, [
    {
      ...r,
      id: "current",
      content_hash: r.contentHash,
      updated_at: r.updatedAt,
      updated_by: r.updatedBy,
      pending_audits: r.pendingAudits,
    },
  ]);
}

export const org = scopeId("org", "default-org");

export function fixture() {
  const databaseUrl = testDatabaseUrl();
  const skills = createSkillStore({ advisoryLock: createPostgresAdvisoryLock(createPgPool(databaseUrl)), databaseUrl });
  const layer = (opts: Partial<Parameters<typeof createDeploymentLayerStore>[0]> = {}) =>
    createDeploymentLayerStore({
      advisoryLock: createNoopAdvisoryLock(),
      databaseUrl,
      runtime: emptyDeploymentLayer(),
      skills,
      ...opts,
    });
  return { databaseUrl, skills, layer };
}
