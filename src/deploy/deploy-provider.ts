import type { PublishedApp, DeployEndpoint, AppVersion } from "./deploy-store.ts";

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
  apply(d: PublishedApp, version: AppVersion): Promise<DeployEndpoint>;
  reconcile?(d: PublishedApp, version: AppVersion, gitBundle: Uint8Array): Promise<DeployEndpoint>;
  liveEdit?(d: PublishedApp, version: AppVersion, edit: DeployLiveEdit): Promise<boolean>;
  destroy(d: PublishedApp): Promise<void>;
  setAlwaysOn?(d: PublishedApp, alwaysOn: boolean): Promise<void>;
  resolveEndpoint?(d: PublishedApp, version: AppVersion): Promise<DeployEndpoint | null>;
  rotationDue?(d: PublishedApp): Promise<boolean>;
  park?(d: PublishedApp): Promise<void>;
  logs?(d: PublishedApp, opts: { tailLines: number }): Promise<string | null>;
}
