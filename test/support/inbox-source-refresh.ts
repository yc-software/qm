import { createInboxSourceRefresh as createRefresh } from "../../src/loops/inbox-source-refresh.ts";
import { createLoopItemLedger } from "../../src/loops/item-ledger.ts";
import { testMap } from "./test-database.ts";

export async function fixture(source = "gmail", meta: Record<string, unknown> = { threadId: "t1" }) {
  const items = createLoopItemLedger(testMap());
  await items.ingest([
    {
      loopId: "inbox",
      dedupeKey: "ask",
      source,
      sourceAt: 1000,
      sourcePayload: { [source]: meta, context: [{ author: "Elsewhere", text: "UNRELATED CHANNEL TAIL" }] },
      proposal: { by: "human", data: { body: "Keep my edit" } },
    },
  ]);
  return { items, item: (await items.byLoop("inbox"))[0]! };
}
export const featureFlags = { enabled: async () => true };
export const createInboxSourceRefresh = (
  deps: Omit<Parameters<typeof createRefresh>[0], "enqueue"> & {
    enqueue?: Parameters<typeof createRefresh>[0]["enqueue"];
  },
) => createRefresh({ enqueue: async () => undefined, ...deps });
export const tokens = { connectorAccessToken: async () => "synthetic-token" };
export const json = (body: unknown) => Response.json(body);
