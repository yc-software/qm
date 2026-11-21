import assert from "node:assert/strict";
import test from "node:test";
import { plan, select } from "../scripts/select-ci.ts";

const tree: Record<string, string> = {
  "src/a.ts": 'import { b } from "./b.ts";\nexport const a = b;\n',
  "src/b.ts": "export const b = 1;\n",
  "src/shape.ts": "export type Shape = { b: number };\n",
  "src/named.ts": "export type Named = string;\n",
  "src/lazy.ts": "export const lazy = 1;\n",
  "src/migrate-main.ts": 'import "./b.ts";\n',
  "src/prompt.md": "Be brief.\n",
  "src/tenants/context.ts": "export const tenant = 1;\n",
  "test/a.test.ts": 'import { a } from "../src/a.ts";\nimport type { Shape } from "../src/shape.ts";\n',
  "test/named.test.ts": 'import { type Named } from "../src/named.ts";\n',
  "test/typeof.test.ts":
    'let lazy: typeof import("../src/lazy.ts");\nlet value: import("../src/lazy.ts").Lazy;\nexport { lazy, value };\n',
  "test/dynamic.test.ts": 'await import("../src/lazy.ts");\n',
  "test/upgrade.test.ts": 'execFileSync("node", ["src/migrate-main.ts"]);\n',
  "test/plain.test.ts": 'const mode = "test";\nconst root = "src";\n',
  "test/helper.test.ts": 'import { fixture } from "./support/fixture.ts";\n',
  "test/support/fixture.ts": "export const fixture = 1;\n",
  "test/support/test-tenant.ts": 'import "../../src/tenants/context.ts";\n',
  "plugins/web-ui/src/view.ts": 'import { b } from "../../../src/b.ts";\n',
  "cli/src/cli.ts": 'execFileSync("node", ["src/migrate-main.ts"]);\n',
  "docs/guide.md": "Guide\n",
  "deploy/core/Dockerfile": "COPY --from=build /out ./out\nCOPY src ./src\nCOPY plugins/web-ui/src ./web\n",
};
const run = (...changed: string[]) => select(changed, Object.keys(tree), (path) => tree[path]!);

test("a change selects the root tests whose runtime imports reach it", () => {
  assert.deepEqual(run("src/b.ts"), {
    core: ["test/a.test.ts", "test/upgrade.test.ts"],
    webUi: true,
    cli: false,
    coreImage: true,
  });
  assert.deepEqual(run("test/support/fixture.ts").core, ["test/helper.test.ts"]);
  assert.deepEqual(run("src/migrate-main.ts").core, ["test/upgrade.test.ts"]);
  assert.deepEqual(run("test/removed.test.ts").core, []);
});

test("type-only imports load nothing, while a named type specifier and a dynamic import still load", () => {
  assert.deepEqual(run("src/shape.ts").core, []);
  assert.deepEqual(run("src/named.ts").core, ["test/named.test.ts"]);
  assert.deepEqual(run("src/lazy.ts").core, ["test/dynamic.test.ts"]);
});

test("dependencies, CI, runners, runtime files under src and startup skills run everything", () => {
  for (const path of [
    "package-lock.json",
    "tsconfig.json",
    ".github/workflows/cicd.yml",
    "scripts/run-pg-tests.mjs",
    "test/support/test-template.ts",
    "src/prompt.md",
    "src/tenants/context.ts",
    "skills-seed/brief/SKILL.md",
    "plugins/web-ui/skills/brief/SKILL.md",
  ])
    assert.deepEqual(run(path), { core: "all", webUi: true, cli: true, coreImage: true }, path);
});

test("files no suite can reach select nothing, and suites run on their own paths", () => {
  assert.deepEqual(run("docs/guide.md"), { core: [], webUi: false, cli: false, coreImage: false });
  assert.deepEqual(run("plugins/web-ui/src/view.ts"), { core: [], webUi: true, cli: false, coreImage: true });
  assert.deepEqual(run("cli/src/cli.ts"), { core: [], webUi: false, cli: true, coreImage: false });
  assert.deepEqual(run("deploy/core/Dockerfile"), { core: [], webUi: false, cli: false, coreImage: true });
  assert.deepEqual(run(), { core: [], webUi: false, cli: false, coreImage: false });
});

test("tests reach what they list, name from the root, fill into a path or copy into the image", () => {
  const inputs: Record<string, string> = {
    ...tree,
    ".env.example": "PORT=\n",
    "src/vendor/bar.js": "export {};\n",
    "src/asset.ts": "readFileSync(new URL(`./vendor/bar.${name}`, import.meta.url));\n",
    "src/config.ts": 'readdirSync("./plugins");\n',
    "test/boot.test.ts": 'import "../src/config.ts";\nreaddirSync(`docs/drafts/${name}`);\n',
    "test/brand.test.ts": 'execSync("git ls-files -z");\n',
    "test/child.test.ts": 'spawn("node", ["-e", "import(\'./src/asset.ts\')"]);\nreadFileSync(".env.example");\n',
    "test/image.test.ts": 'readFileSync("deploy/core/Dockerfile");\n',
  };
  const reach = (path: string) => select([path], Object.keys(inputs), (file) => inputs[file]!).core;
  assert.deepEqual(reach("docs/guide.md"), ["test/brand.test.ts"]);
  assert.deepEqual(reach(".env.example"), ["test/brand.test.ts", "test/child.test.ts"]);
  assert.deepEqual(reach("src/vendor/bar.js"), ["test/brand.test.ts", "test/child.test.ts", "test/image.test.ts"]);
  assert.deepEqual(reach("plugins/web-ui/src/view.ts"), ["test/brand.test.ts", "test/image.test.ts"]);
});

test("shards scale with the selected test time", () => {
  const timings = { "test/a.test.ts": 600, "test/b.test.ts": 200, "test/c.test.ts": 1120 };
  assert.deepEqual(plan({ core: "all", webUi: true, cli: true, coreImage: true }, timings), {
    seconds: 1920,
    share: 1,
    shards: 8,
  });
  assert.equal(
    plan({ core: ["test/a.test.ts", "test/b.test.ts"], webUi: false, cli: false, coreImage: false }, timings).shards,
    2,
  );
  assert.equal(plan({ core: ["test/b.test.ts"], webUi: false, cli: false, coreImage: false }, timings).shards, 1);
  assert.equal(plan({ core: [], webUi: false, cli: false, coreImage: false }, timings).shards, 0);
});
