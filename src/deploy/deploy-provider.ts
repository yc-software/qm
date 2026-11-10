import type { Deployment, DeployEndpoint, DeploymentVersion } from "./deploy-store.ts";

export type { DeployEndpoint };

export interface DeployProfile {
  managedScaleToZero: boolean;
  dataDir?: string;
  maxAppBytes?: number;
}

interface DeployLiveEdit {
  files: Array<{ path: string; data: Uint8Array }>;
  deletedPaths: string[];
  restart: boolean;
}

export interface DeployProvider {
  readonly profile: DeployProfile;
  apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint>;
  reconcile?(d: Deployment, version: DeploymentVersion, gitBundle: Uint8Array): Promise<DeployEndpoint>;
  liveEdit?(d: Deployment, version: DeploymentVersion, edit: DeployLiveEdit): Promise<boolean>;
  destroy(d: Deployment): Promise<void>;
  setAlwaysOn?(d: Deployment, alwaysOn: boolean): Promise<void>;
  resolveEndpoint?(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint | null>;
  rotationDue?(d: Deployment): Promise<boolean>;
  park?(d: Deployment): Promise<void>;
  /** Recent output from the running app (entrypoint stdout+stderr), newest last. */
  logs?(d: Deployment, opts: { tailLines: number }): Promise<string | null>;
}
