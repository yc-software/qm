const GITHUB_API = "https://api.github.com";
const GITHUB_GRAPHQL = "https://api.github.com/graphql";
const GITLAB_API = "https://gitlab.com/api/v4";
const LINEAR_GRAPHQL = "https://api.linear.app/graphql";

const STATE_IN_REVIEW = "In Review";
const STATE_AUTO_TRIAGE = "Auto-Triage";
const STATE_DONE = "Done";
const LABEL_READY = "ready-for-review";
const TERMINAL_STATE_TYPES = new Set(["completed", "canceled"]);
const DRAFT_TITLE_PREFIX = /^(Draft|WIP):\s*/i;

export interface ForgeRef {
  forge: "github" | "gitlab";
  publishProject: string;
  number: number;
}

export interface ShipDeps {
  fetch?: typeof globalThis.fetch;
  forgeToken: string;
  linearApiKey: string;
}

export interface ShipStepResult {
  step: string;
  changed: boolean;
  detail?: string;
}

const isObj = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const obj = (value: unknown): Record<string, unknown> => (isObj(value) ? value : {});

const nodes = (value: unknown): unknown[] => {
  const list = obj(value).nodes;
  return Array.isArray(list) ? list : [];
};

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const gql = (value: string): string => JSON.stringify(value);

const graphqlError = (body: unknown): string | undefined => {
  const errors = obj(body).errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  return str(obj(errors[0]).message) ?? "graphql_error";
};

const forgeBase = (ref: ForgeRef): string =>
  ref.forge === "github"
    ? `${GITHUB_API}/repos/${ref.publishProject}`
    : `${GITLAB_API}/projects/${encodeURIComponent(ref.publishProject.replace(/%2F/gi, "/"))}`;

export async function forgeRequest(
  ref: ForgeRef,
  deps: ShipDeps,
  slug: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const headers: Record<string, string> =
    ref.forge === "github"
      ? { Authorization: `Bearer ${deps.forgeToken}`, Accept: "application/vnd.github+json" }
      : { "PRIVATE-TOKEN": deps.forgeToken };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const doFetch = deps.fetch ?? globalThis.fetch;
  const response = await doFetch(`${forgeBase(ref)}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status < 200 || response.status > 299) throw new Error(`forge_${slug}_failed: ${response.status}`);
  const parsed: unknown = await response.json();
  const failure = graphqlError(parsed);
  if (failure !== undefined) throw new Error(`forge_${slug}_failed: ${failure}`);
  return parsed;
}

async function githubGraphql(deps: ShipDeps, slug: string, query: string): Promise<unknown> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const response = await doFetch(GITHUB_GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deps.forgeToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (response.status < 200 || response.status > 299) throw new Error(`forge_${slug}_failed: ${response.status}`);
  const parsed: unknown = await response.json();
  const failure = graphqlError(parsed);
  if (failure !== undefined) throw new Error(`forge_${slug}_failed: ${failure}`);
  return parsed;
}

async function linearGraphql(deps: ShipDeps, slug: string, query: string): Promise<Record<string, unknown>> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const response = await doFetch(LINEAR_GRAPHQL, {
    method: "POST",
    headers: { Authorization: deps.linearApiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (response.status < 200 || response.status > 299) throw new Error(`linear_${slug}_failed: ${response.status}`);
  const parsed: unknown = await response.json();
  const failure = graphqlError(parsed);
  if (failure !== undefined) throw new Error(`linear_${slug}_failed: ${failure}`);
  return obj(obj(parsed).data);
}

interface ForgePr {
  draft: boolean;
  open: boolean;
  merged: boolean;
  nodeId?: string;
  title?: string;
}

async function readForgePr(ref: ForgeRef, deps: ShipDeps, slug: string): Promise<ForgePr> {
  if (ref.forge === "github") {
    const pr = obj(await forgeRequest(ref, deps, slug, "GET", `/pulls/${ref.number}`));
    return { draft: pr.draft === true, open: pr.state === "open", merged: pr.merged === true, nodeId: str(pr.node_id) };
  }
  const mr = obj(await forgeRequest(ref, deps, slug, "GET", `/merge_requests/${ref.number}`));
  return { draft: mr.draft === true, open: mr.state === "opened", merged: mr.state === "merged", title: str(mr.title) };
}

interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
}

interface LinearLabel {
  id: string;
  name: string;
  groupId?: string;
}

interface LinearIssue {
  id: string;
  state: LinearWorkflowState;
  labels: LinearLabel[];
  teamStates: LinearWorkflowState[];
}

const linearLabel = (value: unknown): LinearLabel | undefined => {
  const label = obj(value);
  const id = str(label.id);
  const name = str(label.name);
  if (id === undefined || name === undefined) return undefined;
  const groupId = str(obj(label.parent).id);
  return { id, name, ...(groupId === undefined ? {} : { groupId }) };
};

const workflowState = (value: unknown): LinearWorkflowState => {
  const state = obj(value);
  return { id: str(state.id) ?? "", name: str(state.name) ?? "", type: str(state.type) ?? "" };
};

async function readLinearIssue(deps: ShipDeps, ticket: string): Promise<LinearIssue> {
  const data = await linearGraphql(
    deps,
    "read",
    `query { issue(id: ${gql(ticket)}) { id state { id name type } labels { nodes { id name parent { id } } } team { id states { nodes { id name type } } } } }`,
  );
  const issue = obj(data.issue);
  return {
    id: str(issue.id) ?? "",
    state: workflowState(issue.state),
    labels: nodes(issue.labels).flatMap((node) => {
      const label = linearLabel(node);
      return label === undefined ? [] : [label];
    }),
    teamStates: nodes(obj(issue.team).states).map(workflowState),
  };
}

async function moveLinearState(
  deps: ShipDeps,
  issue: LinearIssue,
  target: string,
  step: string,
): Promise<ShipStepResult> {
  if (issue.state.name === target) return { step, changed: false };
  const state = issue.teamStates.find((candidate) => candidate.name === target);
  if (state === undefined) throw new Error(`linear_state_missing: ${target}`);
  await linearGraphql(
    deps,
    "state",
    `mutation { issueUpdate(id: ${gql(issue.id)}, input: { stateId: ${gql(state.id)} }) { success } }`,
  );
  return { step, changed: true };
}

async function postLinearComment(
  deps: ShipDeps,
  issue: LinearIssue,
  body: string,
  step: string,
): Promise<ShipStepResult> {
  await linearGraphql(
    deps,
    "comment",
    `mutation { commentCreate(input: { issueId: ${gql(issue.id)}, body: ${gql(body)} }) { success } }`,
  );
  return { step, changed: true };
}

async function undraftForgePr(ref: ForgeRef, deps: ShipDeps): Promise<ShipStepResult> {
  const step = "undraft";
  const pr = await readForgePr(ref, deps, step);
  if (!pr.draft) return { step, changed: false };
  if (ref.forge === "github") {
    await githubGraphql(
      deps,
      step,
      `mutation { markPullRequestReadyForReview(input: { pullRequestId: ${gql(pr.nodeId ?? "")} }) { pullRequest { isDraft } } }`,
    );
    return { step, changed: true };
  }
  await forgeRequest(ref, deps, step, "PUT", `/merge_requests/${ref.number}`, {
    title: (pr.title ?? "").replace(DRAFT_TITLE_PREFIX, ""),
  });
  return { step, changed: true };
}

async function addReadyLabel(deps: ShipDeps, issue: LinearIssue): Promise<ShipStepResult> {
  const step = "linear-label";
  if (issue.labels.some((label) => label.name === LABEL_READY)) return { step, changed: false };
  const data = await linearGraphql(
    deps,
    "label",
    `query { issueLabels(filter: { name: { eq: ${gql(LABEL_READY)} } }) { nodes { id parent { id } } } }`,
  );
  let ready: LinearLabel | undefined;
  for (const node of nodes(data.issueLabels)) {
    ready = linearLabel({ ...obj(node), name: LABEL_READY });
    if (ready !== undefined) break;
  }
  if (ready === undefined) throw new Error(`linear_label_missing: ${LABEL_READY}`);
  const labelId = ready.id;
  // Linear allows one label per group, and the wrapper leaves its own state label in the same group.
  for (const sibling of issue.labels) {
    if (ready.groupId === undefined || sibling.groupId !== ready.groupId) continue;
    await linearGraphql(
      deps,
      "label",
      `mutation { issueRemoveLabel(id: ${gql(issue.id)}, labelId: ${gql(sibling.id)}) { success } }`,
    );
  }
  await linearGraphql(
    deps,
    "label",
    `mutation { issueAddLabel(id: ${gql(issue.id)}, labelId: ${gql(labelId)}) { success } }`,
  );
  return { step, changed: true };
}

async function closeForgePr(ref: ForgeRef, deps: ShipDeps): Promise<ShipStepResult> {
  const step = "close";
  const pr = await readForgePr(ref, deps, step);
  if (pr.merged) return { step, changed: false, detail: "merged" };
  if (!pr.open) return { step, changed: false };
  if (ref.forge === "github") {
    await forgeRequest(ref, deps, step, "PATCH", `/pulls/${ref.number}`, { state: "closed" });
  } else {
    await forgeRequest(ref, deps, step, "PUT", `/merge_requests/${ref.number}`, { state_event: "close" });
  }
  return { step, changed: true };
}

export async function shipFactoryPullRequest(ref: ForgeRef, ticket: string, deps: ShipDeps): Promise<ShipStepResult[]> {
  const undraft = await undraftForgePr(ref, deps);
  const issue = await readLinearIssue(deps, ticket);
  const state = await moveLinearState(deps, issue, STATE_IN_REVIEW, "linear-state");
  return [undraft, state, await addReadyLabel(deps, issue)];
}

export async function returnFactoryPullRequest(
  ref: ForgeRef | null,
  ticket: string,
  note: string,
  deps: ShipDeps,
): Promise<ShipStepResult[]> {
  const results: ShipStepResult[] = [];
  if (ref !== null) {
    const path = ref.forge === "github" ? `/issues/${ref.number}/comments` : `/merge_requests/${ref.number}/notes`;
    await forgeRequest(ref, deps, "comment", "POST", path, { body: `Returned by the factory reviewer: ${note}` });
    results.push({ step: "forge-comment", changed: true });
    results.push(await closeForgePr(ref, deps));
  }
  const issue = await readLinearIssue(deps, ticket);
  results.push(await postLinearComment(deps, issue, `Returned to Auto-Triage: ${note}`, "linear-comment"));
  results.push(await moveLinearState(deps, issue, STATE_AUTO_TRIAGE, "linear-state"));
  return results;
}

export async function shipFactoryAlreadyFixed(
  ticket: string,
  evidence: string | undefined,
  deps: ShipDeps,
): Promise<ShipStepResult[]> {
  const issue = await readLinearIssue(deps, ticket);
  const body = evidence === undefined || evidence === "" ? "Already fixed." : `Already fixed. ${evidence}`;
  const comment = await postLinearComment(deps, issue, body, "linear-comment");
  if (TERMINAL_STATE_TYPES.has(issue.state.type)) return [comment, { step: "linear-state", changed: false }];
  return [comment, await moveLinearState(deps, issue, STATE_DONE, "linear-state")];
}
