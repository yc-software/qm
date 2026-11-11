import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Type, type TProperties } from "typebox";
import { jsonOf, McpCallError } from "../mcp/mcp-client.ts";
import { ownPrivateConversation } from "../directory/person.ts";
import type { ScopeId } from "../types.ts";
import { swallowAs } from "../util/errors.ts";
import { isObj } from "../util/objects.ts";
import { quotedData } from "../util/text.ts";
import {
  brainActsAsPerson,
  type BoundBrain,
  type BrainCall,
  type MemoryAuthority,
  type MemoryService,
} from "./memory-service.ts";
import { failedOutcome, problemLine, problemOf } from "./provider-outcome.ts";
import { parseProviderRef, providerRef } from "./provider-router.ts";

const AMBIGUOUS =
  "Several records match. Ask the person which one they mean, naming what tells them apart; never pick one yourself.";

type Row = Record<string, unknown>;
type RefOf = (...parts: unknown[]) => string | undefined;

interface BrainRef {
  brain: string;
  source: string;
  slug: string;
}

type BrainRequest = {
  query?: string;
  ref?: BrainRef;
  after?: string;
  before?: string;
  cursor?: string;
};

export interface BrainInput {
  action: string;
  brain?: string;
  query?: string;
  ref?: string;
  after?: string;
  before?: string;
  cursor?: string;
}

interface BrainAction {
  op: string;
  describe: string;
  parameters: TProperties;
  args(request: BrainRequest): Row;
  project(result: Row, refOf: RefOf): unknown;
}

const QUERY = Type.String({ description: "A few words: a name, email, topic or question." });
const REF = Type.String({ description: "A ref from an earlier brain result." });
const CURSOR = Type.Optional(Type.String({ description: "next_cursor from the previous result, to read on." }));
const RECORD = { ref: Type.Optional(REF), query: Type.Optional(QUERY) };

const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(isObj) : []);
const pick = (row: Row, keys: readonly string[]): Row =>
  Object.fromEntries(keys.flatMap((key) => (row[key] == null || row[key] === "" ? [] : [[key, row[key]]])));
const refField = (ref: string | undefined) => (ref ? { ref } : {});
const pageOf = (request: BrainRequest) => ({
  slug: request.ref!.slug,
  source_id: request.ref!.source,
  ...pick(request, ["cursor"]),
});
const listed =
  (keys: readonly string[], slug = "slug", source = "source_id") =>
  (result: Row, refOf: RefOf) =>
    rows(result.results).map((row) => ({ ...refField(refOf(row[source], row[slug])), ...pick(row, keys) }));

export const BRAIN_ACTIONS = {
  search: {
    op: "query",
    describe:
      "pages and saved facts matching the words in `query`, best first; a saved fact's ref is what memory delete takes to forget it",
    parameters: { query: QUERY },
    args: ({ query }) => ({ query }),
    project: (result, refOf) =>
      rows(result.results).map((row) => ({
        ...refField(row.slug === undefined ? refOf(row.fact_id) : refOf(row.source_id, row.slug)),
        ...pick(row, ["title", "type", "chunk_text", "effective_date", "trust_tier"]),
      })),
  },
  page: {
    op: "get_page",
    describe:
      "the page for `ref`; a long page comes back as an outline and a first window, with next_cursor to pass as `cursor`",
    parameters: { ref: REF, cursor: CURSOR },
    args: pageOf,
    project: (page, refOf) => ({
      ...refField(refOf(page.source_id, page.slug)),
      ...pick(page, [
        "title",
        "type",
        "compiled_truth",
        "timeline",
        "frontmatter",
        "body",
        "outline",
        "window",
        "truncated",
        "next_cursor",
        "trust_tier",
      ]),
    }),
  },
  timeline: {
    op: "get_timeline",
    describe: "dated events on the page for `ref`, newest first; `after` and `before` bound the dates",
    parameters: {
      ref: REF,
      after: Type.Optional(Type.String({ description: "Only events on or after this YYYY-MM-DD date." })),
      before: Type.Optional(Type.String({ description: "Only events on or before this YYYY-MM-DD date." })),
    },
    args: (request) => ({ ...pageOf(request), ...pick(request, ["after", "before"]) }),
    project: (result) =>
      rows(result.results).map((row) => pick(row, ["date", "source", "summary", "detail", "trust_tier"])),
  },
  links: {
    op: "get_backlinks",
    describe:
      "pages that link to `ref`, with the sentence that links them; when more remain, the last row carries next_cursor to pass as `cursor`",
    parameters: { ref: REF, cursor: CURSOR },
    args: pageOf,
    project: listed(["link_type", "context", "truncated", "next_cursor"], "from_slug", "from_source_id"),
  },
  experts: {
    op: "find_experts",
    describe: "people and companies who know most about the topic in `query`",
    parameters: { query: QUERY },
    args: ({ query }) => ({ topic: query }),
    project: listed(["title", "type", "score"]),
  },
  whois: {
    op: "whois",
    describe: "exact matches for the name or email in `query`; use it before acting on a person",
    parameters: { query: QUERY },
    args: ({ query }) => ({ query }),
    project: (result, refOf) => ({
      matches: rows(result.matches).map((row) => ({
        ...refField(refOf(row.source_id, row.slug)),
        ...pick(row, ["title", "type", "match"]),
      })),
      ...pick(result, ["ambiguous", "truncated"]),
    }),
  },
  entity: {
    op: "entity",
    describe: "the card for a person or company (`ref`, or a name in `query`): summary, open threads and links",
    parameters: RECORD,
    args: ({ query, ref }) => (ref ? { name: ref.slug, source_id: ref.source } : { name: query }),
    project: (result, refOf) => {
      if (!isObj(result.card)) return pick(result, ["found", "ambiguous", "suggestions"]);
      const { card } = result;
      const entity = isObj(card.entity) ? card.entity : {};
      return {
        ...refField(refOf(entity.source_id, entity.slug)),
        ...pick(entity, ["title", "type"]),
        ...pick(card, ["trust_tier", "aka", "summary"]),
        open_threads: rows(card.open_threads).map((thread) => pick(thread, ["kind", "text", "date", "trust_tier"])),
        edges: rows(card.edges).map((edge) => ({
          ...refField(refOf(entity.source_id, edge.slug)),
          ...pick(edge, ["type", "direction", "context"]),
        })),
        ...pick(result, ["ambiguous"]),
      };
    },
  },
  brief: {
    op: "context_pack",
    describe: "what to know before meeting a person or company (`ref`, or a name in `query`), as dated items",
    parameters: RECORD,
    args: ({ query, ref }) => ({
      counterparty: ref ? ref.slug : query,
      ...(ref ? { source_id: ref.source } : {}),
      intent: "meeting",
    }),
    project: (result, refOf) => {
      const brief = isObj(result.brief) ? result.brief : {};
      const records = [...rows(brief.items), ...rows(result.cards)];
      return {
        ...(isObj(brief.counterparty) ? { counterparty: pick(brief.counterparty, ["display"]) } : {}),
        refs: [...new Set(records.flatMap((record) => refOf(record.source_id, record.slug) ?? []))],
      };
    },
  },
} satisfies Record<string, BrainAction>;

type BrainActionName = keyof typeof BRAIN_ACTIONS;

function brainActions(tools: readonly string[]): BrainActionName[] {
  return (Object.keys(BRAIN_ACTIONS) as BrainActionName[]).filter((action) => tools.includes(BRAIN_ACTIONS[action].op));
}

interface TurnBrain extends BoundBrain {
  actions: BrainActionName[];
}

export interface BrainAccess {
  brains: readonly TurnBrain[];
  live(): Promise<BoundBrain[]>;
  scopeId: ScopeId;
  call: Omit<BrainCall, "signal">;
}

export interface BrainLookup {
  brains: readonly TurnBrain[];
  ask(input: BrainInput, signal?: AbortSignal): Promise<BrainAnswer>;
}

export async function brainAccess(
  memory: Pick<MemoryService, "brains">,
  scopeId: ScopeId,
  call: Omit<BrainCall, "signal">,
): Promise<BrainAccess | undefined> {
  if (!ownPrivateConversation(call.actorId, scopeId, call.audienceScopeId)) return undefined;
  const live = async () => (await memory.brains?.(scopeId)) ?? [];
  const decided = await Promise.all(
    (await live()).map(async (brain) => ({
      ...brain,
      actions: brainActions(await brain.tools(call).catch(swallowAs(`brain ${brain.id}: tools`, []))),
    })),
  );
  const brains = decided.filter((brain) => brain.actions.length);
  return brains.length ? { brains, live, scopeId, call } : undefined;
}

function parseRef(value: string): BrainRef | undefined {
  const outer = parseProviderRef(value);
  const at = outer ? outer.ref.indexOf(":") : -1;
  return outer?.provider && at > 0 && at < outer.ref.length - 1
    ? { brain: outer.provider, source: outer.ref.slice(0, at), slug: outer.ref.slice(at + 1) }
    : undefined;
}

export interface BrainAnswer {
  text: string;
  isError: boolean;
  fromBrain: boolean;
  summary: { brain?: string; code?: string };
}

const refused = (text: string, brain?: string): BrainAnswer => ({
  text: `[brain_refused] ${text}`,
  isError: true,
  fromBrain: false,
  summary: brain ? { brain } : {},
});

export async function askBrain(
  access: BrainAccess,
  by: MemoryAuthority,
  input: BrainInput,
  signal?: AbortSignal,
): Promise<BrainAnswer> {
  if (!brainActsAsPerson(by, access.scopeId, access.call.audienceScopeId))
    return refused(
      "only the person can look things up in their brain, on a turn they sent in their own DM with QM or in work QM runs for that turn, such as a subagent; nothing was sent to the brain.",
    );
  const ref = input.ref === undefined ? undefined : parseRef(input.ref);
  if (input.ref !== undefined && !ref)
    return refused(`${input.ref} is not a brain ref; use a ref from a brain result.`);
  if (ref && input.brain && input.brain !== ref.brain)
    return refused(`ref ${input.ref} belongs to brain ${ref.brain}, not ${input.brain}.`);
  const ids = access.brains.map((brain) => brain.id);
  const id = ref?.brain ?? input.brain ?? (ids.length === 1 ? ids[0] : undefined);
  if (!id) return refused(`name the brain to ask: ${ids.join(", ")}.`);
  const decided = access.brains.find((brain) => brain.id === id);
  if (!decided) return refused(`no brain named ${id} is connected to this conversation; use one of ${ids.join(", ")}.`);
  const name = input.action as BrainActionName;
  if (!decided.actions.includes(name)) return refused(`brain ${id} does not offer ${input.action}.`, id);
  const action: BrainAction = BRAIN_ACTIONS[name];
  const query = input.query?.trim();
  if (!ref && !query) return refused(`${input.action} needs a ref or a query.`, id);
  const brain = (await access.live()).find((candidate) => candidate.id === id);
  if (!brain) return refused(`brain ${id} is no longer connected to this conversation.`, id);
  const request: BrainRequest = {
    ...(query ? { query } : {}),
    ...(ref ? { ref } : {}),
    ...(input.after ? { after: input.after } : {}),
    ...(input.before ? { before: input.before } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
  };
  const started = Date.now();
  const header = `### brain · ${brain.label}`;
  let result: CallToolResult;
  try {
    result = await brain.call(action.op, action.args(request), { ...access.call, ...(signal ? { signal } : {}) });
  } catch (error) {
    const failed = failedOutcome(error);
    const problem = problemLine(
      problemOf(
        { provider: id, scope: access.scopeId, ms: Date.now() - started, ref: action.op, ...failed },
        "lookup",
      )!,
    );
    const summary = { brain: id, ...(failed.code ? { code: failed.code } : {}) };
    if (!(error instanceof McpCallError) || !error.code || error.status !== undefined)
      return { text: problem, isError: true, fromBrain: false, summary };
    const lead = failed.outcome === "denied" ? problem : `[brain_answered ${error.code}]`;
    return { text: [header, lead, quotedData(error.message)].join("\n"), isError: true, fromBrain: true, summary };
  }
  const refOf: RefOf = (...parts) =>
    parts.every((part) => typeof part === "string" && part) ? providerRef(id, parts.join(":")) : undefined;
  const structured = isObj(result.structuredContent) ? result.structuredContent : {};
  const notes = result.content.flatMap((block) =>
    block.type === "text" && jsonOf(block.text) === undefined ? [block.text] : [],
  );
  const body = [JSON.stringify(action.project(structured, refOf)), ...notes].join("\n\n");
  return {
    text: [header, ...(structured.ambiguous === true ? [AMBIGUOUS] : []), quotedData(body)].join("\n"),
    isError: false,
    fromBrain: true,
    summary: { brain: id },
  };
}
