import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { browserEnv } from "./browser-env.ts";

const persona = (id: string, name: string, role: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  description: `${name} description`,
  instructions: `${name} instructions`,
  createdBy: "u-1",
  createdAt: 1,
  updatedAt: 1,
  role,
  ...extra,
});

const personas = [
  persona("p-ada", "Ada", "owner", { icon: { kind: "emoji", value: "🧮" } }),
  persona("p-bo", "Bo", "write"),
  persona("p-cy", "Cy", "read"),
];

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

const versions = [
  { version: 3, name: "Ada", description: "", instructions: "Count.\nShow work.", editedBy: "bo", editedAt: 3 },
  { version: 2, name: "Ada", description: "", instructions: "Count.", editedBy: "tester", editedAt: 2 },
  { version: 1, name: "Ada", description: "", instructions: "Ada instructions", editedBy: "tester", editedAt: 1 },
];

interface Grant {
  scopeId: string;
  role: string;
  label?: string;
  personasEnabled: boolean;
}

const defaultAccess = (): Grant[] => [
  { scopeId: "personal:tester", role: "owner", personasEnabled: true },
  { scopeId: "channel:C9", role: "read", label: "design", personasEnabled: true },
];

let calls: Call[] = [];
let disabled = false;
let accessError = false;
let access = defaultAccess();
let holdDirectory = false;
let releaseDirectory = () => {};

const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));

const { vite, dom, close } = await browserEnv({
  dom: { url: "http://localhost/personas" },
  fetch: (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path.startsWith("/api/ui-state")) return json({});
    calls.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    if (path === "/api/personas" && method === "GET")
      return disabled
        ? json({ error: "personas_disabled", message: "personas are not enabled for you" }, 404)
        : json({ personas });
    if (path === "/api/personas" && method === "POST")
      return json({ persona: { ...persona("p-fork", String(calls.at(-1)!.body!.name), "owner") } }, 201);
    if (path.startsWith("/api/skills")) return json({ skills: [] });
    if (path === "/api/keychain/overview")
      return json({
        credentials: [
          { id: "cred-gh", service: "github", accountLabel: "octo" },
          { id: "cred-lin", service: "linear" },
        ],
      });
    const versionsPath = /\/versions\?full=1&limit=20(?:&before=(\d+))?$/.exec(path);
    if (versionsPath && method === "GET") {
      const before = Number(versionsPath[1] ?? Infinity);
      const page = versions.filter((v) => v.version < before);
      return json({ versions: page.slice(0, 2), more: page.length > 2 });
    }
    if (path.includes("/versions/") && method === "POST")
      return json({ persona: { ...personas[0], instructions: "Ada instructions", version: 4 } });
    if (path.includes("/credentials")) return json({ credential: { grantId: "g-2" } });
    if (path.startsWith("/api/personas/") && path.endsWith("/access"))
      return accessError
        ? json({ error: "invalid", message: "a persona must keep at least one owner" }, 400)
        : json({ access: [] });
    if (path.startsWith("/api/personas/")) {
      const id = decodeURIComponent(path.split("/")[3]!);
      const found = personas.find((p) => p.id === id) ?? persona(id, "Ada (fork)", "owner");
      return json({
        persona: {
          ...found,
          access,
          version: 3,
          credentials: [{ grantId: "g-1", service: "github", ownerId: "tester" }],
        },
      });
    }
    if (path.startsWith("/api/directory/resolve")) {
      const found = () =>
        json({ matches: [{ principalId: "bo@acme.com", displayName: "Bo Person", type: "internal" }] });
      if (!holdDirectory) return found();
      return new Promise<Response>((resolve) => {
        releaseDirectory = () => void found().then(resolve);
      });
    }
    if (path.startsWith("/api/directory/channels"))
      return json({ channels: [{ scopeId: "channel:C1", channelId: "C1", name: "eng-launch", isPrivate: false }] });
    if (path === "/api/contexts")
      return json({ contexts: [{ scopeId: "personal:tester", kind: "personal", name: null, sessionCount: 0 }] });
    if (path === "/api/sessions" && method === "POST")
      return json(
        { session: { id: "s-new", type: "dm", scopeId: "personal:tester", threadRef: "web:tester:new", createdAt: 1 } },
        201,
      );
    if (path.includes("/persona")) return json({ persona: null });
    if (path.startsWith("/api/sessions/s-new"))
      return json({
        session: { id: "s-new", type: "dm", scopeId: "personal:tester", threadRef: "web:tester:new", createdAt: 1 },
        items: [],
      });
    if (path.startsWith("/api/runtime-config"))
      return json({
        scopeId: new URL(path, "http://localhost").searchParams.get("scopeId") ?? "personal:tester",
        models: [],
        modelCatalog: {},
        orgDefault: { modelId: null, revision: 0 },
        effective: {},
        scopeOverride: null,
      });
    return json({});
  },
});
dom.window.confirm = () => true;
dom.window.HTMLDialogElement.prototype.showModal = function () {
  this.open = true;
};
dom.window.HTMLDialogElement.prototype.close = function () {
  this.open = false;
};
after(close);

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function mountPage() {
  const main = document.querySelector("main")!;
  const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
  const personasModule = await vite.ssrLoadModule("/src/personas.ts");
  appState.currentView = "personas";
  appState.mainEl = main;
  appState.me = { user: "tester", org: "acme", companyName: "Acme" };
  await personasModule.renderPersonasPage();
  return { main, personasModule };
}

function button(root: ParentNode, text: string, within?: string): HTMLButtonElement {
  const scope = within
    ? [...root.querySelectorAll<HTMLElement>(".persona-row")].find((row) => row.textContent?.includes(within))!
    : root;
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
  assert.ok(found, `no "${text}" button${within ? ` on ${within}` : ""}`);
  return found;
}

beforeEach(() => {
  calls = [];
  disabled = false;
  accessError = false;
  access = defaultAccess();
  holdDirectory = false;
  dom.window.confirm = () => true;
  document.body.innerHTML = '<div id="app"></div><main></main>';
});

test("personas are grouped by the person's role, with edit and share only where the role allows", async () => {
  const { main } = await mountPage();
  const groups = [...main.querySelectorAll(".list-group")].map((group) => ({
    label: group.querySelector("h2")?.textContent?.trim(),
    rows: [...group.querySelectorAll(".persona-row")].map((row) => ({
      name: row.querySelector(".list-row-title")?.textContent?.trim(),
      description: row.querySelector(".persona-row-description")?.textContent?.trim(),
      actions: [...row.querySelectorAll(".persona-row-actions button")].map((b) => b.textContent?.trim()),
    })),
  }));
  assert.deepEqual(groups, [
    {
      label: "Owner",
      rows: [{ name: "Ada", description: "Ada description", actions: ["Chat", "Fork", "Edit", "Share"] }],
    },
    { label: "Can edit", rows: [{ name: "Bo", description: "Bo description", actions: ["Chat", "Fork", "Edit"] }] },
    { label: "Can chat", rows: [{ name: "Cy", description: "Cy description", actions: ["Chat", "Fork"] }] },
  ]);
});

test("when personas are off for the person, Browse has no Personas entry and the page offers nothing", async () => {
  disabled = true;
  const { main } = await mountPage();
  const { destinations } = await vite.ssrLoadModule("/src/browse.ts");
  assert.equal(
    destinations().some((d: { label: string }) => d.label === "Personas"),
    false,
  );
  assert.equal(main.querySelector(".list-page-action"), null);
  assert.equal(main.querySelectorAll(".persona-row").length, 0);
  assert.match(main.textContent ?? "", /Personas aren't turned on for you/);

  disabled = false;
  await mountPage();
  assert.equal(
    destinations().some((d: { label: string }) => d.label === "Personas"),
    true,
  );
});

test("Chat starts a conversation and sets its persona before anything is sent", async () => {
  const { main } = await mountPage();
  calls = [];
  button(main, "Chat", "Cy").click();
  await settle();
  const writes = calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path, c.body]);
  assert.deepEqual(writes.slice(0, 2), [
    ["POST", "/api/sessions", { scopeId: "personal:tester" }],
    ["PUT", "/api/sessions/s-new/persona", { personaId: "p-cy" }],
  ]);
  assert.equal(
    calls.some((c) => c.path === "/api/turn"),
    false,
  );
  const { sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
  assert.equal(sessionsState.list.find((s: { id: string }) => s.id === "s-new")?.personaId, "p-cy");
});

test("Fork hands off to QM in a new chat instead of copying on the page", async () => {
  const { main } = await mountPage();
  const { storedDraft, newChatDraftKey } = await vite.ssrLoadModule("/src/drafts.ts");
  calls = [];
  button(main, "Fork", "Ada").click();
  await settle();
  assert.equal(storedDraft(newChatDraftKey("tester")), "Fork the Ada persona for me.");
  assert.equal(
    calls.some((c) => c.method === "POST" && c.path === "/api/personas"),
    false,
  );
});

const sections = (root: ParentNode) =>
  Object.fromEntries(
    [...root.querySelectorAll(".persona-section")].map((section) => [
      section.querySelector("h3")?.textContent?.trim(),
      {
        actions: [...section.querySelectorAll(".persona-section-actions button")].map((b) => b.textContent?.trim()),
        items: [...section.querySelectorAll(".persona-item .persona-skill-name, .permission-person-label")].map((n) =>
          n.textContent?.trim(),
        ),
      },
    ]),
  );

async function openPersonaPage(name: string) {
  const mounted = await mountPage();
  mounted.main.querySelector<HTMLButtonElement>(`button[aria-label="Open ${name}"]`)!.click();
  await settle();
  return mounted;
}

test("a reader sees each part of the persona with nothing to add or remove", async () => {
  const { main } = await openPersonaPage("Cy");
  assert.equal(main.querySelector("form.persona-form"), null);
  assert.match(main.textContent ?? "", /Cy instructions/);
  assert.deepEqual(sections(main), {
    Skills: { actions: [], items: [] },
    Crons: { actions: ["New cron"], items: [] },
    Credentials: { actions: [], items: ["github"] },
    "Channels and groups": { actions: [], items: ["design"] },
    "Who has access": { actions: [], items: ["You"] },
    History: { actions: ["Show 3 versions"], items: [] },
  });
  assert.equal(main.querySelector(".persona-item-remove"), null);
});

function searchFor(root: ParentNode, text: string): HTMLInputElement {
  const input = root.querySelector<HTMLInputElement>("#persona-grantee-search")!;
  input.value = text;
  input.dispatchEvent(new window.Event("input"));
  input.closest("form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
  return input;
}

const resultNames = (root: ParentNode) =>
  [...root.querySelectorAll(".project-member-result .project-member-name")].map((n) => n.textContent?.trim());

const accessPuts = () => calls.filter((c) => c.method === "PUT" && c.path.endsWith("/access"));

const putBody = () => accessPuts()[0]?.body;

const flash = (root: ParentNode) => root.querySelector(".action-notice")?.textContent?.trim();

const accessRow = (root: ParentNode, scope: string) =>
  root.querySelector<HTMLElement>(`.permission-row[data-scope="${scope}"]`)!;

function roleOptions(root: ParentNode, scope: string): HTMLButtonElement[] {
  accessRow(root, scope).querySelector<HTMLButtonElement>(".menu-button")!.click();
  return [...accessRow(root, scope).querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
}

async function pickRole(root: ParentNode, scope: string, label: string): Promise<void> {
  roleOptions(root, scope)
    .find((o) => o.textContent?.trim() === label)!
    .click();
  await settle();
}

test("an owner pins the persona in a channel from its row", async () => {
  const { main } = await openPersonaPage("Ada");
  calls = [];
  button(main, "Pin").click();
  await settle();
  assert.deepEqual(putBody(), {
    access: [
      { scopeId: "personal:tester", role: "owner" },
      { scopeId: "channel:C9", role: "read", pinned: true },
    ],
  });
  assert.equal(flash(main), "Pinned in #design.");
});

test("Add channel searches your Slack channels on the page and adds one with chat access", async () => {
  const { main } = await openPersonaPage("Ada");
  button(main, "Add channel").click();
  await settle();
  const input = searchFor(main, "eng");
  assert.equal(document.activeElement, input);
  assert.equal(input.placeholder, "Search channels you're in");
  await settle();
  assert.deepEqual(resultNames(main), ["eng-launch"]);
  assert.equal(
    calls.some((c) => c.path.startsWith("/api/directory/resolve")),
    false,
  );
  calls = [];
  main.querySelector<HTMLButtonElement>(".project-member-result")!.click();
  await settle();
  assert.deepEqual(putBody(), {
    access: [
      { scopeId: "personal:tester", role: "owner" },
      { scopeId: "channel:C9", role: "read" },
      { scopeId: "channel:C1", role: "read" },
    ],
  });
  assert.equal(flash(main), "Added #eng-launch.");
  assert.equal(document.querySelector("dialog"), null);

  let asked = "";
  dom.window.confirm = (question?: string) => {
    asked = question ?? "";
    return true;
  };
  calls = [];
  main.querySelector<HTMLButtonElement>('button[aria-label="Remove design"]')!.click();
  await settle();
  assert.equal(asked, "Remove design from Ada?");
  assert.deepEqual(putBody(), { access: [{ scopeId: "personal:tester", role: "owner" }] });
});

test("an owner attaches one of their credentials and detaches one", async () => {
  const { main } = await openPersonaPage("Ada");
  button(main, "Attach").click();
  await settle();
  const dialog = document.querySelector<HTMLDialogElement>("dialog.persona-picker-dialog")!;
  const choices = [...dialog.querySelectorAll<HTMLButtonElement>(".project-member-result")];
  assert.deepEqual(
    choices.map((c) => [c.querySelector(".project-member-name")?.textContent?.replace(/\s+/g, " ").trim(), c.disabled]),
    [
      ["github octo", true],
      ["linear", false],
    ],
  );
  calls = [];
  choices[1]!.click();
  await settle();
  assert.deepEqual(
    calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path, c.body]),
    [["POST", "/api/personas/p-ada/credentials", { credentialId: "cred-lin" }]],
  );
  calls = [];
  main.querySelector<HTMLButtonElement>('button[aria-label="Detach github"]')!.click();
  await settle();
  assert.deepEqual(
    calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path]),
    [["DELETE", "/api/personas/p-ada/credentials/g-1"]],
  );
});

test("New cron and Ask QM open a chat wearing the persona with the request started", async () => {
  const { main } = await openPersonaPage("Ada");
  const { storedDraft } = await vite.ssrLoadModule("/src/drafts.ts");
  calls = [];
  button(main, "New cron").click();
  await settle();
  assert.deepEqual(
    calls
      .filter((c) => c.method !== "GET")
      .slice(0, 2)
      .map((c) => [c.method, c.path, c.body]),
    [
      ["POST", "/api/sessions", { scopeId: "personal:tester" }],
      ["PUT", "/api/sessions/s-new/persona", { personaId: "p-ada" }],
    ],
  );
  assert.equal(storedDraft("web:tester:new"), "Set up a cron that ");
});

test("history lists versions on demand, shows what changed, and rolls back as a new version", async () => {
  const { main } = await openPersonaPage("Ada");
  assert.equal(
    calls.some((c) => c.path.endsWith("/versions")),
    false,
  );
  button(main, "Show 3 versions").click();
  await settle();
  button(main, "Show older").click();
  await settle();
  const rows = [...main.querySelectorAll(".persona-version-row")];
  assert.deepEqual(
    rows.map((row) => [
      row.querySelector("strong")?.textContent,
      row.querySelector(".persona-version-open")?.textContent?.includes("created"),
      [...row.querySelectorAll("button.persona-action")].map((b) => b.textContent?.trim()),
    ]),
    [
      ["v3", false, []],
      ["v2", false, ["Roll back"]],
      ["v1", true, ["Roll back"]],
    ],
  );
  assert.equal(
    [...main.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Show older"),
    false,
  );
  assert.deepEqual(
    calls.filter((c) => c.path.includes("/versions")).map((c) => c.path),
    ["/api/personas/p-ada/versions?full=1&limit=20", "/api/personas/p-ada/versions?full=1&limit=20&before=2"],
  );
  rows[0]!.querySelector<HTMLButtonElement>(".persona-version-open")!.click();
  await settle();
  assert.deepEqual(
    [...main.querySelectorAll(".persona-version-field b")].map((label) => label.textContent),
    ["Name", "Icon", "Description", "Instructions"],
  );
  assert.equal(main.querySelector(".persona-version-text")?.textContent, "Count.\nShow work.");
  calls = [];
  button(rows[2]!, "Roll back").click();
  await settle();
  assert.deepEqual(
    calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path]),
    [["POST", "/api/personas/p-ada/versions/1/restore"]],
  );
  assert.match(main.querySelector(".action-notice")?.textContent ?? "", /Rolled back to version 1/);
});

test("an editor saves name, description and instructions with PATCH", async () => {
  const { main } = await mountPage();
  button(main, "Edit", "Bo").click();
  await settle();
  const form = main.querySelector<HTMLFormElement>("form.persona-form")!;
  form.querySelector<HTMLInputElement>('input[name="name"]')!.value = "Bo 2";
  form.querySelector<HTMLTextAreaElement>('textarea[name="instructions"]')!.value = "Be brief.";
  calls = [];
  form.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  const patch = calls.find((c) => c.method === "PATCH");
  assert.deepEqual(patch && [patch.path, patch.body], [
    "/api/personas/p-bo",
    { name: "Bo 2", description: "Bo description", instructions: "Be brief." },
  ]);
});

test("an owner adds people and everyone at the company on the page, and the search stays open for the next one", async () => {
  const { main } = await openPersonaPage("Ada");
  button(main, "Add people").click();
  await settle();
  searchFor(main, "b");
  await settle();
  assert.deepEqual(resultNames(main), ["Bo Person"]);
  calls = [];
  main.querySelector<HTMLButtonElement>(".project-member-result")!.click();
  await settle();
  assert.deepEqual(putBody(), {
    access: [
      { scopeId: "personal:tester", role: "owner" },
      { scopeId: "channel:C9", role: "read" },
      { scopeId: "personal:bo@acme.com", role: "read" },
    ],
  });
  assert.equal(flash(main), "Added Bo Person.");
  const input = main.querySelector<HTMLInputElement>("#persona-grantee-search")!;
  assert.equal(input.value, "");
  assert.equal(document.activeElement, input);

  calls = [];
  button(main, "Add everyone at Acme").click();
  await settle();
  assert.deepEqual(putBody(), {
    access: [
      { scopeId: "personal:tester", role: "owner" },
      { scopeId: "channel:C9", role: "read" },
      { scopeId: "org:acme", role: "read" },
    ],
  });
});

test("an owner changes a person's role and removes them from the row, keeping an unsaved instructions edit", async () => {
  access = [
    { scopeId: "personal:tester", role: "owner", personasEnabled: true },
    { scopeId: "personal:bo@acme.com", role: "read", label: "Bo Person", personasEnabled: true },
  ];
  const { main } = await openPersonaPage("Ada");
  const instructions = main.querySelector<HTMLTextAreaElement>("textarea[name=instructions]")!;
  instructions.value = "A draft I haven't saved";
  calls = [];
  await pickRole(main, "personal:bo@acme.com", "Can edit");
  assert.deepEqual(putBody(), {
    access: [
      { scopeId: "personal:tester", role: "owner" },
      { scopeId: "personal:bo@acme.com", role: "write" },
    ],
  });
  assert.equal(flash(main), "Access saved.");
  assert.equal(
    main.querySelector<HTMLTextAreaElement>("textarea[name=instructions]")!.value,
    "A draft I haven't saved",
  );

  let asked = "";
  dom.window.confirm = (question?: string) => {
    asked = question ?? "";
    return true;
  };
  calls = [];
  await pickRole(main, "personal:bo@acme.com", "Remove access");
  assert.equal(asked, "Remove Bo Person from Ada?");
  assert.deepEqual(putBody(), { access: [{ scopeId: "personal:tester", role: "owner" }] });
  assert.equal(flash(main), "Removed Bo Person.");

  accessError = true;
  calls = [];
  await pickRole(main, "personal:bo@acme.com", "Can edit");
  assert.ok(putBody());
  assert.equal(flash(main), "Removed Bo Person.");
  assert.equal(accessRow(main, "personal:bo@acme.com").querySelector("fieldset")!.disabled, false);
  assert.equal(
    main.querySelector(".persona-action-error[role=alert]")?.textContent?.trim(),
    "a persona must keep at least one owner",
  );
});

test("a search answered after the query changed shows nothing for the old query", async () => {
  const { main } = await openPersonaPage("Ada");
  button(main, "Add people").click();
  await settle();
  holdDirectory = true;
  const input = searchFor(main, "b");
  await settle();
  input.value = "zz";
  input.dispatchEvent(new window.Event("input"));
  holdDirectory = false;
  releaseDirectory();
  await settle();
  assert.deepEqual(resultNames(main), []);
});

test("opening Add people keeps an unsaved icon change, and Save sends it", async () => {
  const { main } = await openPersonaPage("Ada");
  main.querySelector<HTMLButtonElement>('button[aria-label="Choose an icon"]')!.click();
  await settle();
  document.querySelector<HTMLButtonElement>(".project-icon-picker-remove")!.click();
  await settle();
  button(main, "Add people").click();
  await settle();
  calls = [];
  main
    .querySelector<HTMLFormElement>("form.persona-form")!
    .dispatchEvent(new window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(calls.find((c) => c.method === "PATCH")?.body?.icon, null);
});

test("the only owner's row says why it can't be demoted or removed, and nothing is sent", async () => {
  const { main } = await openPersonaPage("Ada");
  assert.match(
    accessRow(main, "personal:tester").textContent ?? "",
    /The only owner\. Make someone else an owner before changing this\./,
  );
  assert.deepEqual(
    roleOptions(main, "personal:tester").map((o) => [
      o.textContent?.trim(),
      o.getAttribute("aria-disabled") === "true",
    ]),
    [
      ["Owner", false],
      ["Can edit", true],
      ["Can chat", true],
      ["Remove access", true],
    ],
  );
  calls = [];
  await pickRole(main, "personal:tester", "Can chat");
  await pickRole(main, "personal:tester", "Remove access");
  assert.deepEqual(accessPuts(), []);

  access = [
    { scopeId: "personal:tester", role: "owner", personasEnabled: true },
    { scopeId: "personal:bo@acme.com", role: "owner", label: "Bo Person", personasEnabled: true },
  ];
  const again = await openPersonaPage("Ada");
  assert.doesNotMatch(again.main.querySelector(".persona-access-list")?.textContent ?? "", /The only owner/);
  assert.equal(
    roleOptions(again.main, "personal:tester").some((o) => o.getAttribute("aria-disabled") === "true"),
    false,
  );
});

test("a reader sees their role, the owners to ask, and no controls", async () => {
  access = [
    { scopeId: "personal:u-alice", role: "owner", label: "Alice Smith", personasEnabled: true },
    { scopeId: "personal:u-bob", role: "owner", label: "Bob Jones", personasEnabled: true },
    { scopeId: "personal:tester", role: "read", personasEnabled: true },
  ];
  const { main } = await openPersonaPage("Cy");
  assert.match(main.querySelector(".persona-role")?.textContent ?? "", /Your role: Can chat/);
  const section = main.querySelector(".persona-access-list")!.closest(".persona-section")!;
  assert.deepEqual(
    [...section.querySelectorAll(".permission-row")].map((row) => [
      row.querySelector(".permission-person-label")?.textContent?.trim(),
      row.querySelector(".permission-owner")?.textContent?.trim(),
    ]),
    [
      ["Alice Smith", "Owner"],
      ["Bob Jones", "Owner"],
      ["You", "Can chat"],
    ],
  );
  assert.match(section.textContent ?? "", /Only owners can change who has access: ask Alice Smith or Bob Jones\./);
  assert.equal(section.querySelector(".permission-control"), null);
  assert.equal(section.querySelector("#persona-grantee-search"), null);
});

test("people and groups the Personas flag doesn't reach are marked with where an admin turns it on", async () => {
  access = [
    { scopeId: "personal:tester", role: "owner", personasEnabled: true },
    { scopeId: "personal:bo@acme.com", role: "read", label: "Bo Person", personasEnabled: false },
    { scopeId: "org:acme", role: "read", personasEnabled: false },
    { scopeId: "channel:C9", role: "read", label: "design", personasEnabled: false },
  ];
  const { main } = await openPersonaPage("Ada");
  const notes = (scope: string) =>
    [...accessRow(main, scope).querySelectorAll(".permission-person-label small")].map((n) => n.textContent?.trim());
  const orgNote =
    "Personas is off for the organization, so only people with the flag on can use this. An admin can turn it on for everyone in Admin → Customize → Feature flags.";
  assert.deepEqual(notes("personal:tester"), ["The only owner. Make someone else an owner before changing this."]);
  assert.deepEqual(notes("personal:bo@acme.com"), [
    "Can't use personas until an admin turns on the Personas feature flag for them in Admin → Customize → Feature flags.",
  ]);
  assert.match(
    accessRow(main, "org:acme").querySelector(".permission-person-label")?.textContent?.trim() ?? "",
    /^Everyone at Acme/,
  );
  assert.deepEqual(notes("org:acme"), [orgNote]);
  const channels = [...main.querySelectorAll(".persona-section")].find(
    (section) => section.querySelector("h3")?.textContent?.trim() === "Channels and groups",
  )!;
  assert.equal(channels.querySelector(".persona-item .hint"), null);
  assert.equal(channels.querySelector(".permission-note")?.textContent?.trim(), orgNote);
});

test("Share on a list row and on the page open the same search on the page, with no dialog", async () => {
  const { main } = await mountPage();
  button(main, "Share", "Ada").click();
  await settle();
  assert.equal(document.querySelector("dialog"), null);
  const input = main.querySelector<HTMLInputElement>("#persona-grantee-search")!;
  assert.equal(document.activeElement, input);
  assert.equal(input.closest(".persona-section")?.querySelector("h3")?.textContent, "Who has access");

  main.querySelector<HTMLButtonElement>('.persona-grantee-picker button[aria-label="Close"]')!.click();
  assert.equal(main.querySelector("#persona-grantee-search"), null);
  button(main.querySelector(".persona-detail-actions")!, "Share").click();
  await settle();
  assert.equal(document.activeElement, main.querySelector("#persona-grantee-search"));
});

test("the conversation shows its persona, and clearing it unsets the session's persona", async () => {
  const { personasModule } = await mountPage();
  const { sessionsState } = await vite.ssrLoadModule("/src/sessions.ts");
  const { render } = await vite.ssrLoadModule("lit");
  sessionsState.list = [
    { id: "s-1", type: "dm", scopeId: "personal:tester", threadRef: "web:tester:1", createdAt: 1, personaId: "p-ada" },
  ];
  const host = document.createElement("div");
  let redraws = 0;
  const draw = () =>
    render(
      personasModule.sessionPersonaChip(sessionsState.list[0], () => (redraws++, draw())),
      host,
    );
  draw();
  assert.equal(host.textContent?.trim(), "🧮Ada");
  calls = [];
  host.querySelector<HTMLButtonElement>('button[aria-label="Stop using Ada"]')!.click();
  await settle();
  assert.deepEqual(
    calls.map((c) => [c.method, c.path, c.body]),
    [["PUT", "/api/sessions/s-1/persona", { personaId: null }]],
  );
  assert.equal(sessionsState.list[0].personaId, undefined);
  assert.equal(redraws, 1);
  assert.equal(host.querySelector(".session-persona-badge"), null);
});

test("a persona has its own link, so /personas/<id> opens it and its page keeps the address", async () => {
  const main = document.querySelector("main")!;
  const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
  const personasModule = await vite.ssrLoadModule("/src/personas.ts");
  appState.currentView = "personas";
  appState.mainEl = main;
  appState.me = { user: "tester", org: "acme", companyName: "Acme" };
  personasModule.openPersonaById("p-bo");
  await personasModule.renderPersonasPage();
  await settle();
  assert.equal(main.querySelector(".persona-heading")?.textContent?.trim(), "Bo");
  assert.equal(window.location.pathname, "/personas/p-bo");
  button(main, "Personas").click();
  await settle();
  assert.equal(window.location.pathname, "/personas");
});

test("New skill opens the skill editor already set to the persona", async () => {
  const { main } = await openPersonaPage("Ada");
  button(main, "New skill").click();
  await settle();
  await settle();
  const select = document.querySelector<HTMLSelectElement>(".skill-scope-select select")!;
  assert.ok(select, "the skill editor opened");
  assert.equal(select.selectedOptions[0]?.textContent, "Ada");
  assert.equal(select.value, "persona:p-ada");
});
