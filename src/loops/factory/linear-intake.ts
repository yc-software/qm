import type { IntakeCandidate } from "../runner.ts";

export const FACTORY_INTAKE_STATE = "Auto-Triage";
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

const DEFAULT_MAX_PAGES = 5;
const RESOLVED_BLOCKER_STATE_TYPES = new Set(["completed", "canceled"]);

const FACTORY_INTAKE_QUERY = `query FactoryIntake($teamId: String!, $state: String!, $after: String) {
  team(id: $teamId) {
    issues(first: 50, after: $after, filter: { state: { name: { eq: $state } } }) {
      nodes {
        identifier
        title
        createdAt
        inverseRelations { nodes { type issue { identifier state { type } } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export interface LinearIntakeInput {
  teamId: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  stateName?: string;
  maxPages?: number;
}

interface IntakeRelation {
  type?: string;
  issue?: { identifier?: string; state?: { type?: string } | null } | null;
}

interface IntakeIssue {
  identifier: string;
  title: string;
  createdAt: string;
  inverseRelations?: { nodes?: IntakeRelation[] | null } | null;
}

interface IntakePage {
  nodes?: IntakeIssue[] | null;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
}

interface FactoryIntakeResponse {
  data?: { team?: { issues?: IntakePage | null } | null } | null;
  errors?: { message?: string }[] | null;
}

const intakeFailure = (detail: string): Error => new Error(`linear_intake_failed: ${detail}`);

const relationBlocks = (relation: IntakeRelation): boolean => {
  const stateType = relation.issue?.state?.type;
  if (relation.type !== "blocks" || stateType === undefined) return false;
  return !RESOLVED_BLOCKER_STATE_TYPES.has(stateType);
};

const isBlocked = (issue: IntakeIssue): boolean => (issue.inverseRelations?.nodes ?? []).some(relationBlocks);

const byCreatedAt = (a: IntakeIssue, b: IntakeIssue): number => {
  if (a.createdAt < b.createdAt) return -1;
  return a.createdAt > b.createdAt ? 1 : 0;
};

async function fetchIntakePage(
  doFetch: typeof globalThis.fetch,
  input: LinearIntakeInput,
  state: string,
  after: string | undefined,
): Promise<IntakePage> {
  const res = await doFetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: input.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: FACTORY_INTAKE_QUERY,
      variables: { teamId: input.teamId, state, after },
    }),
  });
  if (!res.ok) throw intakeFailure(String(res.status));
  let body: FactoryIntakeResponse;
  try {
    body = (await res.json()) as FactoryIntakeResponse;
  } catch {
    throw intakeFailure("unreadable response body");
  }
  const firstError = body.errors?.[0];
  if (firstError) throw intakeFailure(firstError.message ?? "linear reported an unnamed error");
  const page = body.data?.team?.issues;
  if (!page) throw intakeFailure("response carried no team issues");
  return page;
}

export async function enumerateFactoryCandidates(input: LinearIntakeInput): Promise<IntakeCandidate[]> {
  const doFetch = input.fetch ?? globalThis.fetch;
  const state = input.stateName ?? FACTORY_INTAKE_STATE;
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;
  const issues: IntakeIssue[] = [];
  let after: string | undefined;
  for (let request = 0; request < maxPages; request += 1) {
    const page = await fetchIntakePage(doFetch, input, state, after);
    issues.push(...(page.nodes ?? []));
    const next = page.pageInfo?.hasNextPage === true ? page.pageInfo.endCursor : undefined;
    if (!next) break;
    after = next;
  }
  return issues
    .filter((issue) => !isBlocked(issue))
    .sort(byCreatedAt)
    .map((issue) => ({ sourceKey: issue.identifier, sourceSummary: issue.title }));
}
