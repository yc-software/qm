import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { normalizeRelPath } from "../../deploy/deploy-fs.ts";
import type { SourceSaved } from "../../deploy/deploy-service.ts";
import { inlineChars, inlineTokensOf } from "../../sessions/tool-output.ts";
import type { AppFiles } from "../../tools/app-files.ts";
import { errMessage } from "../../util/errors.ts";
import { text, type ToolKit } from "./kit.ts";
import { previousPublishFailure } from "./workspace.ts";

const RANGE_NOTE_CHARS = 200;

function textOf(file: { path: string; data: Uint8Array }): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(file.data);
  } catch {
    throw new Error(`${file.path} is not UTF-8 text (${file.data.byteLength} bytes), so it cannot be read or edited`);
  }
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) count++;
  return count;
}

function describeSaved(r: SourceSaved): string {
  const paths = [...r.saved.map((f) => f.path), ...r.deleted.map((path) => `${path} (deleted)`)];
  if (!paths.length) return "Nothing to save: the app's files already have this content.";
  if (!r.liveEdit)
    return `Saved ${paths.join(", ")} and published it as v${r.version}. This app cannot be edited while it runs, so each change is a full publish and takes longer to show.`;
  const shown = r.liveEdit.hot
    ? "It is live: open tabs hot-reloaded it."
    : "It is live: the app restarted with it and open tabs reload within seconds.";
  return `Saved ${paths.join(", ")}. ${shown}${previousPublishFailure(r.liveEdit)}`;
}

export function appFileTools(kit: ToolKit) {
  const { ref, recordCall, recordResult } = kit;

  async function run(
    callId: string,
    call: Record<string, unknown>,
    work: (files: AppFiles) => Promise<{ body?: Record<string, unknown>; result: string }>,
  ) {
    const files = ref.current?.appFiles;
    if (!files) return text("[error] no active tool context");
    const summary = { tool: "app_files", ...call };
    await recordCall(callId, summary);
    try {
      const done = await work(files);
      return await recordResult(callId, { ...summary, ...done.body }, text(done.result));
    } catch (e) {
      const msg = errMessage(e);
      return recordResult(callId, { ...summary, error: msg }, text(`[app_files failed] ${msg}`), true);
    }
  }

  const save = (
    callId: string,
    call: Record<string, unknown>,
    edit: Parameters<AppFiles["save"]>[0],
  ): ReturnType<typeof run> =>
    run(callId, call, async (files) => {
      const saved = await files.save(edit);
      return {
        body: {
          saved: saved.saved,
          deleted: saved.deleted,
          ...(saved.liveEdit ? { liveEdit: saved.liveEdit } : { version: saved.version }),
        },
        result: describeSaved(saved),
      };
    });

  const list = defineTool({
    name: "list",
    label: "list",
    description:
      "List the source files of the app this chat sits beside, with sizes. Every app_files action works on that app's saved source held by QM (its latest saved edits), not on a computer.",
    parameters: Type.Object({}),
    execute: (callId) =>
      run(callId, { action: "list" }, async (files) => {
        const { tree } = await files.source();
        return {
          body: { count: tree.length },
          result: tree.map((f) => `${f.path} (${f.size} bytes)`).join("\n") || "The app has no files.",
        };
      }),
  });

  const read = defineTool({
    name: "read",
    label: "read",
    description: "Read one source file: all of it, or the lines `from` to `to`.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to the app root." }),
      from: Type.Optional(Type.Integer({ minimum: 1, description: "First line to return, counting from 1." })),
      to: Type.Optional(Type.Integer({ minimum: 1, description: "Last line to return." })),
    }),
    execute: (callId, params) =>
      run(callId, { action: "read", path: params.path }, async (files) => {
        const path = normalizeRelPath(params.path);
        const file = (await files.source([path])).files[0];
        if (!file) throw new Error(`no such file: ${path}; list shows the app's files`);
        const lines = textOf(file).split("\n");
        const first = Math.min(params.from ?? 1, lines.length);
        const wanted = lines.slice(first - 1, Math.max(params.to ?? lines.length, first));
        const budget = inlineChars(await inlineTokensOf(ref.current?.toolOutput)) - RANGE_NOTE_CHARS;
        let chars = 0;
        const fits = wanted.findIndex((line) => (chars += line.length + 1) > budget);
        const shown = fits > 0 ? wanted.slice(0, fits) : wanted;
        const last = first + shown.length - 1;
        const more = shown.length < wanted.length ? `; too long to show at once, read on with from ${last + 1}` : "";
        const range = shown.length < lines.length ? `[${path} lines ${first}-${last} of ${lines.length}${more}]\n` : "";
        return {
          body: { bytes: file.data.byteLength, ...(range ? { lines: [first, last, lines.length] } : {}) },
          result: `${range}${shown.join("\n")}`,
        };
      }),
  });

  const edit = defineTool({
    name: "edit",
    label: "edit",
    description:
      "Replace exact text in source files and save. Put every replacement for the request, across all its files, in one call: a call is one save and one reload of the running app, and it saves nothing if any replacement fails.",
    parameters: Type.Object({
      edits: Type.Array(
        Type.Object(
          {
            path: Type.String({ description: "File to change." }),
            old: Type.String({
              minLength: 1,
              description: "Exact text to replace. It must occur once in the file, so include enough around it.",
            }),
            new: Type.String({ description: "Text to put in its place." }),
          },
          { additionalProperties: false },
        ),
        { minItems: 1, description: "Replacements, applied in order." },
      ),
    }),
    execute: (callId, params) => {
      const paths = [...new Set(params.edits.map((e) => e.path))];
      return save(callId, { action: "edit", path: paths.join(", "), edits: params.edits.length }, async (source) => {
        const texts = new Map((await source(paths)).files.map((f) => [f.path, textOf(f)]));
        params.edits.forEach((e, i) => {
          const path = normalizeRelPath(e.path);
          const before = texts.get(path);
          if (before === undefined) throw new Error(`no such file: ${path}; nothing was saved`);
          const found = occurrences(before, e.old);
          if (found !== 1)
            throw new Error(
              `replacement ${i + 1}: the old text ${found ? `occurs ${found} times` : "is not"} in ${path}; it must occur once, copied exactly from the file. Nothing was saved`,
            );
          texts.set(
            path,
            before.replace(e.old, () => e.new),
          );
        });
        return { files: [...texts].map(([path, data]) => ({ path, data })), deletedPaths: [] };
      });
    },
  });

  const write = defineTool({
    name: "write",
    label: "write",
    description: "Create one source file, or replace all of an existing one, and save.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to the app root." }),
      data: Type.String({ description: "The whole file's contents." }),
    }),
    execute: (callId, params) =>
      save(callId, { action: "write", path: params.path, bytes: params.data.length }, async () => ({
        files: [{ path: params.path, data: params.data }],
        deletedPaths: [],
      })),
  });

  const remove = defineTool({
    name: "delete",
    label: "delete",
    description: "Delete one source file and save.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to the app root." }),
    }),
    execute: (callId, params) =>
      save(callId, { action: "delete", path: params.path }, async (source) => {
        const path = normalizeRelPath(params.path);
        if (!(await source([])).tree.some((f) => f.path === path)) throw new Error(`no such file: ${path}`);
        return { files: [], deletedPaths: [path] };
      }),
  });

  return { list, read, edit, write, delete: remove };
}
