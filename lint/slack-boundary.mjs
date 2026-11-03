import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const allowlist = JSON.parse(readFileSync(resolve(import.meta.dirname, "slack-boundary-allowlist.json"), "utf8"));
const slackDirs = ["src/slack/", "src/surfaces/slack/"];
const compositionRoot = ["src/wiring.ts", "src/index.ts"];

export const slackBoundaryFiles = ["src/**/*.ts"];
export const slackBoundaryExempt = [...slackDirs.map((dir) => `${dir}**`), ...compositionRoot];

const repoPath = (absolute) => relative(root, absolute).split(sep).join("/");
const specifier = (source) => {
  if (source?.type === "Literal" && typeof source.value === "string") return source.value;
  if (source?.type === "TemplateLiteral" && source.expressions.length === 0) return source.quasis[0].value.cooked;
  if (source?.type === "TSLiteralType") return specifier(source.literal);
  return undefined;
};

export const slackBoundary = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      newImport: `Reach Slack through the Surface contract (src/surfaces/contract.ts) and the surface registry instead of importing {{target}}. Only ${slackBoundaryExempt.join(", ")} may import Slack internals.`,
      staleEntry:
        "{{file}} does not import {{target}}; delete that entry from lint/slack-boundary-allowlist.json so the allowlist only shrinks.",
    },
  },
  create(context) {
    const file = repoPath(context.filename);
    const allowed = new Set(allowlist[file] ?? []);
    const seen = new Set();
    const check = (source) => {
      const spec = specifier(source);
      if (!spec?.startsWith(".")) return;
      const target = repoPath(resolve(dirname(context.filename), spec));
      if (!slackDirs.some((dir) => target.startsWith(dir))) return;
      seen.add(target);
      if (!allowed.has(target)) context.report({ node: source, messageId: "newImport", data: { target } });
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) => check(node.argument),
      "Program:exit": (node) => {
        for (const target of allowed)
          if (!seen.has(target)) context.report({ node, messageId: "staleEntry", data: { file, target } });
      },
    };
  },
};
