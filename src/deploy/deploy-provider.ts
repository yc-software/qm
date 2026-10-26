import type { Deployment, DeployEndpoint, DeploymentVersion } from "./deploy-store.ts";

export type { DeployEndpoint };

export interface DeployProfile {
  managedScaleToZero: boolean;
  appliesGitBundle?: boolean;
  dataDir?: string;
  maxAppBytes?: number;
}

export interface DeployProvider {
  readonly profile: DeployProfile;
  apply(d: Deployment, version: DeploymentVersion, gitBundle?: Uint8Array): Promise<DeployEndpoint>;
  resolveEndpoint(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint | null>;
  destroy(d: Deployment): Promise<void>;
  logs(d: Deployment, opts: { tailLines: number }): Promise<string | null>;
}
