import { createPostgresLoopRows } from "./loop-table.ts";
import { createPostgresItemRows } from "./item-table.ts";
import { createPostgresOutputRows } from "./output-table.ts";
import { createPostgresShipGrantRows } from "./ship-grant-table.ts";
import { createPostgresIngressDeliveryRows, createPostgresIngressSourceRows } from "./ingress-table.ts";

export function createLoopTables(databaseUrl: string) {
  return {
    loops: createPostgresLoopRows(databaseUrl),
    items: createPostgresItemRows(databaseUrl),
    outputs: createPostgresOutputRows(databaseUrl),
    grants: createPostgresShipGrantRows(databaseUrl),
    sources: createPostgresIngressSourceRows(databaseUrl),
    deliveries: createPostgresIngressDeliveryRows(databaseUrl),
  };
}
