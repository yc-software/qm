import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { recordAuditInBinding, type AuditEvent } from "../src/audit/audit-log.ts";
import { recordErrorInBinding, type ErrorEvent } from "../src/admin/error-log.ts";
import { withTenant, withoutTenant, type Tenant } from "../src/tenants/context.ts";

const auditEvent: AuditEvent = {
  at: 1,
  principalId: "a@example.com",
  action: "x",
  resource: "r",
  scopeLabel: "personal:a@example.com",
};
const errorEvent: Omit<ErrorEvent, "ts"> = {
  category: "c",
  code: "k",
  message: "m",
  scopeLabel: "personal:a@example.com",
};

test("the audit and error bridges record with the bound tenant's token", () => {
  const tenant = randomUUID();
  const seen: string[] = [];
  withTenant(tenant, () => {
    recordAuditInBinding({ record: (t: Tenant) => void seen.push(`audit:${t.id}`) }, auditEvent);
    recordErrorInBinding({ record: (t: Tenant) => void seen.push(`error:${t.id}`) }, errorEvent);
  });
  assert.deepEqual(seen, [`audit:${tenant}`, `error:${tenant}`]);
});

test("with no tenant bound the bridges neither throw nor write", () =>
  withoutTenant(() => {
    const seen: string[] = [];
    recordAuditInBinding({ record: () => void seen.push("audit") }, auditEvent);
    recordErrorInBinding({ record: () => void seen.push("error") }, errorEvent, new Error("boom"));
    assert.deepEqual(seen, []);
  }));
