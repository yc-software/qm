import { randomBytes } from "node:crypto";
import { mintDeployGitAccess } from "./access-token.ts";
import type { PublishedApp, AppVersion, DeployStore } from "./deploy-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";

const PRINCIPAL_PREFIX = "render-deploy:";

interface RenderDeployArtifactAccess {
  url: string;
  token: string;
  commit: string;
  entrypoint: string;
}

export interface StoredRenderDeployCredential {
  principalId: string;
}

export interface RenderDeployArtifacts {
  prepare(publishedApp: PublishedApp, version: AppVersion): Promise<RenderDeployArtifactAccess>;
  revoke(appId: string): Promise<void>;
  authorizes(
    publishedApp: PublishedApp,
    principalId: string,
    permission: "read" | "write",
  ): Promise<boolean | undefined>;
}

export function createRenderDeployArtifacts(opts: {
  baseUrl: string;
  signingSecret: string;
  store: DurableMap<StoredRenderDeployCredential>;
  deployStore: Pick<DeployStore, "versionOf">;
}): RenderDeployArtifacts {
  return {
    async prepare(publishedApp, version) {
      if (!opts.signingSecret) throw new Error("Render app deployment requires CORE_SIGNING_SECRET");
      const base = URL.parse(opts.baseUrl);
      if (
        !base ||
        (base.protocol !== "https:" &&
          !(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname))) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
      )
        throw new Error("Render app deployment requires an HTTPS PUBLIC_API_URL without credentials");
      const saved = await opts.deployStore.versionOf(publishedApp.id, version.version);
      if (
        !saved?.commit ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(saved.commit) ||
        saved.commit !== version.commit ||
        saved.entrypoint !== version.entrypoint
      )
        throw new Error(`Render app version ${publishedApp.id}@${version.version} has no matching durable Git commit`);
      let credential = await opts.store.get(publishedApp.id);
      if (!credential) {
        credential = { principalId: `${PRINCIPAL_PREFIX}${randomBytes(32).toString("base64url")}` };
        await opts.store.put(publishedApp.id, credential);
      }
      const token = await mintDeployGitAccess(opts.signingSecret, {
        deploymentId: publishedApp.id,
        permission: "read",
        principalId: credential.principalId,
        exp: Number.MAX_SAFE_INTEGER,
      });
      return {
        url: new URL(`/v1/apps/${encodeURIComponent(publishedApp.id)}/git`, base).toString(),
        token,
        commit: saved.commit,
        entrypoint: saved.entrypoint,
      };
    },
    revoke: (id) => opts.store.delete(id),
    async authorizes(publishedApp, principalId, permission) {
      if (!principalId.startsWith(PRINCIPAL_PREFIX)) return undefined;
      return permission === "read" && (await opts.store.get(publishedApp.id))?.principalId === principalId;
    },
  };
}
