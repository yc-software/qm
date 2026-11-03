import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const allowlist = JSON.parse(readFileSync(resolve(import.meta.dirname, "slack-boundary-allowlist.json"), "utf8"));

export const slackBoundaryFiles = ["src/**/*.ts"];
export const slackBoundaryExempt = ["src/slack/**", "src/surfaces/slack/**", "src/wiring.ts", "src/index.ts"];

const repoPath = (absolute) => relative(root, absolute).split(sep).join("/");
const isSlackInternal = (target) => target.startsWith("src/slack/") || target.startsWith("src/surfaces/slack/");

export const slackBoundary = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      newImport:
        "Reach Slack through the Surface contract (src/surfaces/contract.ts) and the surface registry instead of importing {{target}}. Only src/slack/**, src/surfaces/slack/** and the composition root (src/wiring.ts, src/index.ts) may import Slack internals.",
      staleEntry:
        "{{file}} does not import {{target}}; delete that entry from lint/slack-boundary-allowlist.json so the allowlist only shrinks.",
    },
  },
  create(context) {
    const file = repoPath(context.filename);
    const allowed = new Set(allowlist[file] ?? []);
    const seen = new Set();
    const check = (source) => {
      if (source?.type !== "Literal" || typeof source.value !== "string" || !source.value.startsWith(".")) return;
      const target = repoPath(resolve(dirname(context.filename), source.value));
      if (!isSlackInternal(target)) return;
      seen.add(target);
      if (!allowed.has(target)) context.report({ node: source, messageId: "newImport", data: { target } });
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) => check(node.argument?.type === "TSLiteralType" ? node.argument.literal : node.argument),
      "Program:exit": (node) => {
        for (const target of allowed)
          if (!seen.has(target)) context.report({ node, messageId: "staleEntry", data: { file, target } });
      },
    };
  },
};
