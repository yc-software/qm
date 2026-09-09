import { test } from "node:test";
import assert from "node:assert/strict";
import {
  forgeRequest,
  returnFactoryPullRequest,
  shipFactoryAlreadyFixed,
  shipFactoryPullRequest,
  type ForgeRef,
  type ShipDeps,
} from "../src/loops/factory/ship.ts";

const FORGE_TOKEN = "ght_FAKE";
const LINEAR_KEY = "lin_api_FAKE";
const TICKET = "QM-21";
const LINEAR_URL = "https://api.linear.app/graphql";
const GH_PULL = "https://api.github.com/repos/yc-software/qm-yc/pulls/7";
const GH_ISSUE_COMMENTS = "https://api.github.com/repos/yc-software/qm-yc/issues/7/comments";
const GL_BASE = "https://gitlab.com/api/v4/projects/yc-software%2Fcode";
const GL_MR = `${GL_BASE}/merge_requests/42`;

const github: ForgeRef = { forge: "github", publishProject: "yc-software/qm-yc", number: 7 };
const gitlab: ForgeRef = { forge: "gitlab", publishProject: "yc-software/code", number: 42 };

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

interface Route {
  status?: number;
  body?: unknown;
}

const parseBody = (rec: Recorded): Record<string, unknown> => JSON.parse(rec.body ?? "{}") as Record<string, unknown>;

const queryOf = (rec: Recorded): string => String(parseBody(rec).query ?? "");

const LINEAR_OPS = ["issueUpdate", "issueAddLabel", "issueLabels", "commentCreate", "issue("] as const;

const routeKey = (rec: Recorded): string => {
  if (rec.url === LINEAR_URL) {
    const query = queryOf(rec);
    const op = LINEAR_OPS.find((candidate) => query.includes(candidate));
    return `linear:${op === "issue(" ? "issue" : (op ?? "unknown")}`;
  }
  if (rec.url === "https://api.github.com/graphql") return "github:graphql";
  return `${rec.method} ${rec.url}`;
};

function fakeFetch(routes: Record<string, Route>): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const rec: Recorded = {
      url: String(url),
      method: init?.method ?? "GET",
      headers,
      ...(init?.body ? { body: String(init.body) } : {}),
    };
    calls.push(rec);
    const route = routes[routeKey(rec)];
    if (route === undefined) throw new Error(`unscripted route: ${routeKey(rec)}`);
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const depsFor = (fetchImpl: typeof fetch): ShipDeps => ({
  fetch: fetchImpl,
  forgeToken: FORGE_TOKEN,
  linearApiKey: LINEAR_KEY,
});

const TEAM_STATES = [
  { id: "st_triage", name: "Auto-Triage", type: "unstarted" },
  { id: "st_review", name: "In Review", type: "started" },
  { id: "st_done", name: "Done", type: "completed" },
];

const AUTO_TRIAGE = { id: "st_triage", name: "Auto-Triage", type: "unstarted" };
const IN_REVIEW = { id: "st_review", name: "In Review", type: "started" };

const issueRead = (over: {
  state?: { id: string; name: string; type: string };
  labels?: string[];
  states?: { id: string; name: string; type: string }[];
}): Route => ({
  body: {
    data: {
      issue: {
        id: "iss_1",
        state: over.state ?? AUTO_TRIAGE,
        labels: { nodes: (over.labels ?? []).map((name, index) => ({ id: `lbl_${index}`, name })) },
        team: { id: "team_1", states: { nodes: over.states ?? TEAM_STATES } },
      },
    },
  },
});

const ok = (payload: Record<string, unknown>): Route => ({ body: { data: payload } });

const LABEL_LOOKUP = ok({ issueLabels: { nodes: [{ id: "lbl_rfr" }] } });
const STATE_OK = ok({ issueUpdate: { success: true } });
const LABEL_OK = ok({ issueAddLabel: { success: true } });
const COMMENT_OK = ok({ commentCreate: { success: true } });
const READY_MUTATION = ok({ markPullRequestReadyForReview: { pullRequest: { isDraft: false } } });

const keysOf = (calls: Recorded[]): string[] => calls.map(routeKey);

const only = (calls: Recorded[], key: string): Recorded => {
  const matched = calls.filter((call) => routeKey(call) === key);
  assert.equal(matched.length, 1, `expected exactly one ${key}`);
  return matched[0]!;
};

const rejectionMessage = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return assert.fail("expected a rejection");
};

const assertSecretFree = (message: string): void => {
  assert.ok(!message.includes(FORGE_TOKEN), `message leaked the forge token: ${message}`);
  assert.ok(!message.includes(LINEAR_KEY), `message leaked the linear key: ${message}`);
};

test("shipping a GitHub draft PR undrafts it, moves the ticket to In Review, and adds the label", async () => {
  const { fetchImpl, calls } = fakeFetch({
    [`GET ${GH_PULL}`]: { body: { draft: true, node_id: "PR_kwDOnode7", state: "open", merged: false } },
    "github:graphql": READY_MUTATION,
    "linear:issue": issueRead({}),
    "linear:issueUpdate": STATE_OK,
    "linear:issueLabels": LABEL_LOOKUP,
    "linear:issueAddLabel": LABEL_OK,
  });

  const results = await shipFactoryPullRequest(github, TICKET, depsFor(fetchImpl));

  assert.deepStrictEqual(results, [
    { step: "undraft", changed: true },
    { step: "linear-state", changed: true },
    { step: "linear-label", changed: true },
  ]);
  assert.deepStrictEqual(keysOf(calls), [
    `GET ${GH_PULL}`,
    "github:graphql",
    "linear:issue",
    "linear:issueUpdate",
    "linear:issueLabels",
    "linear:issueAddLabel",
  ]);
  assert.equal(calls[0]!.headers.authorization, `Bearer ${FORGE_TOKEN}`);
  assert.equal(calls[0]!.headers.accept, "application/vnd.github+json");
  const ghGraphql = only(calls, "github:graphql");
  assert.equal(ghGraphql.method, "POST");
  assert.equal(ghGraphql.headers.authorization, `Bearer ${FORGE_TOKEN}`);
  assert.equal(ghGraphql.headers.accept, "application/vnd.github+json");
  assert.equal(ghGraphql.headers["content-type"], "application/json");
  assert.match(queryOf(ghGraphql), /markPullRequestReadyForReview\(input: \{ pullRequestId: "PR_kwDOnode7" \}\)/);
  assert.match(
    queryOf(only(calls, "linear:issueUpdate")),
    /issueUpdate\(id: "iss_1", input: \{ stateId: "st_review" \}\)/,
  );
  assert.match(queryOf(only(calls, "linear:issueAddLabel")), /issueAddLabel\(id: "iss_1", labelId: "lbl_rfr"\)/);
  assert.match(queryOf(only(calls, "linear:issueLabels")), /name: \{ eq: "ready-for-review" \}/);

  const linearCalls = calls.filter((call) => call.url === LINEAR_URL);
  assert.equal(linearCalls.length, 4);
  for (const call of linearCalls) assert.equal(call.headers.authorization, LINEAR_KEY);
  assert.equal(linearCalls.filter((call) => /issue\(id: "QM-21"\)/.test(queryOf(call))).length, 1);
});

test("re-shipping a ready GitHub PR already In Review and labelled writes nothing", async () => {
  const { fetchImpl, calls } = fakeFetch({
    [`GET ${GH_PULL}`]: { body: { draft: false, node_id: "PR_kwDOnode7", state: "open", merged: false } },
    "linear:issue": issueRead({ state: IN_REVIEW, labels: ["ready-for-review"] }),
  });

  const results = await shipFactoryPullRequest(github, TICKET, depsFor(fetchImpl));

  assert.deepStrictEqual(results, [
    { step: "undraft", changed: false },
    { step: "linear-state", changed: false },
    { step: "linear-label", changed: false },
  ]);
  assert.deepStrictEqual(keysOf(calls), [`GET ${GH_PULL}`, "linear:issue"]);
});

for (const publishProject of ["yc-software/code", "yc-software%2Fcode"]) {
  test(`shipping a GitLab draft MR strips the prefix and single-encodes ${publishProject}`, async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`GET ${GL_MR}`]: { body: { draft: true, title: "Draft: Fix parser", state: "opened" } },
      [`PUT ${GL_MR}`]: { body: { title: "Fix parser" } },
      "linear:issue": issueRead({ state: IN_REVIEW, labels: ["ready-for-review"] }),
    });

    const results = await shipFactoryPullRequest({ ...gitlab, publishProject }, TICKET, depsFor(fetchImpl));

    assert.deepStrictEqual(results, [
      { step: "undraft", changed: true },
      { step: "linear-state", changed: false },
      { step: "linear-label", changed: false },
    ]);
    const put = only(calls, `PUT ${GL_MR}`);
    assert.equal(put.url, GL_MR);
    assert.ok(!put.url.includes("%252F"));
    assert.deepStrictEqual(parseBody(put), { title: "Fix parser" });
    assert.equal(put.headers["private-token"], FORGE_TOKEN);
    assert.ok(!("authorization" in put.headers));
    assert.equal(calls.filter((call) => call.url.startsWith("https://api.github.com")).length, 0);
  });
}

test("a GitLab WIP prefix is stripped and a ready MR is left alone", async () => {
  const wip = fakeFetch({
    [`GET ${GL_MR}`]: { body: { draft: true, title: "WIP: Fix parser", state: "opened" } },
    [`PUT ${GL_MR}`]: { body: { title: "Fix parser" } },
    "linear:issue": issueRead({ state: IN_REVIEW, labels: ["ready-for-review"] }),
  });
  await shipFactoryPullRequest(gitlab, TICKET, depsFor(wip.fetchImpl));
  assert.deepStrictEqual(parseBody(only(wip.calls, `PUT ${GL_MR}`)), { title: "Fix parser" });

  const ready = fakeFetch({
    [`GET ${GL_MR}`]: { body: { draft: false, title: "Fix parser", state: "opened" } },
    "linear:issue": issueRead({ state: IN_REVIEW, labels: ["ready-for-review"] }),
  });
  const results = await shipFactoryPullRequest(gitlab, TICKET, depsFor(ready.fetchImpl));
  assert.deepStrictEqual(results[0], { step: "undraft", changed: false });
  assert.deepStrictEqual(keysOf(ready.calls), [`GET ${GL_MR}`, "linear:issue"]);
});

test("a lowercase GitLab draft prefix is stripped", async () => {
  const { fetchImpl, calls } = fakeFetch({
    [`GET ${GL_MR}`]: { body: { draft: true, title: "draft: Fix parser", state: "opened" } },
    [`PUT ${GL_MR}`]: { body: { title: "Fix parser" } },
    "linear:issue": issueRead({ state: IN_REVIEW, labels: ["ready-for-review"] }),
  });
  const results = await shipFactoryPullRequest(gitlab, TICKET, depsFor(fetchImpl));
  assert.deepStrictEqual(results, [
    { step: "undraft", changed: true },
    { step: "linear-state", changed: false },
    { step: "linear-label", changed: false },
  ]);
  assert.deepStrictEqual(parseBody(only(calls, `PUT ${GL_MR}`)), { title: "Fix parser" });
});

test("returning a GitHub PR comments, closes, comments in Linear, and moves to Auto-Triage", async () => {
  const { fetchImpl, calls } = fakeFetch({
    [`POST ${GH_ISSUE_COMMENTS}`]: { status: 201, body: { id: 1 } },
    [`GET ${GH_PULL}`]: { body: { draft: false, state: "open", merged: false } },
    [`PATCH ${GH_PULL}`]: { body: { state: "closed" } },
    "linear:issue": issueRead({ state: IN_REVIEW }),
    "linear:commentCreate": COMMENT_OK,
    "linear:issueUpdate": STATE_OK,
  });

  const results = await returnFactoryPullRequest(github, TICKET, "tests are red", depsFor(fetchImpl));

  assert.deepStrictEqual(results, [
    { step: "forge-comment", changed: true },
    { step: "close", changed: true },
    { step: "linear-comment", changed: true },
    { step: "linear-state", changed: true },
  ]);
  assert.deepStrictEqual(keysOf(calls), [
    `POST ${GH_ISSUE_COMMENTS}`,
    `GET ${GH_PULL}`,
    `PATCH ${GH_PULL}`,
    "linear:issue",
    "linear:commentCreate",
    "linear:issueUpdate",
  ]);
  assert.deepStrictEqual(parseBody(only(calls, `POST ${GH_ISSUE_COMMENTS}`)), {
    body: "Returned by the factory reviewer: tests are red",
  });
  const patch = only(calls, `PATCH ${GH_PULL}`);
  assert.deepStrictEqual(parseBody(patch), { state: "closed" });
  assert.equal(patch.headers["content-type"], "application/json");
  assert.equal(patch.headers.authorization, `Bearer ${FORGE_TOKEN}`);
  assert.equal(patch.headers.accept, "application/vnd.github+json");
  assert.ok(!("content-type" in only(calls, `GET ${GH_PULL}`).headers));
  assert.match(queryOf(only(calls, "linear:commentCreate")), /body: "Returned to Auto-Triage: tests are red"/);
  assert.match(queryOf(only(calls, "linear:issueUpdate")), /stateId: "st_triage"/);
});

test("a merged pull request is commented on but never closed", async () => {
  const merged = fakeFetch({
    [`POST ${GH_ISSUE_COMMENTS}`]: { body: { id: 1 } },
    [`GET ${GH_PULL}`]: { body: { draft: false, state: "closed", merged: true } },
    "linear:issue": issueRead({ state: IN_REVIEW }),
    "linear:commentCreate": COMMENT_OK,
    "linear:issueUpdate": STATE_OK,
  });
  const results = await returnFactoryPullRequest(github, TICKET, "already merged", depsFor(merged.fetchImpl));
  assert.deepStrictEqual(results, [
    { step: "forge-comment", changed: true },
    { step: "close", changed: false, detail: "merged" },
    { step: "linear-comment", changed: true },
    { step: "linear-state", changed: true },
  ]);
  assert.equal(merged.calls.filter((call) => call.method === "PATCH").length, 0);

  const mergedGitlab = fakeFetch({
    [`POST ${GL_MR}/notes`]: { body: { id: 1 } },
    [`GET ${GL_MR}`]: { body: { draft: false, state: "merged" } },
    "linear:issue": issueRead({ state: IN_REVIEW }),
    "linear:commentCreate": COMMENT_OK,
    "linear:issueUpdate": STATE_OK,
  });
  const gitlabResults = await returnFactoryPullRequest(
    gitlab,
    TICKET,
    "already merged",
    depsFor(mergedGitlab.fetchImpl),
  );
  assert.deepStrictEqual(gitlabResults[1], { step: "close", changed: false, detail: "merged" });
  assert.equal(mergedGitlab.calls.filter((call) => call.method === "PUT").length, 0);
});

test("an already-closed pull request is not closed again", async () => {
  const { fetchImpl, calls } = fakeFetch({
    [`POST ${GH_ISSUE_COMMENTS}`]: { body: { id: 1 } },
    [`GET ${GH_PULL}`]: { body: { draft: false, state: "closed", merged: false } },
    "linear:issue": issueRead({ state: AUTO_TRIAGE }),
    "linear:commentCreate": COMMENT_OK,
  });
  const results = await returnFactoryPullRequest(github, TICKET, "stale", depsFor(fetchImpl));
  assert.deepStrictEqual(results, [
    { step: "forge-comment", changed: true },
    { step: "close", changed: false },
    { step: "linear-comment", changed: true },
    { step: "linear-state", changed: false },
  ]);
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 0);
  assert.equal(calls.filter((call) => routeKey(call) === "linear:issueUpdate").length, 0);
});

test("returning without a ref touches no forge at all", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "linear:issue": issueRead({ state: IN_REVIEW }),
    "linear:commentCreate": COMMENT_OK,
    "linear:issueUpdate": STATE_OK,
  });
  const results = await returnFactoryPullRequest(null, TICKET, "no output", depsFor(fetchImpl));
  assert.deepStrictEqual(results, [
    { step: "linear-comment", changed: true },
    { step: "linear-state", changed: true },
  ]);
  for (const call of calls) assert.equal(new URL(call.url).hostname, "api.linear.app");
});

test("returning a GitLab merge request notes it and closes with state_event", async () => {
  const { fetchImpl, calls } = fakeFetch({
    [`POST ${GL_MR}/notes`]: { body: { id: 1 } },
    [`GET ${GL_MR}`]: { body: { draft: false, state: "opened" } },
    [`PUT ${GL_MR}`]: { body: { state: "closed" } },
    "linear:issue": issueRead({ state: IN_REVIEW }),
    "linear:commentCreate": COMMENT_OK,
    "linear:issueUpdate": STATE_OK,
  });
  await returnFactoryPullRequest(gitlab, TICKET, "tests are red", depsFor(fetchImpl));
  assert.deepStrictEqual(parseBody(only(calls, `POST ${GL_MR}/notes`)), {
    body: "Returned by the factory reviewer: tests are red",
  });
  assert.deepStrictEqual(parseBody(only(calls, `PUT ${GL_MR}`)), { state_event: "close" });
});

test("a reviewer note carrying a quote and a newline round-trips through the GraphQL literal", async () => {
  const note = 'he said "no"\nand walked out';
  const { fetchImpl, calls } = fakeFetch({
    "linear:issue": issueRead({ state: IN_REVIEW }),
    "linear:commentCreate": COMMENT_OK,
    "linear:issueUpdate": STATE_OK,
  });
  await returnFactoryPullRequest(null, TICKET, note, depsFor(fetchImpl));
  const query = queryOf(only(calls, "linear:commentCreate"));
  const literal = /body: ("(?:[^"\\]|\\.)*")/.exec(query)?.[1];
  assert.ok(literal !== undefined);
  assert.equal(JSON.parse(literal) as string, `Returned to Auto-Triage: ${note}`);
});

test("already-fixed comments the evidence and moves the ticket to Done", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "linear:issue": issueRead({ state: IN_REVIEW }),
    "linear:commentCreate": COMMENT_OK,
    "linear:issueUpdate": STATE_OK,
  });
  const results = await shipFactoryAlreadyFixed(TICKET, "fixed in abc1234 on main", depsFor(fetchImpl));
  assert.deepStrictEqual(results, [
    { step: "linear-comment", changed: true },
    { step: "linear-state", changed: true },
  ]);
  assert.match(queryOf(only(calls, "linear:commentCreate")), /body: "Already fixed\. fixed in abc1234 on main"/);
  assert.match(queryOf(only(calls, "linear:issueUpdate")), /stateId: "st_done"/);
  for (const call of calls) assert.equal(new URL(call.url).hostname, "api.linear.app");
});

test("already-fixed without evidence posts the bare sentence", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "linear:issue": issueRead({ state: IN_REVIEW }),
    "linear:commentCreate": COMMENT_OK,
    "linear:issueUpdate": STATE_OK,
  });
  await shipFactoryAlreadyFixed(TICKET, undefined, depsFor(fetchImpl));
  assert.match(queryOf(only(calls, "linear:commentCreate")), /body: "Already fixed\."/);
  assert.ok(!queryOf(only(calls, "linear:commentCreate")).includes("undefined"));
});

for (const state of [
  { id: "st_cancel", name: "Won't Do", type: "canceled" },
  { id: "st_shipped", name: "Shipped", type: "completed" },
]) {
  test(`already-fixed leaves a ${state.type} ticket in ${state.name}`, async () => {
    const { fetchImpl, calls } = fakeFetch({
      "linear:issue": issueRead({ state }),
      "linear:commentCreate": COMMENT_OK,
    });
    const results = await shipFactoryAlreadyFixed(TICKET, "seen already", depsFor(fetchImpl));
    assert.deepStrictEqual(results, [
      { step: "linear-comment", changed: true },
      { step: "linear-state", changed: false },
    ]);
    assert.equal(calls.filter((call) => routeKey(call) === "linear:issueUpdate").length, 0);
  });
}

test("already-fixed still moves a started state whose name merely looks terminal", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "linear:issue": issueRead({ state: { id: "st_dr", name: "Done Reviewing", type: "started" } }),
    "linear:commentCreate": COMMENT_OK,
    "linear:issueUpdate": STATE_OK,
  });
  const results = await shipFactoryAlreadyFixed(TICKET, undefined, depsFor(fetchImpl));
  assert.deepStrictEqual(results[1], { step: "linear-state", changed: true });
  assert.match(queryOf(only(calls, "linear:issueUpdate")), /stateId: "st_done"/);
});

test("a team missing the target workflow state fails loudly and stops the sequence", async () => {
  const ship = fakeFetch({
    [`GET ${GH_PULL}`]: { body: { draft: false, state: "open", merged: false } },
    "linear:issue": issueRead({ states: [AUTO_TRIAGE] }),
  });
  assert.match(
    await rejectionMessage(shipFactoryPullRequest(github, TICKET, depsFor(ship.fetchImpl))),
    /^linear_state_missing: In Review$/,
  );
  assert.equal(ship.calls.filter((call) => routeKey(call) === "linear:issueLabels").length, 0);

  const back = fakeFetch({
    "linear:issue": issueRead({ state: IN_REVIEW, states: [IN_REVIEW] }),
    "linear:commentCreate": COMMENT_OK,
  });
  assert.match(
    await rejectionMessage(returnFactoryPullRequest(null, TICKET, "note", depsFor(back.fetchImpl))),
    /^linear_state_missing: Auto-Triage$/,
  );

  const fixed = fakeFetch({
    "linear:issue": issueRead({ state: IN_REVIEW, states: [AUTO_TRIAGE, IN_REVIEW] }),
    "linear:commentCreate": COMMENT_OK,
  });
  assert.match(
    await rejectionMessage(shipFactoryAlreadyFixed(TICKET, undefined, depsFor(fixed.fetchImpl))),
    /^linear_state_missing: Done$/,
  );
});

test("an unknown ready-for-review label fails loudly and adds nothing", async () => {
  const { fetchImpl, calls } = fakeFetch({
    [`GET ${GH_PULL}`]: { body: { draft: false, state: "open", merged: false } },
    "linear:issue": issueRead({ state: IN_REVIEW }),
    "linear:issueLabels": ok({ issueLabels: { nodes: [] } }),
  });
  assert.match(
    await rejectionMessage(shipFactoryPullRequest(github, TICKET, depsFor(fetchImpl))),
    /^linear_label_missing: ready-for-review$/,
  );
  assert.equal(calls.filter((call) => routeKey(call) === "linear:issueAddLabel").length, 0);
});

test("a forge 403 throws with the status, leaks no secret, and reaches no Linear call", async () => {
  const { fetchImpl, calls } = fakeFetch({
    [`GET ${GH_PULL}`]: { status: 403, body: { message: "Forbidden" } },
  });
  const message = await rejectionMessage(shipFactoryPullRequest(github, TICKET, depsFor(fetchImpl)));
  assert.equal(message, "forge_undraft_failed: 403");
  assertSecretFree(message);
  assert.equal(calls.filter((call) => call.url === LINEAR_URL).length, 0);
});

test("a Linear 500 throws with the status and leaks no secret", async () => {
  const { fetchImpl } = fakeFetch({ "linear:issue": { status: 500, body: {} } });
  const message = await rejectionMessage(shipFactoryAlreadyFixed(TICKET, undefined, depsFor(fetchImpl)));
  assert.equal(message, "linear_read_failed: 500");
  assertSecretFree(message);
});

test("a GraphQL errors array on a 200 throws on either endpoint", async () => {
  const linear = fakeFetch({ "linear:issue": { body: { errors: [{ message: "boom" }] } } });
  assert.equal(
    await rejectionMessage(shipFactoryAlreadyFixed(TICKET, undefined, depsFor(linear.fetchImpl))),
    "linear_read_failed: boom",
  );

  const forge = fakeFetch({
    [`GET ${GH_PULL}`]: { body: { draft: true, node_id: "PR_kwDOnode7", state: "open", merged: false } },
    "github:graphql": { body: { errors: [{ message: "not a draft" }] } },
  });
  assert.equal(
    await rejectionMessage(shipFactoryPullRequest(github, TICKET, depsFor(forge.fetchImpl))),
    "forge_undraft_failed: not a draft",
  );
});

test("a forge path is joined to the forge base, so the forge token can never reach another host", async () => {
  const selfHosted = "https://gitlab.example.com/api/v4/projects/9/merge_requests/1";
  const { fetchImpl, calls } = fakeFetch({ [`GET ${GL_BASE}${selfHosted}`]: { body: {} } });
  await forgeRequest(gitlab, depsFor(fetchImpl), "read", "GET", selfHosted);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]!.url).origin, "https://gitlab.com");
  assert.equal(calls[0]!.headers["private-token"], FORGE_TOKEN);
});

test("the GitHub GraphQL undraft accepts any 2xx and reports a non-2xx status", async () => {
  const accepted = fakeFetch({
    [`GET ${GH_PULL}`]: { body: { draft: true, node_id: "PR_kwDOnode7", state: "open", merged: false } },
    "github:graphql": { ...READY_MUTATION, status: 202 },
    "linear:issue": issueRead({ state: IN_REVIEW, labels: ["ready-for-review"] }),
  });
  const results = await shipFactoryPullRequest(github, TICKET, depsFor(accepted.fetchImpl));
  assert.deepStrictEqual(results[0], { step: "undraft", changed: true });

  const rejected = fakeFetch({
    [`GET ${GH_PULL}`]: { body: { draft: true, node_id: "PR_kwDOnode7", state: "open", merged: false } },
    "github:graphql": { status: 502, body: {} },
  });
  const message = await rejectionMessage(shipFactoryPullRequest(github, TICKET, depsFor(rejected.fetchImpl)));
  assert.equal(message, "forge_undraft_failed: 502");
  assertSecretFree(message);
});

test("an empty errors array is not a failure", async () => {
  const { fetchImpl } = fakeFetch({
    "linear:issue": { body: { errors: [], ...(issueRead({ state: IN_REVIEW }).body as Record<string, unknown>) } },
    "linear:commentCreate": { body: { errors: [], data: { commentCreate: { success: true } } } },
    "linear:issueUpdate": { body: { errors: [], data: { issueUpdate: { success: true } } } },
  });
  const results = await shipFactoryAlreadyFixed(TICKET, undefined, depsFor(fetchImpl));
  assert.deepStrictEqual(results, [
    { step: "linear-comment", changed: true },
    { step: "linear-state", changed: true },
  ]);
});

test("a Linear personal API key is sent verbatim in Authorization, never as a Bearer token", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "linear:issue": issueRead({ state: IN_REVIEW }),
    "linear:commentCreate": COMMENT_OK,
    "linear:issueUpdate": STATE_OK,
  });
  await shipFactoryAlreadyFixed(TICKET, undefined, depsFor(fetchImpl));
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url, LINEAR_URL);
    assert.equal(call.headers.authorization, LINEAR_KEY);
    assert.equal(call.headers["content-type"], "application/json");
  }
});

test("deps without a fetch fall back to globalThis.fetch at call time", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "linear:issue": issueRead({ state: IN_REVIEW }),
    "linear:commentCreate": COMMENT_OK,
    "linear:issueUpdate": STATE_OK,
  });
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const results = await shipFactoryAlreadyFixed(TICKET, "no injected fetch", {
      forgeToken: FORGE_TOKEN,
      linearApiKey: LINEAR_KEY,
    });
    assert.equal(results.length, 2);
    assert.deepStrictEqual(keysOf(calls), ["linear:issue", "linear:commentCreate", "linear:issueUpdate"]);
  } finally {
    globalThis.fetch = original;
  }
});
