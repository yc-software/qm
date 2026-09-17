import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FACTORY_INTAKE_STATE,
  LINEAR_GRAPHQL_URL,
  enumerateFactoryCandidates,
} from "../src/loops/factory/linear-intake.ts";

const API_KEY = "lin_api_SECRET";

type Script = Response[] | ((index: number) => Response);
type Call = { url: string; init: RequestInit | undefined };

interface Fake {
  fetch: typeof globalThis.fetch;
  calls: Call[];
}

function fakeFetch(script: Script): Fake {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), init });
    const response = typeof script === "function" ? script(calls.length - 1) : script[calls.length - 1];
    if (!response) return Promise.reject(new Error(`unscripted fetch #${calls.length}`));
    return Promise.resolve(response);
  };
  return { fetch, calls };
}

function callAt(fake: Fake, index: number): Call {
  const call = fake.calls[index];
  if (!call) throw new Error(`expected a fetch call at index ${index}, saw ${fake.calls.length}`);
  return call;
}

function requestBody(call: Call): { query: string; variables: Record<string, unknown> } {
  return JSON.parse(String(call.init?.body)) as { query: string; variables: Record<string, unknown> };
}

const headerOf = (call: Call, name: string): string | null => new Headers(call.init?.headers).get(name);

const relation = (type: string, stateType: string): unknown => ({
  type,
  issue: { identifier: "QM-14", state: { type: stateType } },
});

const issue = (identifier: string, createdAt: string, relations: unknown[] = []): unknown => ({
  identifier,
  title: `${identifier} title`,
  createdAt,
  inverseRelations: { nodes: relations },
});

const page = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null): Response =>
  Response.json({ data: { team: { issues: { nodes, pageInfo: { hasNextPage, endCursor } } } } });

const keysOf = (candidates: { sourceKey: string }[]): string[] => candidates.map((candidate) => candidate.sourceKey);

const intake = (fake: Fake, overrides: { stateName?: string; maxPages?: number; teamId?: string } = {}) =>
  enumerateFactoryCandidates({ teamId: "QM", apiKey: API_KEY, fetch: fake.fetch, ...overrides });

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the call to reject");
}

function assertNoKey(error: Error): void {
  assert.equal(error.message.includes(API_KEY), false);
  assert.equal((error.stack ?? "").includes(API_KEY), false);
  assert.equal(JSON.stringify((error as { cause?: unknown }).cause ?? null).includes(API_KEY), false);
}

test("returns Auto-Triage issues as candidates ordered by createdAt ascending", async () => {
  const fake = fakeFetch([
    page([issue("QM-20", "2026-02-02T00:00:00.000Z"), issue("QM-19", "2026-01-01T00:00:00.000Z")]),
  ]);

  const candidates = await intake(fake);

  assert.deepEqual(candidates, [
    { sourceKey: "QM-19", sourceSummary: "QM-19 title" },
    { sourceKey: "QM-20", sourceSummary: "QM-20 title" },
  ]);
  assert.equal(fake.calls.length, 1);
});

test("posts one Linear query carrying the verbatim key, the team id, and the requested state", async () => {
  const byDefault = fakeFetch([page([])]);

  assert.deepEqual(await intake(byDefault), []);

  const call = callAt(byDefault, 0);
  assert.equal(call.url, LINEAR_GRAPHQL_URL);
  assert.equal(call.init?.method, "POST");
  assert.equal(headerOf(call, "authorization"), API_KEY);
  assert.equal(headerOf(call, "content-type"), "application/json");
  assert.deepEqual(requestBody(call).variables, { teamId: "QM", state: FACTORY_INTAKE_STATE });
  assert.equal(FACTORY_INTAKE_STATE, "Auto-Triage");

  const overridden = fakeFetch([page([])]);
  await intake(overridden, { stateName: "Ready" });
  assert.equal(requestBody(callAt(overridden, 0)).variables.state, "Ready");
});

test("falls back to globalThis.fetch when no fetch is injected", async () => {
  const fake = fakeFetch([page([issue("QM-19", "2026-01-01T00:00:00.000Z")])]);
  const real = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    const candidates = await enumerateFactoryCandidates({ teamId: "QM", apiKey: API_KEY });
    assert.deepEqual(keysOf(candidates), ["QM-19"]);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(fake.calls.length, 1);
});

test("drops an issue held by an unresolved blocks relation and keeps every other shape", async () => {
  const fake = fakeFetch([
    page([
      issue("QM-A", "2026-01-01T00:00:00.000Z", [relation("blocks", "started")]),
      issue("QM-B", "2026-01-02T00:00:00.000Z", [relation("blocks", "completed")]),
      issue("QM-C", "2026-01-03T00:00:00.000Z", [relation("blocks", "canceled")]),
      issue("QM-D", "2026-01-04T00:00:00.000Z", [relation("related", "started")]),
      issue("QM-E", "2026-01-05T00:00:00.000Z"),
      issue("QM-F", "2026-01-06T00:00:00.000Z", [relation("blocks", "completed"), relation("blocks", "unstarted")]),
    ]),
  ]);

  const candidates = await intake(fake);

  assert.deepEqual(keysOf(candidates), ["QM-B", "QM-C", "QM-D", "QM-E"]);
  assert.equal(fake.calls.length, 1);
});

test("treats absent relation, issue, and state fields as unblocked rather than throwing", async () => {
  const fake = fakeFetch([
    page([
      { identifier: "QM-I", title: "QM-I title", createdAt: "2026-01-01T00:00:00.000Z" },
      {
        identifier: "QM-J",
        title: "QM-J title",
        createdAt: "2026-01-02T00:00:00.000Z",
        inverseRelations: { nodes: null },
      },
      issue("QM-K", "2026-01-03T00:00:00.000Z", [{ type: "blocks", issue: null }]),
      issue("QM-L", "2026-01-04T00:00:00.000Z", [{ type: "blocks", issue: { identifier: "QM-14" } }]),
    ]),
  ]);

  const candidates = await intake(fake);

  assert.deepEqual(keysOf(candidates), ["QM-I", "QM-J", "QM-K", "QM-L"]);
});

test("follows the end cursor and sorts across page boundaries", async () => {
  const fake = fakeFetch([
    page([issue("QM-20", "2026-02-02T00:00:00.000Z")], true, "cur-1"),
    page([issue("QM-19", "2026-01-01T00:00:00.000Z")]),
  ]);

  const candidates = await intake(fake);

  assert.equal(fake.calls.length, 2);
  assert.equal("after" in requestBody(callAt(fake, 0)).variables, false);
  assert.equal(requestBody(callAt(fake, 1)).variables.after, "cur-1");
  assert.deepEqual(keysOf(candidates), ["QM-19", "QM-20"]);
});

test("stops at the request cap while hasNextPage is still true", async () => {
  const endless = (index: number): Response =>
    page([issue(`QM-${index}`, `2026-01-0${index + 1}T00:00:00.000Z`)], true, `cur-${index}`);

  const capped = fakeFetch(endless);
  assert.deepEqual(keysOf(await intake(capped, { maxPages: 2 })), ["QM-0", "QM-1"]);
  assert.equal(capped.calls.length, 2);

  const defaulted = fakeFetch(endless);
  await intake(defaulted);
  assert.equal(defaulted.calls.length, 5);
});

test("stops paging when the page cannot supply a next cursor", async () => {
  const nonAdvancing = [
    () => page([issue("QM-19", "2026-01-01T00:00:00.000Z")], true, null),
    () => page([issue("QM-19", "2026-01-01T00:00:00.000Z")], true, ""),
    () => Response.json({ data: { team: { issues: { nodes: [issue("QM-19", "2026-01-01T00:00:00.000Z")] } } } }),
  ];

  for (const respond of nonAdvancing) {
    const fake = fakeFetch(respond);

    assert.deepEqual(await intake(fake), [{ sourceKey: "QM-19", sourceSummary: "QM-19 title" }]);
    assert.equal(fake.calls.length, 1);
    assert.equal("after" in requestBody(callAt(fake, 0)).variables, false);
  }
});

test("returns candidates when a 200 carries an empty errors array", async () => {
  const fake = fakeFetch([
    Response.json({
      errors: [],
      data: {
        team: {
          issues: {
            nodes: [issue("QM-20", "2026-02-02T00:00:00.000Z"), issue("QM-19", "2026-01-01T00:00:00.000Z")],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }),
  ]);

  assert.deepEqual(keysOf(await intake(fake)), ["QM-19", "QM-20"]);
  assert.equal(fake.calls.length, 1);
});

const FAILURES: { name: string; script: Script; message: RegExp }[] = [
  {
    name: "a Linear error at HTTP 200, such as an unknown team",
    script: [Response.json({ data: null, errors: [{ message: "Entity not found: Team" }] })],
    message: /^linear_intake_failed: Entity not found: Team$/,
  },
  {
    name: "a rejected key whose error page is not JSON",
    script: [new Response(`<html>denied ${API_KEY}</html>`, { status: 401 })],
    message: /^linear_intake_failed: 401$/,
  },
  {
    name: "a 200 whose body cannot be parsed",
    script: [new Response(`not json ${API_KEY}`, { status: 200 })],
    message: /^linear_intake_failed: /,
  },
  {
    name: "a 200 that carries no team issues",
    script: [Response.json({ data: { team: null } })],
    message: /^linear_intake_failed: /,
  },
  {
    name: "errors reported alongside a populated data payload",
    script: [
      Response.json({
        errors: [{ message: "rate limited" }],
        data: { team: { issues: { nodes: [issue("QM-19", "2026-01-01T00:00:00.000Z")], pageInfo: {} } } },
      }),
    ],
    message: /^linear_intake_failed: rate limited$/,
  },
];

for (const failure of FAILURES) {
  test(`fails closed on ${failure.name}, without leaking the key`, async () => {
    const fake = fakeFetch(failure.script);

    const error = await rejection(intake(fake));

    assert.match(error.message, failure.message);
    assertNoKey(error);
  });
}

test("throws rather than returning the first page when a later page fails", async () => {
  const fake = fakeFetch([
    page([issue("QM-19", "2026-01-01T00:00:00.000Z")], true, "cur-1"),
    new Response("boom", { status: 500 }),
  ]);

  const error = await rejection(intake(fake));

  assert.equal(error.message, "linear_intake_failed: 500");
  assert.equal(fake.calls.length, 2);
});

test("selects the team through team(id:), passing an id of either shape through verbatim", async () => {
  const fake = fakeFetch([page([])]);

  await intake(fake, { teamId: "6b661740-fd32-4189-837e-568df6fae1e8" });

  const { query, variables } = requestBody(callAt(fake, 0));
  assert.equal(variables.teamId, "6b661740-fd32-4189-837e-568df6fae1e8");
  for (const fragment of [
    "query FactoryIntake($teamId: String!, $state: String!, $after: String)",
    "team(id: $teamId)",
    "issues(first: 50, after: $after, filter: { state: { name: { eq: $state } } })",
    "pageInfo { hasNextPage endCursor }",
  ]) {
    assert.ok(query.includes(fragment), `query is missing ${fragment}`);
  }
  assert.match(
    query,
    /nodes \{\s+identifier\s+title\s+createdAt\s+inverseRelations \{ nodes \{ type issue \{ identifier state \{ type \} \} \} \}/,
  );
  assert.doesNotMatch(query, /team: \{ (id|key):/);
});
