import type { LogOpts } from "../services.ts";

export interface BackendUpOptions {
  dryRun: boolean;
  yes?: boolean;
  buildFrom?: boolean;
  buildFromPath?: string;
  imageLabel?: string;
  only?: string[];
  imageFrom?: string;
  imageRepoPrefix?: string;
  buildOnly?: boolean;
}

export interface Backend {
  up(opts: BackendUpOptions): Promise<void>;
  status(): Promise<void> | void;
  logs(service: string | undefined, opts: LogOpts): Promise<void> | void;
  down(opts: { purge?: boolean }): Promise<void> | void;
  rollback(to?: string): Promise<void> | void;
  doctor(): Promise<void> | void;
  secretsPush(envFile?: string): Promise<void> | void;
  checkLive?(opts?: { report?: boolean }): Promise<void> | void;
  pinSandbox(image: string): Promise<void> | void;
}
