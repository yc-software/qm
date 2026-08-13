#!/usr/bin/env node
import { PostgresRelayStore } from "./postgres-store.js";
import { createRelayServer } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
const databaseUrl = process.env.INWISE_QM_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("INWISE_QM_DATABASE_URL or DATABASE_URL is required");
}
const publicUrl = process.env.INWISE_QM_PUBLIC_URL;
const requestTimeoutMs = Number(process.env.INWISE_QM_REQUEST_TIMEOUT_MS ?? 45_000);
const requestLeaseMs = Number(process.env.INWISE_QM_REQUEST_LEASE_MS ?? 30_000);

const server = createRelayServer({
  store: new PostgresRelayStore(databaseUrl),
  publicUrl,
  requestTimeoutMs,
  requestLeaseMs,
});
server.listen(port, "0.0.0.0", () => {
  console.log(`Inwise QM relay listening on port ${port}`);
});
