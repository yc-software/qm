import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MemoryFactsMissing } from "../../memory/facts.ts";
import { MemoryDisclosureDenied } from "../../memory/disclosure.ts";
import { problemLine } from "../../memory/provider-outcome.ts";
import { quotedData } from "../../util/text.ts";
import { text, type ToolKit } from "./kit.ts";

export function recallTools(kit: ToolKit) {
  const { ref, opts, recordCall, recordResult } = kit;
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
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("search"),
        Type.Literal("read"),
        Type.Literal("add"),
        Type.Literal("edit"),
        Type.Literal("delete"),
      ]),
      query: Type.Optional(Type.String({ description: "search: words to look for (all must match)." })),
      limit: Type.Optional(Type.Integer({ description: "search: max facts (default 20)." })),
      scope: Type.Optional(
        Type.String({
          description: "search/read: notebook scope ID from a search result; omit for all readable / your own.",
        }),
      ),
      facts: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.Optional(Type.String({ description: "edit: the fact's id, e.g. #42." })),
            text: Type.String({ description: "One short self-contained fact." }),
          }),
          { description: "add: [{text}, …]; edit: [{id, text}, …]." },
        ),
      ),
      ids: Type.Optional(Type.Array(Type.String(), { description: "delete: ids of the facts to forget." })),
    }),
    async execute(callId, params) {
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
      const fail = (error: string) =>
        recordResult(callId, { tool: "memory", action, error }, text(`[error] ${error}`), true);
      const unavailable = () =>
        recordResult(
          callId,
          { tool: "memory", action, unavailable: true },
          text("[memory isn't available in this conversation]"),
          true,
        );
      if (params.scope !== undefined && action !== "search" && action !== "read") {
        return recordResult(
          callId,
          { tool: "memory", action, error: "scope is read-only" },
          text("[error] scope is only allowed for memory search/read; writes stay in this conversation."),
          true,
        );
      }
      if (opts?.readOnly && action !== "search" && action !== "read") {
        return recordResult(
          callId,
          { tool: "memory", action, readOnly: true },
          text("[this is a read-only wake — memory can be searched and read here, but not written]"),
          true,
        );
      }
      const facts = (params.facts ?? []).map((fact) => ({ id: fact.id?.trim() ?? "", text: fact.text.trim() }));
      try {
        switch (action) {
          case "search": {
            const query = params.query ?? "";
            if (!query.trim()) return fail("memory search requires `query`.");
            const found = await tc.memorySearch(query, params.limit, params.scope);
            if (found === null) return unavailable();
            const { hits, problems } = found;
            const lines = [...problems.map(problemLine), ...(hits.length ? [quotedData(hits.join("\n"))] : [])];
            return recordResult(
              callId,
              { tool: "memory", action, query, count: hits.length, ...(problems.length ? { problems } : {}) },
              text(lines.length ? lines.join("\n") : `[no remembered facts match "${query}"]`),
            );
          }
          case "read": {
            const body = await tc.memoryRead(params.scope);
            if (body === null) return unavailable();
            return recordResult(
              callId,
              { tool: "memory", action, chars: body.length },
              text(body.trim() ? body : "(you have nothing remembered here yet)"),
            );
          }
          case "add": {
            const texts = facts.map((fact) => fact.text).filter(Boolean);
            if (!texts.length) return fail("memory add requires `facts` (a non-empty list of {text}).");
            const written = await tc.memoryAdd(texts);
            if (written === null) return unavailable();
            const { added, outcomes, problems } = written;
            const lines = problems.map(problemLine);
            if (added) lines.unshift(`Remembered ${added} fact${added === 1 ? "" : "s"}.`);
            else if (!problems.length) lines.push("Already remembered — nothing new to save.");
            for (const { provider } of outcomes.filter(({ outcome }) => outcome === "pending"))
              lines.push(`Memory provider ${provider} accepted the facts and stores them later.`);
            return recordResult(
              callId,
              {
                tool: "memory",
                action,
                added,
                ...(outcomes.length ? { outcomes } : {}),
                ...(problems.length ? { problems } : {}),
              },
              text(lines.join("\n")),
              problems.length > 0 && !added,
            );
          }
          case "edit": {
            if (!facts.length || facts.some((fact) => !fact.id || !fact.text))
              return fail("memory edit requires `facts` as a non-empty list of {id, text}.");
            if ((await tc.memoryEdit(facts)) === null) return unavailable();
            return recordResult(
              callId,
              { tool: "memory", action, edited: facts.length },
              text(`Updated ${facts.length} fact${facts.length === 1 ? "" : "s"}.`),
            );
          }
          case "delete": {
            const ids = (params.ids ?? []).map((id) => id.trim()).filter(Boolean);
            if (!ids.length) return fail("memory delete requires `ids` (a non-empty list).");
            if ((await tc.memoryDelete(ids)) === null) return unavailable();
            return recordResult(
              callId,
              { tool: "memory", action, deleted: ids.length },
              text(`Forgot ${ids.length} fact${ids.length === 1 ? "" : "s"}.`),
            );
          }
        }
      } catch (e) {
        if (e instanceof MemoryFactsMissing || e instanceof MemoryDisclosureDenied) return fail(e.message);
        throw e;
      }
    },
  });

  const history = defineTool({
    name: "history",
    label: "history",
    description:
      "Search or reopen this conversation's own transcript (including parts compacted out of context; tool results excluded) when something said earlier is not in front of you. " +
      "`query` returns the newest matching entries tagged type#seq; `seq` returns one entry (very long ones trimmed in the middle).",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Words to find (all must match, case-insensitive)." })),
      seq: Type.Optional(Type.Integer({ description: "Reopen this entry instead of searching." })),
      limit: Type.Optional(Type.Integer({ description: "Max entries for query mode (default 20)." })),
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
          return recordResult(
            callId,
            { tool: "history", error: "seq must be an integer" },
            text("[error] history `seq` must be an integer entry number, like the 87 in tool_call#87."),
            true,
          );
        }
        const entry = await tc.historyOpen(seq);
        return recordResult(
          callId,
          { tool: "history", seq, found: entry !== null },
          text(entry ?? `[no entry with seq ${seq} is visible in this conversation's transcript]`),
        );
      }
      if (!params.query?.trim()) {
        return recordResult(
          callId,
          { tool: "history", error: "query or seq required" },
          text("[error] history requires `query` (words to search for) or `seq` (an entry to reopen)."),
          true,
        );
      }
      const hits = await tc.history(params.query, params.limit);
      return recordResult(
        callId,
        { tool: "history", query: params.query, count: hits.length },
        text(
          hits.length
            ? hits.map((h) => `- ${h}`).join("\n")
            : `[nothing in this conversation's transcript matches "${params.query}"]`,
        ),
      );
    },
  });

  return { memory, history };
}
