import type { Deployment, DeployEndpoint, DeploymentVersion } from "./deploy-store.ts";

export type { DeployEndpoint };

export interface DeployProfile {
  managedScaleToZero: boolean;
  inPlaceReconcile?: boolean;
  dataDir?: string;
}

export interface DeployReconcileInput {
  gitBundle?: Uint8Array;
  changedPaths: string[];
  deletedPaths: string[];
  allPaths: string[];
}

export interface DeployProvider {
  readonly profile: DeployProfile;
  apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint>;
  reconcile?(d: Deployment, version: DeploymentVersion, input: DeployReconcileInput): Promise<DeployEndpoint>;
  destroy(d: Deployment): Promise<void>;
  resolveEndpoint?(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint | null>;
  /** Recent output from the running app (entrypoint stdout+stderr), newest last. */
  logs?(d: Deployment, opts: { tailLines: number }): Promise<string | null>;
}
