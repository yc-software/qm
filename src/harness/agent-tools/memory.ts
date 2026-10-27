// The memory and history tools: notebook facts and this conversation's own transcript.

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { MemoryDisclosureDenied } from "../../memory/disclosure.ts";
import { MemoryFactsMissing } from "../../memory/facts.ts";
import { type ToolKit } from "./kit.ts";
import { optionalInteger, optionalString, text } from "./shared.ts";

export function memoryTools(kit: ToolKit) {
  const { memory } = memoryTool(kit);
  const { history } = historyTool(kit);
  return { memory, history };
}

/** The memory tool: search, read, add, edit and delete notebook facts. */
function memoryTool(kit: ToolKit) {
  const memory = defineTool({
    name: "memory",
    label: "memory",
    description:
      "Your durable memory of the person or team you work for; it persists across conversations and surfaces. It is not a file: writing MEMORY.md does nothing. " +
      "Reads may span authorized notebooks; writes change only this conversation's notebook. " +
      "search: facts matching every word of `query` across readable notebooks — only a bounded selection is loaded into context, so search before asking. " +
      "read: this notebook with fact #ids (pass `scope` from a search result for another notebook). " +
      "add: short, self-contained facts (preferences, identifiers, ongoing projects, how they work); never secrets, one-off trivia, or anything already recorded elsewhere. " +
      "Save pointers, not data: growing lists and working state belong in a file written with the files tool, with one memory line naming it. Files are this conversation's own; a pointer read from another notebook is a hint of where state lives, not a path you can open. " +
      "edit: replace facts' text by id; delete: forget by `ids`. Fix changed facts instead of adding contradictions; delete stale ones.",
    parameters: memoryParams(),
    execute: (callId, params) => runMemoryAction(kit, callId, params),
  });
  return { memory };
}

function memoryParams() {
  return Type.Object({
    action: Type.Union([
      Type.Literal("search"),
      Type.Literal("read"),
      Type.Literal("add"),
      Type.Literal("edit"),
      Type.Literal("delete"),
    ]),
    query: optionalString("search: words to look for (all must match)."),
    limit: optionalInteger("search: max facts (default 20)."),
    scope: optionalString("search/read: notebook scope ID from a search result; omit for all readable / your own."),
    facts: Type.Optional(
      Type.Array(
        Type.Object({
          id: optionalString("edit: the fact's id, e.g. #42."),
          text: Type.String({
            description: "One short self-contained fact.",
          }),
        }),
        { description: "add: [{text}, …]; edit: [{id, text}, …]." },
      ),
    ),
    ids: Type.Optional(Type.Array(Type.String(), { description: "delete: ids of the facts to forget." })),
  });
}

/** Runs one memory-tool action against the turn's notebook. */
async function runMemoryAction(kit: ToolKit, callId: string, params: Static<ReturnType<typeof memoryParams>>) {
  const { ref, opts, recordCall, recordText, recordFail } = kit;
  const tc = ref.current;
  if (!tc) return text("[error] no active tool context");
  const action = params.action;
  await recordCall(callId, {
    tool: "memory",
    action,
    ...(params.scope !== undefined ? { scope: params.scope } : {}),
    ...(params.query !== undefined ? { query: params.query } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.facts !== undefined ? { facts: params.facts } : {}),
    ...(params.ids !== undefined ? { ids: params.ids } : {}),
  });
  const fail = (error: string) => recordFail(callId, { tool: "memory", action, error }, `[error] ${error}`);
  const unavailable = () =>
    recordFail(callId, { tool: "memory", action, unavailable: true }, "[memory isn't available in this conversation]");
  if (params.scope !== undefined && action !== "search" && action !== "read") {
    return recordFail(
      callId,
      { tool: "memory", action, error: "scope is read-only" },
      "[error] scope is only allowed for memory search/read; writes stay in this conversation.",
    );
  }
  if (opts?.readOnly && action !== "search" && action !== "read") {
    return recordFail(
      callId,
      { tool: "memory", action, readOnly: true },
      "[this is a read-only wake — memory can be searched and read here, but not written]",
    );
  }
  const facts = (params.facts ?? []).map((fact) => ({ id: fact.id?.trim() ?? "", text: fact.text.trim() }));
  try {
    switch (action) {
      case "search": {
        const query = params.query ?? "";
        if (!query.trim()) return fail("memory search requires `query`.");
        const hits = await tc.memorySearch(query, params.limit, params.scope);
        if (hits === null) return unavailable();
        return recordText(
          callId,
          { tool: "memory", action, query, count: hits.length },
          hits.length ? hits.join("\n") : `[no remembered facts match "${query}"]`,
        );
      }
      case "read": {
        const body = await tc.memoryRead(params.scope);
        if (body === null) return unavailable();
        return recordText(
          callId,
          { tool: "memory", action, chars: body.length },
          body.trim() ? body : "(you have nothing remembered here yet)",
        );
      }
      case "add": {
        const texts = facts.map((fact) => fact.text).filter(Boolean);
        if (!texts.length) return fail("memory add requires `facts` (a non-empty list of {text}).");
        const added = await tc.memoryAdd(texts);
        if (added === null) return unavailable();
        return recordText(
          callId,
          { tool: "memory", action, added },
          added ? `Remembered ${added} fact${added === 1 ? "" : "s"}.` : "Already remembered — nothing new to save.",
        );
      }
      case "edit": {
        if (!facts.length || facts.some((fact) => !fact.id || !fact.text))
          return fail("memory edit requires `facts` as a non-empty list of {id, text}.");
        if ((await tc.memoryEdit(facts)) === null) return unavailable();
        return recordText(
          callId,
          { tool: "memory", action, edited: facts.length },
          `Updated ${facts.length} fact${facts.length === 1 ? "" : "s"}.`,
        );
      }
      case "delete": {
        const ids = (params.ids ?? []).map((id) => id.trim()).filter(Boolean);
        if (!ids.length) return fail("memory delete requires `ids` (a non-empty list).");
        if ((await tc.memoryDelete(ids)) === null) return unavailable();
        return recordText(
          callId,
          { tool: "memory", action, deleted: ids.length },
          `Forgot ${ids.length} fact${ids.length === 1 ? "" : "s"}.`,
        );
      }
    }
  } catch (e) {
    if (e instanceof MemoryFactsMissing || e instanceof MemoryDisclosureDenied) return fail(e.message);
    throw e;
  }
}

/** The history tool: search or reopen this conversation's own transcript. */
function historyTool(kit: ToolKit) {
  const { ref, recordCall, recordText, recordFail } = kit;
  const history = defineTool({
    name: "history",
    label: "history",
    description:
      "Search or reopen this conversation's own transcript (including parts compacted out of context; tool results excluded) when something said earlier is not in front of you. " +
      "`query` returns the newest matching entries tagged kind#seq; `seq` returns one entry in full.",
    parameters: Type.Object({
      query: optionalString("Words to find (all must match, case-insensitive)."),
      seq: optionalInteger("Reopen this entry instead of searching."),
      limit: optionalInteger("Max entries for query mode (default 20)."),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      const seq = params.seq == null ? undefined : Number(params.seq);
      await recordCall(callId, {
        tool: "history",
        ...(params.query !== undefined ? { query: params.query } : {}),
        ...(seq !== undefined ? { seq } : {}),
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
      if (seq !== undefined) {
        if (!Number.isInteger(seq)) {
          return recordFail(
            callId,
            { tool: "history", error: "seq must be an integer" },
            "[error] history `seq` must be an integer entry number, like the 87 in ToolCall#87.",
          );
        }
        const entry = await tc.historyOpen(seq);
        return recordText(
          callId,
          { tool: "history", seq, found: entry !== null },
          entry ?? `[no entry with seq ${seq} is visible in this conversation's transcript]`,
        );
      }
      if (!params.query?.trim()) {
        return recordFail(
          callId,
          { tool: "history", error: "query or seq required" },
          "[error] history requires `query` (words to search for) or `seq` (an entry to reopen).",
        );
      }
      const hits = await tc.history(params.query, params.limit);
      return recordText(
        callId,
        { tool: "history", query: params.query, count: hits.length },
        hits.length
          ? hits.map((h) => `- ${h}`).join("\n")
          : `[nothing in this conversation's transcript matches "${params.query}"]`,
      );
    },
  });
  return { history };
}
