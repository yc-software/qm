import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateFactoryForge, FORGE_CHECKS, type ForgeEvaluateInput } from "../src/loops/factory/forge-evaluate.ts";

const TOKEN = "ght_FAKE_TOKEN";
const BRANCH = "fix/qm-12";
const HEAD = "1111111111111111111111111111111111111111";
const OLD = "2222222222222222222222222222222222222222";

const GH_REPO = "https://api.github.com/repos/acme/app";
const GH = {
  pr: `GET ${GH_REPO}/pulls/42`,
  branch: `GET ${GH_REPO}/branches/${BRANCH}`,
  checkRuns: `GET ${GH_REPO}/commits/${HEAD}/check-runs?per_page=100`,
  graphql: "POST https://api.github.com/graphql",
  reviews: `GET ${GH_REPO}/pulls/42/reviews?per_page=100`,
};

const GL_PROJECT = "https://gitlab.com/api/v4/projects/acme%2Fapp";
const GL = {
  mr: `GET ${GL_PROJECT}/merge_requests/42`,
  branch: `GET ${GL_PROJECT}/repository/branches/fix%2Fqm-12`,
  discussions: `GET ${GL_PROJECT}/merge_requests/42/discussions?per_page=100`,
};

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

const keyOf = (rec: Recorded): string => `${rec.method} ${rec.url}`;

function fakeFetch(routes: Record<string, Route>): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    const rec: Recorded = {
      url: String(url),
      method: init?.method ?? "GET",
      headers,
      ...(init?.body === undefined ? {} : { body: String(init.body) }),
    };
    calls.push(rec);
    const route = routes[keyOf(rec)];
    if (route === undefined) throw new Error(`unscripted route: ${keyOf(rec)}`);
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const keysOf = (calls: Recorded[]): string[] => calls.map(keyOf);

const threadsBody = (resolved: boolean[]): Route => ({
  body: {
    data: { repository: { pullRequest: { reviewThreads: { nodes: resolved.map((isResolved) => ({ isResolved })) } } } },
  },
});

const githubRoutes = (over: Record<string, Route> = {}): Record<string, Route> => ({
  [GH.pr]: { body: { head: { sha: HEAD }, mergeable: true, mergeable_state: "clean" } },
  [GH.branch]: { body: { commit: { sha: HEAD } } },
  [GH.checkRuns]: {
    body: {
      check_runs: [
        { name: "test", status: "completed", conclusion: "success" },
        { name: "lint", status: "completed", conclusion: "skipped" },
      ],
    },
  },
  [GH.graphql]: threadsBody([true, true]),
  [GH.reviews]: { body: [{ user: { login: "cursor[bot]" }, commit_id: HEAD }] },
  ...over,
});

const gitlabRoutes = (over: Record<string, Route> = {}): Record<string, Route> => ({
  [GL.mr]: {
    body: { sha: HEAD, detailed_merge_status: "mergeable", head_pipeline: { id: 9, sha: HEAD, status: "success" } },
  },
  [GL.branch]: { body: { commit: { id: HEAD } } },
  [GL.discussions]: {
    body: [
      { notes: [{ body: "nit", resolvable: true, resolved: true }] },
      {
        notes: [
          {
            body: `BUGBOT_REVIEW clean on ${HEAD}`,
            resolvable: false,
            resolved: false,
            author: { name: "cursor", username: "project_1_bot_abc" },
          },
        ],
      },
    ],
  },
  ...over,
});

const githubInput = (fetchImpl: typeof fetch, over: Partial<ForgeEvaluateInput> = {}): ForgeEvaluateInput => ({
  fetch: fetchImpl,
  forge: "github",
  publishProject: "acme/app",
  forgeToken: TOKEN,
  number: 42,
  branch: BRANCH,
  bugbotRequired: true,
  ...over,
});

const gitlabInput = (fetchImpl: typeof fetch, over: Partial<ForgeEvaluateInput> = {}): ForgeEvaluateInput =>
  githubInput(fetchImpl, { forge: "gitlab", publishProject: "acme%2Fapp", ...over });

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected the call to reject");
}

test("a converged GitHub pull request meets the condition on forge reads alone", async () => {
  const fetched = fakeFetch(githubRoutes());

  const verdict = await evaluateFactoryForge(githubInput(fetched.fetchImpl));

  assert.equal(verdict.outcome, "met");
  assert.equal(verdict.reason, "converged");
  assert.equal(verdict.judged, false);
  assert.deepEqual(
    verdict.checks.map((check) => check.command),
    [...FORGE_CHECKS],
  );
  assert.deepEqual(
    verdict.checks.map((check) => check.passed),
    FORGE_CHECKS.map(() => true),
  );
  assert.equal(keysOf(fetched.calls).filter((key) => key === GH.pr).length, 1);
  const graphql = fetched.calls.find((call) => keyOf(call) === GH.graphql);
  const query = String((JSON.parse(graphql?.body ?? "{}") as { query?: string }).query);
  assert.match(query, /repository\(owner: "acme", name: "app"\)/);
  assert.match(query, /pullRequest\(number: 42\) \{ reviewThreads\(first: 100\)/);
  assert.equal(graphql?.headers["content-type"], "application/json");
  for (const call of fetched.calls) {
    assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.headers.accept, "application/vnd.github+json");
    assert.equal("private-token" in call.headers, false);
  }
});

test("an unstable or hooked GitHub merge state still converges", async () => {
  for (const state of ["unstable", "has_hooks"]) {
    const fetched = fakeFetch(
      githubRoutes({ [GH.pr]: { body: { head: { sha: HEAD }, mergeable: true, mergeable_state: state } } }),
    );
    const verdict = await evaluateFactoryForge(githubInput(fetched.fetchImpl));
    assert.equal(verdict.outcome, "met", state);
  }
});

test("bugbot_reviewed passes as not required without reading the reviews", async () => {
  const fetched = fakeFetch(githubRoutes());

  const verdict = await evaluateFactoryForge(githubInput(fetched.fetchImpl, { bugbotRequired: false }));

  assert.equal(verdict.outcome, "met");
  assert.deepEqual(verdict.checks[4], { command: "bugbot_reviewed", passed: true, detail: "not required" });
  assert.equal(
    keysOf(fetched.calls).some((key) => key.endsWith("/reviews?per_page=100")),
    false,
  );
});

const GITHUB_FAILURES: {
  name: string;
  detail: string;
  routes: Record<string, Route>;
  reads: string[];
}[] = [
  {
    name: "exact_head",
    detail: `${HEAD} != ${OLD}`,
    routes: { [GH.branch]: { body: { commit: { sha: OLD } } } },
    reads: [GH.pr, GH.branch],
  },
  {
    name: "exact_head",
    detail: " != ",
    routes: { [GH.pr]: { body: {} }, [GH.branch]: { body: {} } },
    reads: [GH.pr, GH.branch],
  },
  {
    name: "ci_green_on_head",
    detail: "no check runs",
    routes: { [GH.checkRuns]: { body: { check_runs: [] } } },
    reads: [GH.pr, GH.branch, GH.checkRuns],
  },
  {
    name: "ci_green_on_head",
    detail: "slow-suite",
    routes: {
      [GH.checkRuns]: {
        body: {
          check_runs: [
            { name: "test", status: "completed", conclusion: "success" },
            { name: "slow-suite", status: "in_progress", conclusion: null },
          ],
        },
      },
    },
    reads: [GH.pr, GH.branch, GH.checkRuns],
  },
  {
    name: "ci_green_on_head",
    detail: "test",
    routes: {
      [GH.checkRuns]: { body: { check_runs: [{ name: "test", status: "completed", conclusion: "failure" }] } },
    },
    reads: [GH.pr, GH.branch, GH.checkRuns],
  },
  {
    name: "ledger_clean",
    detail: "2 unresolved",
    routes: { [GH.graphql]: threadsBody([true, false, false]) },
    reads: [GH.pr, GH.branch, GH.checkRuns, GH.graphql],
  },
  {
    name: "mergeable",
    detail: "blocked",
    routes: { [GH.pr]: { body: { head: { sha: HEAD }, mergeable: true, mergeable_state: "blocked" } } },
    reads: [GH.pr, GH.branch, GH.checkRuns, GH.graphql],
  },
  {
    name: "mergeable",
    detail: "unknown",
    routes: { [GH.pr]: { body: { head: { sha: HEAD }, mergeable: null, mergeable_state: "unknown" } } },
    reads: [GH.pr, GH.branch, GH.checkRuns, GH.graphql],
  },
  {
    name: "bugbot_reviewed",
    detail: `no bugbot review on ${HEAD}`,
    routes: { [GH.reviews]: { body: [{ user: { login: "cursor[bot]" }, commit_id: OLD }] } },
    reads: [GH.pr, GH.branch, GH.checkRuns, GH.graphql, GH.reviews],
  },
  {
    name: "bugbot_reviewed",
    detail: `no bugbot review on ${HEAD}`,
    routes: { [GH.reviews]: { body: [{ user: { login: "a-human" }, commit_id: HEAD }] } },
    reads: [GH.pr, GH.branch, GH.checkRuns, GH.graphql, GH.reviews],
  },
];

test("each failing GitHub check stops the sequence at that check and names it", async () => {
  for (const scenario of GITHUB_FAILURES) {
    const label = `${scenario.name} — ${scenario.detail}`;
    const fetched = fakeFetch(githubRoutes(scenario.routes));

    const verdict = await evaluateFactoryForge(githubInput(fetched.fetchImpl));

    assert.equal(verdict.outcome, "continue", label);
    assert.equal(verdict.reason, `check failed: ${scenario.name} — ${scenario.detail}`, label);
    assert.equal(verdict.judged, false, label);
    const position = FORGE_CHECKS.indexOf(scenario.name as (typeof FORGE_CHECKS)[number]) + 1;
    assert.deepEqual(
      verdict.checks.map((check) => check.command),
      FORGE_CHECKS.slice(0, position),
      label,
    );
    assert.deepEqual(
      verdict.checks.map((check) => check.passed),
      FORGE_CHECKS.slice(0, position).map((_name, index) => index < position - 1),
      label,
    );
    assert.equal(verdict.checks[position - 1]?.detail, scenario.detail, label);
    assert.deepEqual(keysOf(fetched.calls), scenario.reads, label);
  }
});

test("a converged GitLab merge request meets the condition on its own endpoints", async () => {
  const fetched = fakeFetch(gitlabRoutes());

  const verdict = await evaluateFactoryForge(gitlabInput(fetched.fetchImpl));

  assert.equal(verdict.outcome, "met");
  assert.deepEqual(keysOf(fetched.calls), [GL.mr, GL.branch, GL.discussions]);
  for (const call of fetched.calls) {
    assert.equal(call.headers["private-token"], TOKEN);
    assert.equal("authorization" in call.headers, false);
    assert.equal(call.url.includes("%252F"), false);
  }
});

test("the merge request's head_pipeline decides ci_green_on_head, whatever sha it ran on", async () => {
  const mergedResult = fakeFetch(
    gitlabRoutes({
      [GL.mr]: {
        body: { sha: HEAD, detailed_merge_status: "mergeable", head_pipeline: { id: 9, sha: OLD, status: "success" } },
      },
    }),
  );
  assert.equal((await evaluateFactoryForge(gitlabInput(mergedResult.fetchImpl))).outcome, "met");

  const red = fakeFetch(
    gitlabRoutes({
      [GL.mr]: {
        body: { sha: HEAD, detailed_merge_status: "mergeable", head_pipeline: { id: 9, sha: HEAD, status: "failed" } },
      },
    }),
  );
  const verdict = await evaluateFactoryForge(gitlabInput(red.fetchImpl));
  assert.equal(verdict.reason, "check failed: ci_green_on_head — failed");

  const absent = fakeFetch(
    gitlabRoutes({ [GL.mr]: { body: { sha: HEAD, detailed_merge_status: "mergeable", head_pipeline: null } } }),
  );
  assert.equal(
    (await evaluateFactoryForge(gitlabInput(absent.fetchImpl))).reason,
    "check failed: ci_green_on_head — no pipeline",
  );
});

test("a truncated page fails ci_green_on_head and ledger_clean closed instead of trusting the visible part", async () => {
  const manyRuns = fakeFetch(
    githubRoutes({
      [GH.checkRuns]: {
        body: {
          check_runs: Array.from({ length: 100 }, (_, i) => ({
            name: `check-${i}`,
            status: "completed",
            conclusion: "success",
          })),
        },
      },
    }),
  );
  assert.equal(
    (await evaluateFactoryForge(githubInput(manyRuns.fetchImpl))).reason,
    "check failed: ci_green_on_head — check runs exceed one page",
  );

  const manyThreads = fakeFetch(
    githubRoutes({
      [GH.graphql]: {
        body: {
          data: {
            repository: {
              pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [{ isResolved: true }] } },
            },
          },
        },
      },
    }),
  );
  assert.equal(
    (await evaluateFactoryForge(githubInput(manyThreads.fetchImpl))).reason,
    "check failed: ledger_clean — review threads exceed one page",
  );

  const manyDiscussions = fakeFetch(
    gitlabRoutes({
      [GL.discussions]: {
        body: Array.from({ length: 100 }, () => ({ notes: [{ body: "ok", resolvable: true, resolved: true }] })),
      },
    }),
  );
  assert.equal(
    (await evaluateFactoryForge(gitlabInput(manyDiscussions.fetchImpl))).reason,
    "check failed: ledger_clean — discussions exceed one page",
  );
});

test("only a resolvable, unresolved GitLab note fails ledger_clean", async () => {
  const open = fakeFetch(
    gitlabRoutes({
      [GL.discussions]: {
        body: [{ notes: [{ body: "please fix", resolvable: true, resolved: false }] }],
      },
    }),
  );
  assert.equal(
    (await evaluateFactoryForge(gitlabInput(open.fetchImpl))).reason,
    "check failed: ledger_clean — 1 unresolved",
  );

  const chatter = fakeFetch(
    gitlabRoutes({
      [GL.discussions]: {
        body: [
          { notes: [{ body: "just a comment", resolvable: false, resolved: false }] },
          {
            notes: [
              {
                body: `BUGBOT_REVIEW clean on ${HEAD}`,
                resolvable: false,
                resolved: false,
                author: { name: "cursor", username: "project_1_bot_abc" },
              },
            ],
          },
        ],
      },
    }),
  );
  assert.equal((await evaluateFactoryForge(gitlabInput(chatter.fetchImpl))).outcome, "met");
});

test("GitLab mergeable and bugbot_reviewed read the merge status and the discussions already fetched", async () => {
  const checking = fakeFetch(
    gitlabRoutes({
      [GL.mr]: {
        body: { sha: HEAD, detailed_merge_status: "checking", head_pipeline: { id: 9, sha: HEAD, status: "success" } },
      },
    }),
  );
  assert.equal(
    (await evaluateFactoryForge(gitlabInput(checking.fetchImpl))).reason,
    "check failed: mergeable — checking",
  );

  const stale = fakeFetch(
    gitlabRoutes({
      [GL.discussions]: {
        body: [
          {
            notes: [
              {
                body: `BUGBOT_REVIEW clean on ${OLD}`,
                resolvable: false,
                author: { name: "cursor", username: "project_1_bot_abc" },
              },
            ],
          },
        ],
      },
    }),
  );
  const verdict = await evaluateFactoryForge(gitlabInput(stale.fetchImpl));
  assert.equal(verdict.reason, `check failed: bugbot_reviewed — no bugbot review on ${HEAD}`);
  assert.equal(keysOf(stale.calls).filter((key) => key === GL.discussions).length, 1);
});

test("a GitLab BUGBOT_REVIEW note from a human does not satisfy bugbot_reviewed", async () => {
  const human = fakeFetch(
    gitlabRoutes({
      [GL.discussions]: {
        body: [
          {
            notes: [
              {
                body: `BUGBOT_REVIEW clean on ${HEAD}`,
                resolvable: false,
                resolved: false,
                author: { name: "Paul", username: "pcap" },
              },
            ],
          },
        ],
      },
    }),
  );
  assert.equal(
    (await evaluateFactoryForge(gitlabInput(human.fetchImpl))).reason,
    `check failed: bugbot_reviewed — no bugbot review on ${HEAD}`,
  );
});

test("a GitLab branch with a slash is encoded once in its own segment", async () => {
  const fetched = fakeFetch(gitlabRoutes());
  await evaluateFactoryForge(gitlabInput(fetched.fetchImpl));
  assert.equal(keysOf(fetched.calls)[1], GL.branch);

  const gh = fakeFetch(githubRoutes());
  await evaluateFactoryForge(githubInput(gh.fetchImpl));
  assert.equal(keysOf(gh.calls)[1], `GET ${GH_REPO}/branches/fix/qm-12`);
});

test("a forge failure throws forge_evaluate_failed without the token or the project", async () => {
  const denied = fakeFetch(githubRoutes({ [GH.pr]: { status: 403, body: { message: "Forbidden" } } }));
  const error = await rejection(evaluateFactoryForge(githubInput(denied.fetchImpl)));
  assert.equal(error.message, "forge_evaluate_failed: 403");
  assert.equal(error.message.includes(TOKEN), false);
  assert.equal(error.message.includes("acme/app"), false);

  const graphql = fakeFetch(githubRoutes({ [GH.graphql]: { body: { errors: [{ message: "Bad credentials" }] } } }));
  assert.equal(
    (await rejection(evaluateFactoryForge(githubInput(graphql.fetchImpl)))).message,
    "forge_evaluate_failed: Bad credentials",
  );

  const gitlabDenied = fakeFetch(gitlabRoutes({ [GL.discussions]: { status: 403, body: {} } }));
  const gitlabError = await rejection(evaluateFactoryForge(gitlabInput(gitlabDenied.fetchImpl)));
  assert.equal(gitlabError.message, "forge_evaluate_failed: 403");
  assert.equal(gitlabError.message.includes(TOKEN), false);
});
