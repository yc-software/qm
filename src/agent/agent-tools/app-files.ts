import { createEditTool, defineTool, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { normalizeRelPath } from "../../deploy/deploy-fs.ts";
import type { SourceSaved } from "../../deploy/deploy-service.ts";
import { inlineChars, inlineTokensOf } from "../../sessions/tool-output.ts";
import type { AppFiles } from "../../tools/app-files.ts";
import { headSlice, tailSlice, tryDecodeUtf8 } from "../../util/text.ts";
import { errMessage } from "../../util/errors.ts";
import { text, type ToolKit } from "./kit.ts";
import { previousPublishFailure } from "./workspace.ts";

const RANGE_NOTE_CHARS = 200;
const NO_DIRECTORY = "/app-source";
const REPLACEMENTS = createEditTool(NO_DIRECTORY).parameters.properties.edits;

function textOf(file: { path: string; data: Uint8Array }): string {
  const decoded = tryDecodeUtf8(file.data);
  if (decoded === null)
    throw new Error(`${file.path} is not UTF-8 text (${file.data.byteLength} bytes), so it cannot be read or edited`);
  return decoded;
}

function describeSaved(r: SourceSaved): string {
  const paths = [...r.saved.map((f) => f.path), ...r.deleted.map((path) => `${path} (deleted)`)];
  if (!paths.length) return "Nothing to save: the app's files already have this content.";
  if (!r.liveEdit)
    return `Saved ${paths.join(", ")} and published it as v${r.version}. That was a full publish, not an edit of the running app, so it takes longer to show.`;
  const shown =
    r.liveEdit.hot && !r.liveEdit.first
      ? "It is live: open tabs hot-reloaded it."
      : "It is live: the app restarted with it and open tabs reload within seconds.";
  return `Saved ${paths.join(", ")}. ${shown}${previousPublishFailure(r.liveEdit)}`;
}

async function savedText(files: AppFiles, wanted: string) {
  const path = normalizeRelPath(wanted);
  const file = (await files.source([path])).files[0];
  if (!file) throw new Error(`no such file: ${path}; list shows the app's files`);
  return { path, file, content: textOf(file) };
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
        const { path, file, content } = await savedText(files, params.path);
        const lines = content.split("\n");
        const first = Math.min(params.from ?? 1, lines.length);
        const wanted = lines.slice(first - 1, Math.max(params.to ?? lines.length, first));
        const budget = inlineChars(await inlineTokensOf(ref.current?.toolOutput)) - RANGE_NOTE_CHARS;
        const cut = truncateHead(wanted.join("\n"), { maxBytes: budget, maxLines: wanted.length });
        if (cut.firstLineExceedsLimit)
          throw new Error(
            `line ${first} of ${path} is ${formatSize(Buffer.byteLength(wanted[0]!))}, more than one result can show; find returns the exact text around what you are looking for in it`,
          );
        const shown = cut.truncated ? cut.outputLines : wanted.length;
        const last = first + shown - 1;
        const more = cut.truncated ? `; too long to show at once, read on with from ${last + 1}` : "";
        const range = shown < lines.length ? `[${path} lines ${first}-${last} of ${lines.length}${more}]\n` : "";
        return {
          body: { bytes: file.data.byteLength, ...(range ? { lines: [first, last, lines.length] } : {}) },
          result: `${range}${cut.content}`,
        };
      }),
  });

  const find = defineTool({
    name: "find",
    label: "find",
    description:
      "Find exact text in one source file, however long its lines, and return each place it occurs with the exact text around it, to quote in an edit.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to the app root." }),
      text: Type.String({ minLength: 1, description: "Text to look for, matched literally and case-sensitively." }),
      around: Type.Integer({
        minimum: 0,
        description: "How many characters of the file to show before and after each match.",
      }),
    }),
    execute: (callId, params) =>
      run(callId, { action: "find", path: params.path }, async (files) => {
        const { path, content } = await savedText(files, params.path);
        const sought = params.text;
        const excerpts: string[] = [];
        let line = 1;
        let counted = 0;
        for (let at = content.indexOf(sought); at >= 0; at = content.indexOf(sought, at + sought.length)) {
          line += content.slice(counted, at).split("\n").length - 1;
          counted = at;
          const before = tailSlice(content.slice(0, at), params.around);
          const after = headSlice(content.slice(at + sought.length), params.around);
          excerpts.push(`[match ${excerpts.length + 1} at line ${line}]\n${before}${sought}${after}`);
        }
        const title = `[${JSON.stringify(sought)} in ${path}: ${excerpts.length} found]`;
        return { body: { matches: excerpts.length }, result: [title, ...excerpts].join("\n") };
      }),
  });

  const edit = defineTool({
    name: "edit",
    label: "edit",
    description:
      "Replace exact text in source files and save. Put every replacement for the request, across all its files, in one call: a call is one save and one reload of the running app, and it saves nothing if any replacement fails.",
    parameters: Type.Object({
      files: Type.Array(Type.Object({ path: Type.String({ description: "File to change." }), edits: REPLACEMENTS }), {
        minItems: 1,
        description: "Each file to change, with its replacements.",
      }),
    }),
    execute: (callId, params) => {
      const paths = params.files.map((f) => normalizeRelPath(f.path));
      const count = params.files.reduce((sum, f) => sum + f.edits.length, 0);
      return save(callId, { action: "edit", path: paths.join(", "), edits: count }, async (source) => {
        const saved = new Map((await source(paths)).files.map((f) => [f.path, f]));
        const edited = new Map<string, string>();
        for (const [i, { edits }] of params.files.entries()) {
          const path = paths[i]!;
          const file = saved.get(path);
          const replace = createEditTool(NO_DIRECTORY, {
            operations: {
              access: async () => {
                if (!file) throw new Error(`no such file: ${path}; list shows the app's files`);
              },
              readFile: async () => Buffer.from(edited.get(path) ?? textOf(file!)),
              writeFile: async (_path, content) => void edited.set(path, content),
            },
          });
          await replace.execute(callId, { path, edits });
        }
        return { files: [...edited].map(([path, data]) => ({ path, data })), deletedPaths: [] };
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

  return { list, read, find, edit, write, delete: remove };
}
