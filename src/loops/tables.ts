import { createMemoryLoopRows, createPostgresLoopRows } from "./loop-table.ts";
import { createMemoryItemRows, createPostgresItemRows } from "./item-table.ts";
import { createMemoryOutputRows, createPostgresOutputRows } from "./output-table.ts";
import { createMemoryShipGrantRows, createPostgresShipGrantRows } from "./ship-grant-table.ts";
import {
  createMemoryIngressDeliveryRows,
  createMemoryIngressSourceRows,
  createPostgresIngressDeliveryRows,
  createPostgresIngressSourceRows,
} from "./ingress-table.ts";

export function createLoopTables(databaseUrl: string | undefined) {
  if (!databaseUrl)
    return {
      loops: createMemoryLoopRows(),
      items: createMemoryItemRows(),
      outputs: createMemoryOutputRows(),
      grants: createMemoryShipGrantRows(),
      sources: createMemoryIngressSourceRows(),
      deliveries: createMemoryIngressDeliveryRows(),
    };
  return {
    loops: createPostgresLoopRows(databaseUrl),
    items: createPostgresItemRows(databaseUrl),
    outputs: createPostgresOutputRows(databaseUrl),
    grants: createPostgresShipGrantRows(databaseUrl),
    sources: createPostgresIngressSourceRows(databaseUrl),
    deliveries: createPostgresIngressDeliveryRows(databaseUrl),
  };
}
