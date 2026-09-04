import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/",
      "**/dist/",
      "**/dist-web/",
      "deploy/layers/",
      "docs/",
      "plugins/web-ui/public/",
      ".claude/",
      ".context/",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
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
        {
          // Never dump a raw error object to the console: an error can carry HTTP
          // response bodies, connection strings, or credential material. Wrap it in
          // errMessage(...) (src/util/errors.ts) so only the message is logged.
          selector: "CallExpression[callee.object.name='console'] > Identifier.arguments[name=/^(e|err|error)$/]",
          message:
            "Pass errMessage(e), not the raw error object, to console.* — raw errors can leak response bodies or secrets into logs.",
        },
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
    // Same raw-error rule for plugin server code and the src files the env-boundary
    // block above deliberately skips (local scripts/ and test/ CLIs keep full stacks).
    files: ["plugins/**/*.ts", "src/config.ts", "src/index.ts", "src/runs/worker-main.ts", "src/egress-authz-main.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='console'] > Identifier.arguments[name=/^(e|err|error)$/]",
          message:
            "Pass errMessage(e), not the raw error object, to console.* — raw errors can leak response bodies or secrets into logs.",
        },
      ],
    },
  },
);
