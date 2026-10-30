import { createDeliveryPoller, DEFAULT_SLACK_ACCOUNT, type DeliveryTenant } from "../../src/slack/deliveries.ts";
import type { SlackCoreClient } from "../../src/api/slack-core-client.ts";
import type { Delivery } from "../../src/types.ts";
import { TEST_TENANT } from "./tenant.ts";

export function testDeliveryPoller(
  deps: Omit<DeliveryTenant, "clientForAccount" | "flow" | "threads"> & {
    core: unknown;
    flow: unknown;
    threads: unknown;
    clientForAccount?: (accountId: string, teamId?: string) => any;
    claimMs?: number;
    slowDrainMs?: number;
  },
): { pollDeliveries(client?: unknown): Promise<boolean> } {
  let current: unknown;
  const base = deps.core as SlackCoreClient;
  const core = Object.create(base, {
    claimDeliveries: {
      value: async (type: string, ms: number) =>
        ((await base.claimDeliveries(type, ms)) as Delivery[]).map((d) => ({
          ...d,
          tenantId: d.tenantId ?? TEST_TENANT,
        })),
    },
  }) as SlackCoreClient;
  const tenant: DeliveryTenant = {
    ...deps,
    flow: deps.flow as DeliveryTenant["flow"],
    threads: deps.threads as DeliveryTenant["threads"],
    clientForAccount: deps.clientForAccount ?? ((id) => (id === DEFAULT_SLACK_ACCOUNT ? current : undefined)),
  };
  const poller = createDeliveryPoller({
    core,
    tenant: (id) => (id === TEST_TENANT ? tenant : undefined),
    ...(deps.claimMs !== undefined ? { claimMs: deps.claimMs } : {}),
    ...(deps.slowDrainMs !== undefined ? { slowDrainMs: deps.slowDrainMs } : {}),
  });
  return {
    pollDeliveries(client) {
      current = client;
      return poller.pollDeliveries();
    },
  };
}
