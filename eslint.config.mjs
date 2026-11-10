import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const rawErrorRule = {
  selector: "CallExpression[callee.object.name='console'] > Identifier.arguments[name=/^(e|err|error)$/]",
  message:
    "Pass errMessage(e), not the raw error object, to console.* — raw errors can leak response bodies or secrets into logs.",
};

const rawPipeRule = {
  selector: "CallExpression[callee.property.name='pipe']:not([arguments.0.callee.object.name='z'])",
  message:
    "Relay streams with relayStream() (plugins/chassis/src/http.ts) — a raw .pipe() leaves upstream errors unhandled and crashes the process.",
};

const noComments = {
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments())
          if (comment.type !== "Shebang")
            context.report({
              loc: comment.loc,
              message:
                "Comments are not allowed (AGENTS.md). Delete it; rationale goes in the commit message or PR description.",
            });
      },
    };
  },
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/",
      "src/deploy/vendor/",
      "**/dist/",
      "**/dist-web/",
      "data/",
      "deploy/layers/",
      "plugins/web-ui/public/",
      ".claude/",
      ".context/",
      ".generated/",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: [
      "desktop/preload.cjs",
      "desktop/workspace-preload.cjs",
      "desktop/permissions-preload.cjs",
      "desktop/runtime-preload.cjs",
    ],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: [
      "desktop/setup.js",
      "desktop/cursor.js",
      "desktop/workspace-preload.cjs",
      "desktop/permissions.js",
      "desktop/runtime.js",
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["plugins/web-ui/src/admin/controller.js"],
    languageOptions: { globals: globals.browser },
  },
  {
    plugins: { qm: { rules: { "no-comments": noComments } } },
    linterOptions: { noInlineConfig: true },
    rules: {
      "qm/no-comments": "error",
      "no-empty": ["error", { allowEmptyCatch: false }],

      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],

      "@typescript-eslint/no-explicit-any": "off",

      "no-control-regex": "off",

      "no-nested-ternary": "error",
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/config.ts", "src/index.ts", "src/runs/worker-main.ts", "src/egress-authz-main.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            "Read configuration through loadConfig() (src/config.ts) and pass it down — process.env is parsed exactly once at the boundary.",
        },
        {
          selector: "MemberExpression[object.name='process'][computed=true][property.value='env']",
          message:
            "Read configuration through loadConfig() (src/config.ts) and pass it down — process.env is parsed exactly once at the boundary.",
        },
        rawErrorRule,
        rawPipeRule,
        {
          selector: "VariableDeclarator[init.name='process'] ObjectPattern Property[key.name='env']",
          message:
            "Read configuration through loadConfig() (src/config.ts) and pass it down — process.env is parsed exactly once at the boundary.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:process",
              importNames: ["env"],
              message:
                "Read configuration through loadConfig() (src/config.ts) and pass it down — process.env is parsed exactly once at the boundary.",
            },
            {
              name: "process",
              importNames: ["env"],
              message:
                "Read configuration through loadConfig() (src/config.ts) and pass it down — process.env is parsed exactly once at the boundary.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["plugins/**/*.ts", "src/config.ts", "src/index.ts", "src/runs/worker-main.ts", "src/egress-authz-main.ts"],
    rules: {
      "no-restricted-syntax": ["error", rawErrorRule, rawPipeRule],
    },
  },
  {
    files: [
      "src/api/routes/**/*.ts",
      "src/loops/**/*.ts",
      "src/persistence/**/*.ts",
      "src/runs/**/*.ts",
      "src/util/event-bus.ts",
    ],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: { "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }] },
  },
  {
    files: ["plugins/chassis/src/http.ts"],
    rules: { "no-restricted-syntax": ["error", rawErrorRule] },
  },
);
