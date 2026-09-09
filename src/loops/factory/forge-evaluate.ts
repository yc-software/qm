import type { SuccessCheckResult, SuccessVerdict } from "../success-evaluation.ts";

const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL = "https://api.github.com/graphql";
const GITLAB_API = "https://gitlab.com/api/v4";
const PAGE_SIZE = 100;
const PAGE = `per_page=${PAGE_SIZE}`;
const GITHUB_MERGEABLE_STATES = new Set(["clean", "unstable", "has_hooks"]);
const GITHUB_GREEN_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);
const BUGBOT_LOGIN_PREFIX = "cursor";
const BUGBOT_NOTE_MARKER = "BUGBOT_REVIEW";

export interface ForgeEvaluateInput {
  fetch?: typeof globalThis.fetch;
  forge: "github" | "gitlab";
  publishProject: string;
  forgeToken: string;
  number: number;
  branch: string;
  bugbotRequired: boolean;
}

export const FORGE_CHECKS = ["exact_head", "ci_green_on_head", "ledger_clean", "mergeable", "bugbot_reviewed"] as const;

type ForgeCheck = (typeof FORGE_CHECKS)[number];

interface CheckOutcome {
  passed: boolean;
  detail?: string;
}

const isObj = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const obj = (value: unknown): Record<string, unknown> => (isObj(value) ? value : {});

const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const gql = (value: string): string => JSON.stringify(value);

const failed = (detail: string): Error => new Error(`forge_evaluate_failed: ${detail}`);

const graphqlError = (body: unknown): string | undefined => {
  const errors = obj(body).errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  return str(obj(errors[0]).message) ?? "graphql_error";
};

const forgeBase = (input: ForgeEvaluateInput): string =>
  input.forge === "github"
    ? `${GITHUB_API}/repos/${input.publishProject}`
    : `${GITLAB_API}/projects/${encodeURIComponent(input.publishProject.replace(/%2F/gi, "/"))}`;

const forgeHeaders = (input: ForgeEvaluateInput): Record<string, string> =>
  input.forge === "github"
    ? { Authorization: `Bearer ${input.forgeToken}`, Accept: "application/vnd.github+json" }
    : { "PRIVATE-TOKEN": input.forgeToken };

async function readJson(input: ForgeEvaluateInput, url: string, init: RequestInit): Promise<unknown> {
  const doFetch = input.fetch ?? globalThis.fetch;
  const response = await doFetch(url, init);
  if (response.status < 200 || response.status > 299) throw failed(String(response.status));
  const parsed: unknown = await response.json();
  const message = graphqlError(parsed);
  if (message !== undefined) throw failed(message);
  return parsed;
}

const forgeGet = (input: ForgeEvaluateInput, path: string): Promise<unknown> =>
  readJson(input, `${forgeBase(input)}${path}`, { method: "GET", headers: forgeHeaders(input) });

const githubGraphql = (input: ForgeEvaluateInput, query: string): Promise<unknown> =>
  readJson(input, GITHUB_GRAPHQL, {
    method: "POST",
    headers: { ...forgeHeaders(input), "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

const notesOf = (discussions: unknown[]): Record<string, unknown>[] =>
  discussions.flatMap((discussion) => arr(obj(discussion).notes).map(obj));

const unresolvedDetail = (count: number): CheckOutcome =>
  count === 0 ? { passed: true } : { passed: false, detail: `${count} unresolved` };

export async function evaluateFactoryForge(input: ForgeEvaluateInput): Promise<SuccessVerdict> {
  const github = input.forge === "github";
  const request = obj(await forgeGet(input, github ? `/pulls/${input.number}` : `/merge_requests/${input.number}`));
  const headSha = (github ? str(obj(request.head).sha) : str(request.sha)) ?? "";

  let discussions: unknown[] | undefined;
  const readDiscussions = async (): Promise<unknown[]> => {
    discussions ??= arr(await forgeGet(input, `/merge_requests/${input.number}/discussions?${PAGE}`));
    return discussions;
  };

  const exactHead = async (): Promise<CheckOutcome> => {
    const path = github ? `/branches/${input.branch}` : `/repository/branches/${encodeURIComponent(input.branch)}`;
    const commit = obj(obj(await forgeGet(input, path)).commit);
    const branchSha = (github ? str(commit.sha) : str(commit.id)) ?? "";
    if (headSha !== "" && headSha === branchSha) return { passed: true };
    return { passed: false, detail: `${headSha} != ${branchSha}` };
  };

  const ciGreenOnHead = async (): Promise<CheckOutcome> => {
    if (github) {
      const payload = obj(await forgeGet(input, `/commits/${headSha}/check-runs?${PAGE}`));
      const runs = arr(payload.check_runs);
      if (runs.length === 0) return { passed: false, detail: "no check runs" };
      // A full page may hide runs on the next one, so the check fails closed rather than trusting the visible runs.
      if (runs.length >= PAGE_SIZE) return { passed: false, detail: "check runs exceed one page" };
      const offending = runs
        .map(obj)
        .find((run) => run.status !== "completed" || !GITHUB_GREEN_CONCLUSIONS.has(str(run.conclusion) ?? ""));
      if (offending === undefined) return { passed: true };
      return { passed: false, detail: str(offending.name) ?? "unnamed check run" };
    }
    // GitLab merged-result pipelines run on a temporary merge commit, so the MR's head_pipeline is the
    // only pointer that survives that sha mismatch.
    const pipeline = obj(request.head_pipeline);
    if (Object.keys(pipeline).length === 0) return { passed: false, detail: "no pipeline" };
    const status = str(pipeline.status) ?? "unknown";
    return status === "success" ? { passed: true } : { passed: false, detail: status };
  };

  const ledgerClean = async (): Promise<CheckOutcome> => {
    if (github) {
      const [owner = "", name = ""] = input.publishProject.split("/");
      const data = await githubGraphql(
        input,
        `query { repository(owner: ${gql(owner)}, name: ${gql(name)}) { pullRequest(number: ${input.number}) { reviewThreads(first: ${PAGE_SIZE}) { pageInfo { hasNextPage } nodes { isResolved } } } } }`,
      );
      const connection = obj(obj(obj(obj(obj(data).data).repository).pullRequest).reviewThreads);
      if (obj(connection.pageInfo).hasNextPage === true)
        return { passed: false, detail: "review threads exceed one page" };
      const threads = arr(connection.nodes);
      return unresolvedDetail(threads.filter((thread) => obj(thread).isResolved !== true).length);
    }
    const all = await readDiscussions();
    if (all.length >= PAGE_SIZE) return { passed: false, detail: "discussions exceed one page" };
    const open = notesOf(all).filter((note) => note.resolvable === true && note.resolved === false);
    return unresolvedDetail(open.length);
  };

  const mergeable = async (): Promise<CheckOutcome> => {
    if (github) {
      const state = str(request.mergeable_state) ?? "unknown";
      if (request.mergeable === true && GITHUB_MERGEABLE_STATES.has(state)) return { passed: true };
      return { passed: false, detail: state };
    }
    const status = str(request.detailed_merge_status) ?? "unknown";
    return status === "mergeable" ? { passed: true } : { passed: false, detail: status };
  };

  const bugbotReviewed = async (): Promise<CheckOutcome> => {
    if (!input.bugbotRequired) return { passed: true, detail: "not required" };
    const reviewed = github
      ? arr(await forgeGet(input, `/pulls/${input.number}/reviews?${PAGE}`))
          .map(obj)
          .some(
            (review) =>
              (str(obj(review.user).login) ?? "").toLowerCase().startsWith(BUGBOT_LOGIN_PREFIX) &&
              headSha !== "" &&
              str(review.commit_id) === headSha,
          )
      : notesOf(await readDiscussions()).some((note) => {
          const body = str(note.body) ?? "";
          const author = obj(note.author);
          const fromBugbot = [str(author.name), str(author.username)].some((name) =>
            (name ?? "").toLowerCase().startsWith(BUGBOT_LOGIN_PREFIX),
          );
          return fromBugbot && body.includes(BUGBOT_NOTE_MARKER) && headSha !== "" && body.includes(headSha);
        });
    return reviewed ? { passed: true } : { passed: false, detail: `no bugbot review on ${headSha}` };
  };

  const runners: Record<ForgeCheck, () => Promise<CheckOutcome>> = {
    exact_head: exactHead,
    ci_green_on_head: ciGreenOnHead,
    ledger_clean: ledgerClean,
    mergeable,
    bugbot_reviewed: bugbotReviewed,
  };

  const checks: SuccessCheckResult[] = [];
  for (const name of FORGE_CHECKS) {
    const { passed, detail } = await runners[name]();
    checks.push({ command: name, passed, ...(detail === undefined ? {} : { detail }) });
    if (!passed) {
      const reason = detail === undefined ? `check failed: ${name}` : `check failed: ${name} — ${detail}`;
      return { outcome: "continue", reason, checks, judged: false };
    }
  }
  return { outcome: "met", reason: "converged", checks, judged: false };
}
