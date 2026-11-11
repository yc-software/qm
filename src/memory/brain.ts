import { McpCallError } from "../mcp/mcp-client.ts";
import { attestableAudience, samePerson } from "../directory/person.ts";
import { isOverheard, isUserItem, type Item } from "../sessions/items.ts";
import type { ScopeId } from "../types.ts";
import { swallowAs } from "../util/errors.ts";
import { isObj } from "../util/objects.ts";
import { quotedData } from "../util/text.ts";
import type { BoundBrain, BrainCall, MemoryService } from "./memory-service.ts";
import { failedOutcome, problemLine, problemOf } from "./provider-outcome.ts";

const BRAIN_ARG_MAX_CHARS = 200;
const QUOTED_SPAN = 24;
const BRAIN_DOCS = "docs/memory-providers.md#the-brain-tool";
const AMBIGUOUS =
  "Several records match. Ask the person which one they mean, naming what tells them apart; never pick one yourself.";

type Row = Record<string, unknown>;
type RefOf = (...parts: unknown[]) => string | undefined;

interface BrainRef {
  brain: string;
  source: string;
  slug: string;
}

interface BrainRequest {
  query?: string;
  ref?: BrainRef;
  after?: string;
}

interface BrainAction {
  op: string;
  takes: "query" | "ref" | "either";
  describe: string;
  args(request: BrainRequest): Row;
  project(result: Row, refOf: RefOf): unknown;
}

const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(isObj) : []);
const pick = (row: Row, keys: readonly string[]): Row =>
  Object.fromEntries(keys.flatMap((key) => (row[key] == null || row[key] === "" ? [] : [[key, row[key]]])));
const refField = (ref: string | undefined) => (ref ? { ref } : {});
const pageOf = ({ ref }: BrainRequest) => ({ slug: ref!.slug, source_id: ref!.source });
const listed =
  (keys: readonly string[], slug = "slug", source = "source_id") =>
  (result: Row, refOf: RefOf) =>
    rows(result.results).map((row) => ({ ...refField(refOf(row[source], row[slug])), ...pick(row, keys) }));

const BRAIN_ACTIONS = {
  search: {
    op: "query",
    takes: "query",
    describe:
      "pages and saved facts matching the words in `query`, best first; a saved fact's ref is what memory delete takes to forget it",
    args: ({ query }) => ({ query }),
    project: (result, refOf) =>
      rows(result.results).map((row) => ({
        ...refField(row.slug === undefined ? refOf(row.fact_id) : refOf(row.source_id, row.slug)),
        ...pick(row, ["title", "type", "chunk_text", "effective_date", "trust_tier"]),
      })),
  },
  page: {
    op: "get_page",
    takes: "ref",
    describe: "the whole page for `ref`",
    args: pageOf,
    project: (page, refOf) => ({
      ...refField(refOf(page.source_id, page.slug)),
      ...pick(page, ["title", "type", "compiled_truth", "timeline", "frontmatter", "truncated", "trust_tier"]),
    }),
  },
  timeline: {
    op: "get_timeline",
    takes: "ref",
    describe: "dated events on the page for `ref`, newest first; `after` (YYYY-MM-DD) keeps later ones",
    args: (request) => ({ ...pageOf(request), ...(request.after ? { after: request.after } : {}) }),
    project: (result) =>
      rows(result.results).map((row) => pick(row, ["date", "source", "summary", "detail", "trust_tier"])),
  },
  links: {
    op: "get_backlinks",
    takes: "ref",
    describe: "pages that link to `ref`, with the sentence that links them",
    args: pageOf,
    project: listed(["link_type", "context"], "from_slug", "from_source_id"),
  },
  experts: {
    op: "find_experts",
    takes: "query",
    describe: "people and companies who know most about the topic in `query`",
    args: ({ query }) => ({ topic: query }),
    project: listed(["title", "type", "score"]),
  },
  whois: {
    op: "whois",
    takes: "query",
    describe: "exact matches for the name or email in `query`; use it before acting on a person",
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
    takes: "either",
    describe: "the card for a person or company (`ref`, or a name in `query`): summary, open threads and links",
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
    takes: "either",
    describe: "what to know before meeting a person or company (`ref`, or a name in `query`), as dated items",
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

export type BrainActionName = keyof typeof BRAIN_ACTIONS;

function brainActions(tools: readonly string[]): BrainActionName[] {
  return (Object.keys(BRAIN_ACTIONS) as BrainActionName[]).filter((action) => tools.includes(BRAIN_ACTIONS[action].op));
}

export function describeBrainActions(actions: readonly BrainActionName[]): string {
  return actions.map((action) => `${action}: ${BRAIN_ACTIONS[action].describe}.`).join(" ");
}

export interface TurnBrain extends BoundBrain {
  actions: BrainActionName[];
}

export interface BrainAccess {
  brains: readonly TurnBrain[];
  live(): Promise<BoundBrain[]>;
  retained(): Promise<Item[]>;
  call: Omit<BrainCall, "signal">;
}

interface BrainTurn {
  actorId: string;
  scopeId: ScopeId;
  audienceScopeId?: ScopeId;
}

export async function boundBrains(memory: Pick<MemoryService, "brains">, turn: BrainTurn): Promise<BoundBrain[]> {
  if (!attestableAudience(turn.actorId, turn.scopeId) || !attestableAudience(turn.actorId, turn.audienceScopeId))
    return [];
  return (await memory.brains?.(turn.scopeId)) ?? [];
}

export async function turnBrains(memory: Pick<MemoryService, "brains">, turn: BrainTurn): Promise<TurnBrain[]> {
  const call = { actorId: turn.actorId, ...(turn.audienceScopeId ? { audienceScopeId: turn.audienceScopeId } : {}) };
  const decided = await Promise.all(
    (await boundBrains(memory, turn)).map(async (brain) => ({
      ...brain,
      actions: brainActions(await brain.tools(call).catch(swallowAs(`brain ${brain.id}: tools`, []))),
    })),
  );
  return decided.filter((brain) => brain.actions.length);
}

const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, " ");

function heard(items: readonly Item[], actorId: string, brain: string) {
  const foreign: string[] = [];
  const own: string[] = [];
  const refs = new Set<string>();
  for (const item of items) {
    if (item.kind === "ToolCall" || item.kind === "Reasoning") continue;
    const fromBrain = item.kind === "ToolResult" && item.tool === "brain" && !item.isError;
    if (fromBrain && Array.isArray(item.body.refs))
      for (const ref of item.body.refs) if (typeof ref === "string") refs.add(ref);
    const ownWords = isUserItem(item) && !isOverheard(item) && samePerson(item.author, actorId);
    (ownWords || (fromBrain && item.body.brain === brain) ? own : foreign).push(item.text ?? "");
    if (typeof item.body.environment === "string") foreign.push(item.body.environment);
  }
  return { foreign: normalized(foreign.join("\n")), own: normalized(own.join("\n")), refs };
}

function quotesForeign(value: string, { foreign, own }: { foreign: string; own: string }): boolean {
  const text = normalized(value);
  for (let at = 0; at + QUOTED_SPAN <= text.length; at++) {
    const span = text.slice(at, at + QUOTED_SPAN);
    if (foreign.includes(span) && !own.includes(span)) return true;
  }
  return false;
}

function parseRef(value: string): BrainRef | undefined {
  const [brain, source, ...slug] = value.split(":");
  return brain && source && slug.join(":") ? { brain, source, slug: slug.join(":") } : undefined;
}

export interface BrainAnswer {
  text: string;
  isError: boolean;
  fromBrain: boolean;
  summary: { brain?: string; refs?: string[]; code?: string };
}

const refused = (text: string, brain?: string): BrainAnswer => ({
  text: `[brain_refused] ${text}`,
  isError: true,
  fromBrain: false,
  summary: brain ? { brain } : {},
});

export async function askBrain(
  access: BrainAccess,
  input: { action: string; brain?: string; query?: string; ref?: string; after?: string },
  signal?: AbortSignal,
): Promise<BrainAnswer> {
  const action = BRAIN_ACTIONS[input.action as BrainActionName] as BrainAction | undefined;
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
  if (!action || !decided.actions.includes(input.action as BrainActionName))
    return refused(`brain ${id} does not offer ${input.action}.`, id);
  const query = input.query?.trim();
  if (action.takes === "query" && !query) return refused(`${input.action} needs a query.`, id);
  if (action.takes === "ref" && !ref) return refused(`${input.action} needs a ref from a brain result.`, id);
  if (action.takes === "either" && !ref && !query) return refused(`${input.action} needs a ref or a query.`, id);
  const written = [query, input.after].filter((value): value is string => value !== undefined);
  if (written.some((value) => value.length > BRAIN_ARG_MAX_CHARS))
    return refused(
      `brain lookups take at most ${BRAIN_ARG_MAX_CHARS} characters; send the few words that name what to look up.`,
      id,
    );
  const brain = (await access.live()).find((candidate) => candidate.id === id);
  if (!brain) return refused(`brain ${id} is no longer connected to this conversation.`, id);
  const context = heard(await access.retained(), access.call.actorId, id);
  if (ref && action.takes !== "query" && !context.refs.has(input.ref!))
    return refused(`${input.ref} is not a ref any brain result in this conversation gave; look it up again first.`, id);
  if (written.some((value) => quotesForeign(value, context)))
    return refused(
      `that lookup repeats text that reached this conversation from somewhere other than the person or brain ${id}, so it was not sent. Write it in your own words or use a ref from this brain.`,
      id,
    );
  const request: BrainRequest = {
    ...(query ? { query } : {}),
    ...(ref ? { ref } : {}),
    ...(input.after ? { after: input.after } : {}),
  };
  const started = Date.now();
  const header = `### brain · ${brain.label}`;
  try {
    const result = await brain.call(action.op, action.args(request), { ...access.call, ...(signal ? { signal } : {}) });
    const refs = new Set<string>();
    const refOf: RefOf = (...parts) => {
      if (!parts.every((part) => (typeof part === "string" && part) || typeof part === "number")) return undefined;
      const value = [id, ...parts].join(":");
      refs.add(value);
      return value;
    };
    const structured = isObj(result.structuredContent) ? result.structuredContent : {};
    const notes = result.content.flatMap((block) => (block.type === "text" && !isJson(block.text) ? [block.text] : []));
    const body = [JSON.stringify(action.project(structured, refOf)), ...notes].join("\n\n");
    return {
      text: [header, ...(structured.ambiguous === true ? [AMBIGUOUS] : []), quotedData(body)].join("\n"),
      isError: false,
      fromBrain: true,
      summary: { brain: id, refs: [...refs] },
    };
  } catch (error) {
    const failed = failedOutcome(error);
    const problem = problemLine(
      failed.code === "actor_not_attested"
        ? {
            code: "memory_provider_denied",
            provider: id,
            detail: `${input.action} is unavailable in brain ${id}: its operator hasn't let QM run ${action.op} as this person (actor_not_attested), so nothing was read.`,
            fix: `Answer without it, or use another action. On ${id}'s host, the operator can list ${action.op} in QM's client's --attest-ops (${BRAIN_DOCS}).`,
          }
        : problemOf(
            { provider: id, scope: access.call.audienceScopeId ?? "", ms: Date.now() - started, ...failed },
            "search",
          )!,
    );
    const summary = { brain: id, ...(failed.code ? { code: failed.code } : {}) };
    if (!(error instanceof McpCallError) || !error.code || error.status !== undefined)
      return { text: problem, isError: true, fromBrain: false, summary };
    const lead = failed.outcome === "denied" ? problem : `[brain_answered ${error.code}]`;
    return { text: [header, lead, quotedData(error.message)].join("\n"), isError: true, fromBrain: true, summary };
  }
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
