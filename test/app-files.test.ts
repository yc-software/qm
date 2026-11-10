import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import { createToolContext } from "../src/tools/primitives.ts";
import { createDeployStore, deployCurrentGitRef } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import type { DeployEndpoint, DeployProvider } from "../src/deploy/deploy-provider.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import type { Item, NewItem } from "../src/sessions/items.ts";
import { scopeId } from "../src/types.ts";
import type { Agent } from "../src/agent/agent.ts";
import { buildApp } from "./support/build-app.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { testConfig } from "./support/test-config.ts";
import { testDeployBackings, testDatabaseUrl } from "./support/test-database.ts";

const ENDPOINT: DeployEndpoint = { host: "body", port: 443, tls: true };
const OWNER = "U1";
const INDEX = '<link rel="stylesheet" href="styles.css">\n<h1 class="title">Notes</h1>\n';
const STYLES = ".title { color: black; }\n.card { color: black; }\n";

interface Written {
  files: Record<string, string>;
  deletedPaths: string[];
}

function harness(opts: { liveEdits?: boolean } = {}) {
  const writes: Written[] = [];
  const placed: Array<string | undefined> = [];
  const provider: DeployProvider = {
    profile: { managedScaleToZero: true },
    apply: async () => {
      throw new Error("git-backed versions are reconciled");
    },
    reconcile: async (_d, version) => {
      placed.push(version.commit);
      return ENDPOINT;
    },
    resolveEndpoint: async () => ENDPOINT,
    destroy: async () => {},
    ...(opts.liveEdits === false
      ? {}
      : {
          liveEdit: async (_d, _version, edit) => {
            writes.push({
              files: Object.fromEntries(edit.files.map((f) => [f.path, Buffer.from(f.data).toString()])),
              deletedPaths: edit.deletedPaths,
            });
            return true;
          },
        }),
  };
  const deployStore = createDeployStore(testDeployBackings());
  const deploy = createDeployService({
    ...singleProcessDeps(),
    deployStore,
    provider,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(createPostgresGrantStore(testDatabaseUrl())),
    deployDir: mkdtempSync(join(tmpdir(), "app-files-")),
  });
  const publish = (name: string, files: Record<string, string> = { "index.html": INDEX, "styles.css": STYLES }) =>
    deploy.deploy({
      ownerScopeId: scopeId("personal", OWNER),
      createdBy: OWNER,
      name,
      entrypoint: "npx serve -l $PORT",
      files: Object.entries(files).map(([path, data]) => ({ path, data })),
    });
  const noComputer = new Proxy({} as Sandbox, {
    get: (_target, property) => {
      throw new Error(`app_files reached for the computer: sandbox.${String(property)}`);
    },
  });
  const chat = (editingApp: string | undefined, by = OWNER, inlineTokens = 4096) => {
    const results: Array<Record<string, unknown>> = [];
    const current = createToolContext({
      sandbox: noComputer,
      provision: async () => {
        throw new Error("app_files provisioned a computer");
      },
      writableScopeId: scopeId("personal", by),
      readOnlyScopeIds: [],
      commandPolicy: () => ({}) as never,
      authorizeCommand: () => false,
      grantedHandles: [],
      deploy,
      ...(editingApp ? { editingApp } : {}),
      acl: {} as never,
      createdBy: by,
      toolOutput: { inlineTokens: async () => inlineTokens, save: async () => "blob", read: async () => null },
    });
    const tools = createAgentTools({
      current,
      scopeLabel: scopeId("personal", by),
      emit: async (item: NewItem) => {
        if (item.kind === "ToolResult") results.push(item.body ?? {});
        return undefined as Item | undefined;
      },
    });
    const tool = tools.find((t) => t.name === "app_files");
    const call = async (params: Record<string, unknown>): Promise<string> => {
      assert.ok(tool, "app_files is offered");
      const out = await (tool.execute as unknown as (id: string, p: unknown) => Promise<unknown>)("call", params);
      return (out as { content: Array<{ text: string }> }).content[0]!.text;
    };
    return { call, results, offered: tools.map((t) => t.name) };
  };
  return { deploy, deployStore, publish, chat, writes, placed };
}

test("app_files is offered only in a chat bound to an app", () => {
  const h = harness();
  assert.ok(h.chat("notes").offered.includes("app_files"));
  assert.ok(!h.chat(undefined).offered.includes("app_files"));
});

test("replacements across two files are one save that writes only those files into the running app", async () => {
  const h = harness();
  const d = await h.publish("notes");
  const chat = h.chat("notes");

  const out = await chat.call({
    action: "edit",
    edits: [
      { path: "styles.css", old: ".title { color: black; }", new: ".title { color: teal; }" },
      { path: "index.html", old: "Notes", new: "My notes" },
    ],
  });

  assert.equal(h.writes.length, 1, "one save, so one reload");
  assert.deepEqual(h.writes[0], {
    files: {
      "index.html": INDEX.replace("Notes", "My notes"),
      "styles.css": STYLES.replace(".title { color: black; }", ".title { color: teal; }"),
    },
    deletedPaths: [],
  });
  assert.match(out, /^Saved index\.html, styles\.css\. It is live/);
  const draft = (await h.deployStore.draftOf(d.id))!;
  assert.ok(Math.abs(draft.publishAt! - (Date.now() + 120_000)) < 5_000, "a version is due two minutes later");
  assert.equal(await h.deployStore.refOf(d.id, deployCurrentGitRef), draft.commit, "a clone starts from the edit");
  assert.equal((await h.deployStore.get(d.id))!.versions.length, 1, "no version is published for an edit");
  const tree = await h.deployStore.commitTreeOf(d.id, draft.commit);
  assert.deepEqual(
    chat.results.at(-1)!.saved,
    ["index.html", "styles.css"].map((path) => ({ path, sha: tree.find((f) => f.path === path)!.sha })),
    "the recorded result names each saved path with its git blob",
  );
});

test("reads and later edits see the saved edits, not the last published version", async () => {
  const h = harness();
  await h.publish("notes");
  const chat = h.chat("notes");
  await chat.call({ action: "edit", edits: [{ path: "index.html", old: "Notes", new: "My notes" }] });

  assert.equal(await chat.call({ action: "read", path: "index.html" }), INDEX.replace("Notes", "My notes"));
  await chat.call({ action: "edit", edits: [{ path: "index.html", old: "My notes", new: "Our notes" }] });
  assert.deepEqual(h.writes[1], { files: { "index.html": INDEX.replace("Notes", "Our notes") }, deletedPaths: [] });
  assert.equal(await chat.call({ action: "read", path: "styles.css" }), STYLES, "untouched files are kept");
});

test("list shows each file with its size, and read returns a line range on request", async () => {
  const h = harness();
  await h.publish("notes", { "index.html": INDEX, "src/a.txt": "one\ntwo\nthree\nfour\n" });
  const chat = h.chat("notes");

  assert.equal(await chat.call({ action: "list" }), `index.html (${INDEX.length} bytes)\nsrc/a.txt (19 bytes)`);
  assert.equal(
    await chat.call({ action: "read", path: "src/a.txt", from: 2, to: 3 }),
    "[src/a.txt lines 2-3 of 5]\ntwo\nthree",
  );
  assert.match(await chat.call({ action: "read", path: "missing.txt" }), /no such file: missing\.txt/);
});

test("a file too long for one result is read in pieces without leaving the tool", async () => {
  const h = harness();
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`);
  await h.publish("notes", { "long.txt": lines.join("\n") });
  const chat = h.chat("notes", OWNER, 300);

  const first = await chat.call({ action: "read", path: "long.txt" });
  const header = /^\[long\.txt lines 1-(\d+) of 400; too long to show at once, read on with from (\d+)\]\n/.exec(
    first,
  )!;
  assert.ok(header, first.slice(0, 120));
  const shown = Number(header[1]);
  assert.equal(Number(header[2]), shown + 1);
  assert.equal(first.slice(header[0].length), lines.slice(0, shown).join("\n"));
  assert.ok(first.length <= 1200, "the piece fits the inline result budget");
  const rest = await chat.call({ action: "read", path: "long.txt", from: shown + 1, to: shown + 2 });
  assert.equal(rest, `[long.txt lines ${shown + 1}-${shown + 2} of 400]\nline ${shown + 1}\nline ${shown + 2}`);
});

test("a replacement that does not match exactly once saves nothing, even beside one that does", async () => {
  const h = harness();
  const d = await h.publish("notes");
  const chat = h.chat("notes");

  const ambiguous = await chat.call({
    action: "edit",
    edits: [
      { path: "index.html", old: "Notes", new: "My notes" },
      { path: "styles.css", old: "color: black;", new: "color: teal;" },
    ],
  });
  assert.match(ambiguous, /replacement 2: the old text occurs 2 times in styles\.css/);
  const missing = await chat.call({ action: "edit", edits: [{ path: "styles.css", old: "color: red;", new: "x" }] });
  assert.match(missing, /replacement 1: the old text is not in styles\.css/);
  assert.match(
    await chat.call({ action: "edit", edits: [{ path: "nope.css", old: "a", new: "b" }] }),
    /no such file: nope\.css/,
  );

  assert.equal(h.writes.length, 0);
  assert.equal(await h.deployStore.draftOf(d.id), null);
});

test("write creates or replaces a file and delete removes one, each as a save", async () => {
  const h = harness();
  await h.publish("notes");
  const chat = h.chat("notes");

  assert.match(await chat.call({ action: "write", path: "about.html", data: "<p>About</p>" }), /^Saved about\.html\./);
  assert.match(await chat.call({ action: "delete", path: "styles.css" }), /^Saved styles\.css \(deleted\)\./);
  assert.deepEqual(h.writes, [
    { files: { "about.html": "<p>About</p>" }, deletedPaths: [] },
    { files: {}, deletedPaths: ["styles.css"] },
  ]);
  assert.equal(await chat.call({ action: "list" }), `about.html (12 bytes)\nindex.html (${INDEX.length} bytes)`);
  assert.match(await chat.call({ action: "delete", path: "styles.css" }), /no such file: styles\.css/);
  assert.match(await chat.call({ action: "write", path: "../outside.txt", data: "x" }), /invalid deploy path/);
  assert.equal(h.writes.length, 2);
});

test("saving content the app already has changes nothing", async () => {
  const h = harness();
  const d = await h.publish("notes");
  const chat = h.chat("notes");

  assert.match(await chat.call({ action: "write", path: "styles.css", data: STYLES }), /^Nothing to save/);
  assert.equal(h.writes.length, 0);
  assert.equal(await h.deployStore.draftOf(d.id), null);
});

test("on a provider without live edits each change is published as a version, and the result says so", async () => {
  const h = harness({ liveEdits: false });
  const d = await h.publish("notes");
  const chat = h.chat("notes");

  const out = await chat.call({ action: "edit", edits: [{ path: "index.html", old: "Notes", new: "My notes" }] });

  assert.match(out, /^Saved index\.html and published it as v2\..*takes longer to show/);
  const after = (await h.deployStore.get(d.id))!;
  assert.equal(after.currentVersion, 2);
  assert.equal(h.placed.length, 2, "the app was placed again on the new version");
  assert.equal(h.placed[1], after.versions[1]!.commit);
  assert.equal(await chat.call({ action: "read", path: "index.html" }), INDEX.replace("Notes", "My notes"));
  assert.equal(await h.deployStore.draftOf(d.id), null);
});

test("someone without write access to the app can neither read nor change its files", async () => {
  const h = harness();
  const d = await h.publish("notes");
  const stranger = h.chat("notes", "U2");

  for (const params of [
    { action: "list" },
    { action: "read", path: "index.html" },
    { action: "edit", edits: [{ path: "index.html", old: "Notes", new: "pwned" }] },
    { action: "write", path: "index.html", data: "pwned" },
    { action: "delete", path: "index.html" },
  ]) {
    const out = await stranger.call(params);
    assert.match(out, /you need write access to the app "notes"/, JSON.stringify(params));
    assert.doesNotMatch(out, /Notes/);
  }
  assert.equal(h.writes.length, 0);
  assert.equal(await h.deployStore.draftOf(d.id), null);
});

test("a turn gets app_files bound to its thread's app only in the person's own app edit chat", async () => {
  const bound: Record<string, string | undefined> = {};
  const mock = createMockAgent();
  const agent: Agent = {
    ...mock,
    runTurn: async (input) => {
      bound[input.session.threadRef] = input.tools.appFiles?.app;
      return mock.runTurn(input);
    },
  };
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "app-files-turn-")) }), { agent });
  const turn = (threadRef: string) =>
    built.app.turn({
      surface: "web",
      actor: { externalId: OWNER },
      conversation: { kind: "dm", threadRef },
      text: "hi",
    });

  assert.equal((await turn(`web:${OWNER}:app-edit:notes`)).status, "ok");
  assert.equal((await turn(`web:${OWNER}:default`)).status, "ok");
  assert.equal((await turn("web:U2:app-edit:notes")).status, "refused");

  assert.deepEqual(bound, { [`web:${OWNER}:app-edit:notes`]: "notes", [`web:${OWNER}:default`]: undefined });
});
