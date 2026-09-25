import assert from "node:assert/strict";
import test from "node:test";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";

const source = buildSync({
  entryPoints: [new URL("../ui/artifacts.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "artifacts",
  platform: "browser",
}).outputFiles[0].text;
const packsSource = buildSync({
  entryPoints: [new URL("../ui/artifacts-skills.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "skillUI",
  platform: "browser",
}).outputFiles[0].text;
function fixture() {
  const dom = new JSDOM('<div id="shellbar"></div><main></main>', {
    runScripts: "outside-only",
    url: "http://localhost/admin/files",
    pretendToBeVisual: true,
  });
  dom.window.eval(source + ";window.artifacts = artifacts;");
  dom.window.eval(packsSource + ";window.skillUI = skillUI;");
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const root = dom.window.document.querySelector("main")!;
  const c: Record<string, any> = {
    scope: "personal:alice",
    orgId: "acme",
    view: "files",
    index: false,
    own: false,
    apiBase: "",
    scopeKind: (s: string) => s.split(":")[0],
    shortName: (s: string) => s,
    dirLabel: (s: string) => s,
    plural: (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`,
    relTime: () => "just now",
    fmtTime: () => "Today",
    fmtHistoryTime: () => "Today",
    fmtBytes: (n: number) => `${n} B`,
    fileKind: () => "file",
    fileName: (s: string) => s,
    pageShell: (value: any) => {
      c.shell = value;
    },
    memoryDraft: () => c.draft ?? null,
    setMemoryDraft: (draft: string | null) => {
      c.draft = draft;
    },
    api: async () => ({ ok: true, data: {} }),
    go: () => {},
    reload: () => {},
    invalidate: () => {},
    stateToUrl: (s: any) => "/admin/" + s.view + "?scope=" + s.scope,
    shortId: (s: string) => s,
    titleCase: (s: string) => s,
    openScopeRow: () => {},
    fileSha256: async () => "hash",
    uploadErrorMessage: (s: string) => s,
    firstLine: (s: string) => s,
    cronName: (s: any) => s.title || s.id,
    shortSchedule: () => "Daily",
    fmtSchedule: () => "Every day",
    destinationSummary: () => "None",
    destinationDetails: () => "",
    setCronEditing: () => {},
    scopeRows: () => [],
    packRepoLabel: (s: string) => s,
    buildScopeMultiSelect: (_choices: any, selected: Set<string>, onChange: () => void) => {
      c.selectedScopes = selected;
      c.changeScopes = onChange;
      return dom.window.document.createElement("div");
    },
  };
  return { dom, root, c, ui: (dom.window as any).artifacts, skills: (dom.window as any).skillUI };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("memory drafts preserve newer edits through an in-flight save", async () => {
  const { dom, root, c, ui } = fixture();
  let complete: (value: any) => void = () => {};
  const calls: any[] = [];
  c.api = (...args: any[]) => {
    calls.push(args);
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  ui.memory(root, { content: "saved" }, c);
  const input = root.querySelector("textarea")!;
  input.value = "submitted";
  input.dispatchEvent(new dom.window.Event("input"));
  root.querySelector("button")!.click();
  input.value = "newer draft";
  input.dispatchEvent(new dom.window.Event("input"));
  complete({ ok: true });
  await tick();
  assert.equal(calls[0][1], "/api/memory?scope=personal%3Aalice");
  assert.equal(calls[0][2].content, "submitted");
  assert.equal(c.draft, "newer draft");
  assert.equal(root.querySelector("textarea"), input);
  assert.equal(root.querySelector("#st-memory")!.textContent, "Unsaved changes");
  dom.window.close();
});

test("files search renders from query data and preserves keyboard opening", () => {
  const { dom, root, c, ui } = fixture();
  let opened = "";
  c.downloadFile = (row: any) => {
    opened = row.id;
  };
  ui.files(
    root,
    {
      files: [
        { id: "a", name: "alpha.txt", createdAt: 1 },
        { id: "b", name: "beta.txt", createdAt: 2 },
      ],
    },
    c,
  );
  c.shell.search.onInput("alpha");
  assert.equal(root.querySelectorAll(".dense-row").length, 1);
  root.querySelector(".dense-row")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter" }));
  assert.equal(opened, "a");
  c.shell.search.onInput("missing");
  assert.match(root.textContent!, /No files match/);
  dom.window.close();
});

test("scope indexes hide full artifact lists until searching", () => {
  const { dom, root, c, ui } = fixture();
  c.index = true;
  c.deploymentHref = () => "https://example.com/app";
  ui.deployments(root, { deployments: [{ id: "app", name: "App", ownerScopeId: "personal:alice" }] }, c);
  assert.equal(root.querySelectorAll(".dense-list").length, 2);
  c.shell.search.onInput("App");
  const link = root.querySelector<HTMLAnchorElement>('.dense-row[target="_blank"]')!;
  assert.equal(link.href, "https://example.com/app");
  assert.equal(link.rel, "noopener");
  dom.window.close();
});

test("cron destination draft derives placeholders, disabled fields and API payload", async () => {
  const { dom, root, c, ui } = fixture();
  c.cron = "job";
  const calls: any[] = [];
  c.api = async (...args: any[]) => {
    calls.push(args);
    return { ok: true, data: { sessions: [] } };
  };
  ui.crons(root, { crons: [{ id: "job", title: "Daily", ownerScopeId: c.scope }] }, c);
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Edit destination")!.click();
  const select = root.querySelector("select")!;
  select.value = "principal";
  select.dispatchEvent(new dom.window.Event("change"));
  const inputs = root.querySelectorAll<HTMLInputElement>("input");
  assert.equal(inputs[0].placeholder, "principal id");
  assert.equal(inputs[2].disabled, false);
  inputs[0].value = "alice";
  inputs[0].dispatchEvent(new dom.window.Event("input"));
  inputs[2].value = "bob";
  inputs[2].dispatchEvent(new dom.window.Event("input"));
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save destination")!.click();
  await tick();
  const put = calls.find((args) => args[0] === "PUT");
  assert.equal(
    JSON.stringify(put[2]),
    JSON.stringify({ destination: { type: "principal", target: "alice", onBehalfOf: "bob" } }),
  );
  dom.window.close();
});

test("stale async cron renders cannot replace a different page", async () => {
  const { dom, root, c, ui } = fixture();
  c.cron = "job";
  let complete: (value: any) => void = () => {};
  c.api = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  ui.crons(root, { crons: [{ id: "job", title: "Daily", ownerScopeId: c.scope }] }, c);
  root.replaceChildren(dom.window.document.createTextNode("New page"));
  complete({ ok: true, data: { sessions: [] } });
  await tick();
  assert.equal(root.textContent, "New page");
  dom.window.close();
});

test("pack registration draft is collected from state with advanced fields", async () => {
  const { dom, root, c, skills } = fixture();
  const calls: any[] = [];
  c.api = async (...args: any[]) => {
    calls.push(args);
    return { ok: true };
  };
  skills.packs(root, [], c);
  const fields = root.querySelectorAll<HTMLInputElement>("input");
  for (const [i, value] of ["https://example.com/skills", "main", "private/*, drafts/*", "deploy-token"].entries()) {
    fields[i].value = value;
    fields[i].dispatchEvent(new dom.window.Event("input"));
  }
  assert.match(root.querySelector(".linkish")!.textContent!, /Advanced •/);
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Register")!.click();
  await tick();
  assert.equal(calls[0][2].ref, "main");
  assert.equal(JSON.stringify(calls[0][2].config.exclude), '["private/*","drafts/*"]');
  dom.window.close();
});

test("pack selection follows target scopes and supports partial imports", async () => {
  const { dom, root, c, skills } = fixture();
  const calls: any[] = [];
  c.api = async (...args: any[]) => {
    calls.push(args);
    return args[0] === "GET"
      ? {
          ok: true,
          data: {
            candidates: [
              { upstreamName: "a", eligible: true, importedScopes: ["org:acme"] },
              { upstreamName: "b", eligible: true, importedScopes: [] },
            ],
          },
        }
      : { ok: true, data: { imported: [] } };
  };
  await skills.browsePack({ id: "pack", url: "example" }, root, c);
  assert.equal(root.querySelector<HTMLInputElement>('[data-name="a"]')!.disabled, true);
  c.selectedScopes.add("personal:alice");
  c.changeScopes();
  assert.equal(root.querySelector<HTMLInputElement>('[data-name="a"]')!.disabled, false);
  const b = root.querySelector<HTMLInputElement>('[data-name="b"]')!;
  b.checked = false;
  b.dispatchEvent(new dom.window.Event("change"));
  [...root.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Import selected")!.click();
  await tick();
  const post = calls.find((args) => args[0] === "POST");
  assert.equal(JSON.stringify(post[2].selected), '["a"]');
  assert.equal(JSON.stringify(post[2].scopeIds), '["org:acme","personal:alice"]');
  dom.window.close();
});

test("cancelled cron destination edits restore the saved destination on reopen", () => {
  const { dom, root, c, ui } = fixture();
  c.cron = "job";
  ui.crons(
    root,
    {
      crons: [
        { id: "job", title: "Daily", ownerScopeId: c.scope, destination: { type: "principal", target: "alice" } },
      ],
    },
    c,
  );
  const click = (text: string) =>
    [...root.querySelectorAll("button")].find((button) => button.textContent?.trim() === text)!.click();
  click("Edit destination");
  assert.equal(root.querySelector("select")!.value, "principal");
  const target = root.querySelector<HTMLInputElement>('input[name="cron-target"]')!;
  target.value = "bob";
  target.dispatchEvent(new dom.window.Event("input"));
  click("Cancel");
  click("Edit destination");
  assert.equal(root.querySelector<HTMLInputElement>('input[name="cron-target"]')!.value, "alice");
  dom.window.close();
});

test("cron destination saves preserve edits made while the request is pending", async () => {
  const { dom, root, c, ui } = fixture();
  c.cron = "job";
  let complete: (value: any) => void = () => {};
  let reloads = 0;
  c.reload = () => {
    reloads++;
  };
  c.api = async (method: string) =>
    method === "PUT"
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : { ok: true, data: { sessions: [] } };
  ui.crons(root, { crons: [{ id: "job", title: "Daily", ownerScopeId: c.scope }] }, c);
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Edit destination")!.click();
  const target = root.querySelector<HTMLInputElement>('input[name="cron-target"]')!;
  target.value = "submitted";
  target.dispatchEvent(new dom.window.Event("input"));
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save destination")!.click();
  target.value = "newer";
  target.dispatchEvent(new dom.window.Event("input"));
  complete({ ok: true });
  await tick();
  assert.equal(root.querySelector<HTMLInputElement>('input[name="cron-target"]')!.value, "newer");
  assert.equal(reloads, 0);
  assert.equal(
    [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save destination")!.disabled,
    false,
  );
  dom.window.close();
});

test("skill removal network failures keep the current view and report an error", async () => {
  const { dom, c, skills } = fixture();
  let reloads = 0;
  let message = "";
  dom.window.confirm = () => true;
  dom.window.alert = (value) => {
    message = String(value);
  };
  c.reload = () => {
    reloads++;
  };
  c.api = async () => {
    throw new Error("offline");
  };
  await skills.removeSkill({ id: "skill", ownerScopeId: c.scope }, c);
  assert.equal(reloads, 0);
  assert.equal(message, "Could not remove skill.");
  dom.window.close();
});

test("pack registration preserves newer edits after its request completes", async () => {
  const { dom, root, c, skills } = fixture();
  let complete: (value: any) => void = () => {};
  let reloads = 0;
  c.reload = () => {
    reloads++;
  };
  c.api = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  skills.packs(root, [], c);
  const input = root.querySelector<HTMLInputElement>("input")!;
  input.value = "https://example.com/submitted";
  input.dispatchEvent(new dom.window.Event("input"));
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Register")!.click();
  input.value = "https://example.com/newer";
  input.dispatchEvent(new dom.window.Event("input"));
  complete({ ok: true });
  await tick();
  assert.equal(root.querySelector<HTMLInputElement>("input")!.value, "https://example.com/newer");
  assert.equal(reloads, 0);
  assert.match(root.querySelector(".status")!.textContent!, /newer changes/);
  dom.window.close();
});
