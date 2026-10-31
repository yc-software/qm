import assert from "node:assert/strict";
import test from "node:test";
import { mountPage } from "./fixture.ts";

const scopes = { "/scopes": { scopes: [{ scopeId: "personal:alice", label: "Alice" }] } };
const button = (root: Element, text: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text)!;
const type = (f: { window: any }, el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new f.window.Event(el.tagName === "SELECT" ? "change" : "input"));
};

test("memory index links notebooks and the editor adds and edits facts", async () => {
  const facts = [{ id: "f1", text: "old" }];
  const f = await mountPage("/settings/memory", {
    ...scopes,
    "/memory/scopes": { scopes: [{ scopeId: "personal:alice", hasMemory: true, bytes: 10, label: "Alice" }] },
    "GET /memory": { facts },
    "POST /memory": ({ body }) => ({ facts: [...facts, { id: "f2", text: body.facts[0] }] }),
    "PATCH /memory": ({ body }) => ({ facts: body.facts }),
  });
  await f.settle();
  assert.equal(
    f.host.querySelector<HTMLAnchorElement>(".dense-row")!.getAttribute("href"),
    "/settings/memory?scope=personal%3Aalice",
  );
  f.host.querySelector<HTMLAnchorElement>(".dense-row")!.click();
  await f.settle();
  type(f, f.host.querySelector("textarea[aria-label='New fact']")!, "new");
  button(f.host, "Add").click();
  await f.settle();
  assert.deepEqual(f.requests.at(-1)!.body, { facts: ["new"] });
  button(f.host, "Edit").click();
  type(f, f.host.querySelector("textarea[aria-label='Fact text']")!, "edited");
  button(f.host, "Save").click();
  await f.settle();
  assert.deepEqual(f.requests.at(-1)!.body, { facts: [{ id: "f1", text: "edited" }] });
  assert.equal(f.requests.at(-1)!.url.search, "?scope=personal%3Aalice");
  assert.equal(f.host.querySelector(".memory-facts span")!.textContent, "edited");
  f.close();
});

test("files filter by search and upload with the hash and name in the query", async () => {
  const f = await mountPage("/settings/files?scope=personal:alice", {
    ...scopes,
    "GET /files": {
      files: [
        { id: "1", name: "notes.md" },
        { id: "2", name: "photo.png" },
      ],
    },
    "POST /files/upload": {},
  });
  await f.settle();
  Object.defineProperty(f.window, "crypto", { value: globalThis.crypto });
  type(f, f.host.querySelector<HTMLInputElement>(".list-search input")!, "photo");
  assert.deepEqual(
    [...f.host.querySelectorAll(".dense-name")].map((e) => e.textContent),
    ["photo.png"],
  );
  const input = f.host.querySelector<HTMLInputElement>("input[type=file]")!;
  Object.defineProperty(input, "files", { value: [new f.window.File(["hi"], "a.txt", { type: "text/plain" })] });
  input.dispatchEvent(new f.window.Event("change"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const upload = f.requests.find((r) => r.method === "POST")!;
  assert.equal(upload.url.searchParams.get("scope"), "personal:alice");
  assert.equal(upload.url.searchParams.get("name"), "a.txt");
  assert.match(upload.url.searchParams.get("sha")!, /^[0-9a-f]{64}$/);
  f.close();
});

test("cron list opens a detail page whose destination edit sends the API payload", async () => {
  const cron = { id: "job", title: "Daily", ownerScopeId: "personal:alice", schedule: { cron: "0 9 * * *" } };
  const f = await mountPage("/settings/crons", {
    ...scopes,
    "/crons": { crons: [cron] },
    "/sessions": { sessions: [{ id: "s1", createdAt: 1, turns: 2, delivered: 0 }], total: 1 },
    "PUT /crons/job/destination": {},
  });
  await f.settle();
  f.host.querySelector<HTMLAnchorElement>(".dense-row")!.click();
  await f.settle();
  assert.equal(f.location(), "/settings/crons?scope=org%3Aacme&cron=job");
  assert.equal(f.host.querySelector(".pane-title")!.textContent, "Daily");
  assert.equal(
    f.host.querySelector(".dense-row.dim")!.getAttribute("href"),
    "/settings/history?scope=org%3Aacme&session=s1",
  );
  button(f.host, "Edit destination").click();
  type(f, f.host.querySelector(".card select")!, "principal");
  const inputs = f.host.querySelectorAll<HTMLInputElement>(".card input");
  assert.equal(inputs[0]!.placeholder, "principal id");
  type(f, inputs[0]!, "alice");
  type(f, inputs[2]!, "bob");
  button(f.host, "Save destination").click();
  await f.settle();
  const put = f.requests.find((r) => r.method === "PUT")!;
  assert.deepEqual(put.body, { destination: { type: "principal", target: "alice", onBehalfOf: "bob" } });
  assert.equal(button(f.host, "Save destination"), undefined);
  f.close();
});

test("apps open their public URL in a new tab", async () => {
  const f = await mountPage("/settings/deployments", {
    ...scopes,
    "/deployments": { deployments: [{ id: "d", name: "demo", publicUrl: "https://demo.example" }] },
  });
  await f.settle();
  const link = f.host.querySelector<HTMLAnchorElement>(".dense-row")!;
  assert.equal(link.href, "https://demo.example/");
  assert.equal(link.target, "_blank");
  f.close();
});

test("skills remove, show detail, register packs and import selected pack skills into scopes", async () => {
  const skill = { id: "k1", name: "deploy", ownerScopeId: "org:acme", status: "active" };
  const f = await mountPage("/settings/skills", {
    ...scopes,
    "GET /skills": { skills: [skill] },
    "GET /skills/k1": { body: { ...skill, version: 2, body: "Do it", requiredCapabilities: ["net"] } },
    "DELETE /skills/k1": {},
    "GET /skill-packs": { packs: [{ id: "p", url: "https://github.com/o/r.git", trustTier: "internal" }] },
    "POST /skill-packs": {},
    "GET /skill-packs/p/catalog": {
      candidates: [
        { upstreamName: "a", eligible: true, importedScopes: ["org:acme"] },
        { upstreamName: "b", eligible: true, importedScopes: [] },
      ],
    },
    "POST /skill-packs/p/import": { imported: ["a"] },
  });
  await f.settle();
  f.host.querySelector<HTMLElement>("tr.openable")!.click();
  await f.settle();
  assert.ok(f.host.querySelector(".skillbody")!.textContent!.includes("Do it"));
  button(f.host.querySelector("tr.openable")!, "Remove").click();
  await f.settle();
  assert.equal(f.requests.find((r) => r.method === "DELETE")!.url.search, "?scope=org%3Aacme");
  const fields = f.host.querySelectorAll<HTMLInputElement>(".pack-register input, .pack-adv input");
  type(f, fields[0]!, "https://example.com/skills");
  type(f, fields[1]!, "main");
  type(f, fields[2]!, "private/*, drafts/*");
  button(f.host, "Register").click();
  await f.settle();
  assert.deepEqual(f.requests.find((r) => r.method === "POST")!.body, {
    url: "https://example.com/skills",
    ref: "main",
    config: { exclude: ["private/*", "drafts/*"] },
  });
  button(f.host, "Browse skills…").click();
  await f.settle();
  assert.equal(f.host.querySelector<HTMLInputElement>('[data-name="a"]')!.disabled, true);
  const select = f.host.querySelector<HTMLSelectElement>("select[multiple]")!;
  for (const option of select.options) option.selected = true;
  select.dispatchEvent(new f.window.Event("change"));
  assert.equal(f.host.querySelector<HTMLInputElement>('[data-name="a"]')!.disabled, false);
  const b = f.host.querySelector<HTMLInputElement>('[data-name="b"]')!;
  b.checked = false;
  b.dispatchEvent(new f.window.Event("change"));
  button(f.host, "Import selected").click();
  await f.settle();
  const post = f.requests.find((r) => r.path === "/skill-packs/p/import")!;
  assert.deepEqual(post.body, { selected: ["a"], scopeIds: ["org:acme", "personal:alice"] });
  f.close();
});
