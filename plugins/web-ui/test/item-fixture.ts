import type { Item, ItemColumns, ItemKind } from "../src/items.ts";

type ItemFields = Partial<ItemColumns> & { seq?: number; createdAt?: number; sessionId?: string; truncated?: true };

export function item(kind: ItemKind, fields: ItemFields = {}): Item {
  return {
    kind,
    sessionId: "s1",
    seq: 0,
    createdAt: 0,
    turnId: null,
    author: null,
    callId: null,
    elicitId: null,
    wakeCause: null,
    errorCode: null,
    text: null,
    tool: null,
    step: null,
    variant: null,
    isError: null,
    hidden: null,
    externalId: null,
    throughSeq: null,
    targetSeq: null,
    approved: null,
    blobSha: null,
    body: {},
    ...fields,
  } as Item;
}
