import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const ENV_BOUNDARY =
  "Read configuration through loadConfig() (src/config.ts) and pass it down — process.env is parsed exactly once at the boundary.";
const RAW_ERROR_TO_CONSOLE = {
  selector: "CallExpression[callee.object.name='console'] > Identifier.arguments[name=/^(e|err|error)$/]",
  message:
    "Pass errMessage(e), not the raw error object, to console.* — raw errors can leak response bodies or secrets into logs.",
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
      "docs/",
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
    files: ["src/**/*.ts", "plugins/**/*.ts", "scripts/**/*.ts", "cli/**/*.ts", "test/**/*.ts"],
    ignores: ["src/tenant.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/config.ts"],
              importNames: ["processOrgId"],
              message: "Read the org through tenant() (src/tenant.ts) so it follows the active tenant context.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/config.ts", "src/index.ts", "src/egress-authz-main.ts", "src/tenant-import-main.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: ENV_BOUNDARY,
        },
        {
          selector: "MemberExpression[object.name='process'][computed=true][property.value='env']",
          message: ENV_BOUNDARY,
        },
        RAW_ERROR_TO_CONSOLE,
        {
          selector: "VariableDeclarator[init.name='process'] ObjectPattern Property[key.name='env']",
          message: ENV_BOUNDARY,
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:process",
              importNames: ["env"],
              message: ENV_BOUNDARY,
            },
            {
              name: "process",
              importNames: ["env"],
              message: ENV_BOUNDARY,
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    ignores: ["test/**", "**/test/**", "**/*.test.*", "**/vendor/**", "docs/**", "adrs/**"],
    rules: {
      "max-lines": ["error", 800],
      "max-lines-per-function": ["error", 150],
    },
  },
  {
    files: [
      "plugins/**/*.ts",
      "src/config.ts",
      "src/index.ts",
      "src/egress-authz-main.ts",
      "src/tenant-import-main.ts",
    ],
    rules: {
      "no-restricted-syntax": ["error", RAW_ERROR_TO_CONSOLE],
    },
  },
);
