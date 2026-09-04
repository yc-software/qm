import { createPostgresAuditLog } from "../admin/postgres-audit-log.ts";
import { loadMemoryServiceConfig } from "../config.ts";
import { createMemoryHttpService } from "./http-service.ts";
import { createPostgresMemoryService } from "./postgres-memory-service.ts";

const config = loadMemoryServiceConfig();

const server = createMemoryHttpService({
  memory: createPostgresMemoryService(config.databaseUrl, config.tombstoneSecret),
  auditLog: createPostgresAuditLog(config.databaseUrl),
  integrationId: config.integrationId,
  signingSecret: config.signingSecret,
  scopeTokenSecret: config.tombstoneSecret,
  allowedScopeKinds: config.allowedScopeKinds,
  allowedScopePrefixes: config.allowedScopePrefixes,
});

server.listen(config.port, "0.0.0.0", () => console.log(`[memory-service] listening on :${config.port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
