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
  setAlwaysOn?(d: Deployment, alwaysOn: boolean): Promise<void>;
  resolveEndpoint?(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint | null>;
  /** True when the app's machine should be replaced ahead of a platform lifetime limit. */
  rotationDue?(d: Deployment): Promise<boolean>;
  /** Suspend the app's machine until its next visit. */
  park?(d: Deployment): Promise<void>;
  /** Recent output from the running app (entrypoint stdout+stderr), newest last. */
  logs?(d: Deployment, opts: { tailLines: number }): Promise<string | null>;
}
