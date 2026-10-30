import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { LoopStore } from "./loop-store.ts";
import type { LoopItemLedger } from "./item-ledger.ts";
import type { LoopOutputStore } from "./output-store.ts";
import type { ShipGrantStore } from "./ship-grant-store.ts";
import type { LoopFireService } from "./loop-fire.ts";
import type { CronStore } from "../cron/cron-store.ts";
import type { ScopedConfigStore } from "../resolution/config-store.ts";


export interface LoopServiceDeps {
  lock?: AdvisoryLock;
  store: LoopStore;
  items: LoopItemLedger;
  outputs: LoopOutputStore;
  grants: ShipGrantStore;
  fire?: LoopFireService;
  crons?: CronStore;
  config: ScopedConfigStore;
}
