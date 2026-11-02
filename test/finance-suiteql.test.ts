import { test } from "node:test";
import assert from "node:assert/strict";
import { executeSuiteQL } from "../src/api/routes/finance.ts";
import { TOOL_BROKER_AUD, CREDENTIAL_BROKER_AUD } from "../src/auth/capability-token.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import type { DecryptedServiceCredential, ServiceCredentialReader } from "../src/credentials/keychain.ts";
import type { BrokerFetch } from "../src/api/credential-broker.ts";

function fakeRes() {
  const out = { status: 0, body: undefined as unknown };
  return {
    res: {
      req: { headers: {} },
      getHeader() {},
      writeHead(status: number) {
        out.status = status;
        return this;
      },
      end(data?: string) {
        out.body = data ? JSON.parse(data) : undefined;
      },
    } as unknown as ApiCtx["res"],
    out,
  };
}

test("executeSuiteQL requires capability claims with tool-broker or credential-broker aud", async () => {
  const { res, out } = fakeRes();
  await executeSuiteQL({
    res,
    deps: {} as any,
    body: { query: "SELECT id FROM transaction" },
    capability: null,
  } as ApiCtx);

  assert.equal(out.status, 401);
  assert.equal((out.body as any).error, "unauthorized");
});

test("executeSuiteQL rejects non-S4_SOURCE state with CloseGate error", async () => {
  const { res, out } = fakeRes();
  await executeSuiteQL({
    res,
    deps: {} as any,
    body: { query: "SELECT id FROM transaction", state: "S3_PLAN" },
    capability: {
      actorId: "actor",
      scopeId: "org:default-org" as any,
      aud: TOOL_BROKER_AUD,
      exp: Date.now() + 60_000,
    },
  } as ApiCtx);

  assert.equal(out.status, 403);
  assert.equal((out.body as any).error, "closegate_violation");
});

test("executeSuiteQL returns simulatedRows directly when provided", async () => {
  const { res, out } = fakeRes();
  const simulatedRows = [
    { account: "1000 Cash", debit: "1500.00", credit: 0 },
    { account: "4000 Revenue", debit: 0, credit: "1500.00" },
  ];
  await executeSuiteQL({
    res,
    deps: {} as any,
    body: { query: "SELECT id FROM transaction", state: "S4_SOURCE", simulatedRows },
    capability: {
      actorId: "actor",
      scopeId: "org:default-org" as any,
      aud: TOOL_BROKER_AUD,
      exp: Date.now() + 60_000,
    },
  } as ApiCtx);

  assert.equal(out.status, 200);
  assert.deepEqual((out.body as any).rows, simulatedRows);
  assert.equal((out.body as any).totalResults, 2);
  assert.equal((out.body as any).metadata.source, "simulated");
});

test("executeSuiteQL executes NetSuite TBA signed request and parses rows", async () => {
  const { res, out } = fakeRes();
  const secret = JSON.stringify({
    accountId: "1234567_SB1",
    consumerKey: "consumer key",
    consumerSecret: "consumer secret",
    tokenId: "token id",
    tokenSecret: "token secret",
  });
  const mockReader: ServiceCredentialReader = {
    getServiceCredentialSecret: async (_scope, slug) => {
      if (slug === "netsuite") {
        return {
          slug: "netsuite",
          name: "NetSuite",
          secret,
          delivery: "broker",
          host: "1234567-sb1.suitetalk.api.netsuite.com",
          deployments: true,
          enabled: true,
        } as DecryptedServiceCredential;
      }
      return null;
    },
  };

  const capturedCalls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  const mockFetch: BrokerFetch = async (url, init) => {
    capturedCalls.push({
      url,
      headers: init.headers,
      body: init.body,
    });
    return {
      status: 200,
      contentType: "application/json",
      text: async () =>
        JSON.stringify({
          items: [
            { account: "1010 Bank", debit: 5000, credit: 0 },
            { account: "1200 AR", debit: 0, credit: 5000 },
          ],
          totalResults: 2,
          hasMore: false,
        }),
    };
  };

  await executeSuiteQL({
    res,
    deps: {
      serviceCreds: mockReader,
      brokerFetch: mockFetch,
    } as any,
    body: {
      query: "SELECT account, debit, credit FROM transactionLines",
      state: "S4_SOURCE",
      planSha256: "plan123",
    },
    capability: {
      actorId: "actor",
      scopeId: "org:default-org" as any,
      aud: TOOL_BROKER_AUD,
      exp: Date.now() + 60_000,
    },
  } as ApiCtx);

  assert.equal(out.status, 200);
  assert.equal(capturedCalls.length, 1);
  assert.match(capturedCalls[0]?.headers.Authorization ?? "", /^OAuth realm="1234567_SB1"/);
  assert.equal((out.body as any).totalResults, 2);
  assert.equal((out.body as any).rows.length, 2);
  assert.equal((out.body as any).rows[0].account, "1010 Bank");
});
