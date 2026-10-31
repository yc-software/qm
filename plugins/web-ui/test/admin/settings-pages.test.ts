import assert from "node:assert/strict";
import test from "node:test";
import { mountPage, type Route } from "./fixture.ts";

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const withResolvers = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
type Page = Awaited<ReturnType<typeof mountPage>>;
const visit = async (admin: Page, url: string) => {
  admin.window.history.pushState(null, "", url);
  await admin.mount();
  await admin.settle();
};
const type = (admin: Page, selector: string, value: string, event = "input") => {
  const input = admin.document.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new admin.window.Event(event, { bubbles: true }));
};
const click = (admin: Page, selector: string) => admin.document.querySelector<HTMLButtonElement>(selector)!.click();

test("a refreshed model catalog only reaches the view that asked for it", async () => {
  for (const stale of [false, true]) {
    const refresh = withResolvers<unknown>();
    let reads = 0;
    const admin = await mountPage("/settings/models", {
      "/scopes/org:acme": ({ url }) =>
        url.searchParams.get("catalog") === "refresh"
          ? refresh.promise
          : {
              modelCatalogRefreshing: reads++ === 0,
              baseModelOptions: [{ id: "configured", name: "Configured" }],
              webuiModels: [],
            },
      "/custom-providers": { providers: [] },
    });
    await admin.settle();
    if (stale) await visit(admin, "/settings/models?again=1");
    refresh.resolve({
      baseModelOptions: [{ id: "new", name: "New model" }],
    });
    await admin.settle();
    const offered = [...admin.document.querySelectorAll<HTMLOptionElement>("#webui-models-options option")].map(
      (option) => option.value,
    );
    assert.equal(offered.includes("new"), !stale, stale ? "stale" : "current");
    assert.ok(offered.includes("configured"));
    admin.close();
  }
});

test("enabled models and custom providers save their payloads", async () => {
  const saves: [string, string, unknown][] = [];
  const record: Route = ({ method, path, body }) => {
    saves.push([method, decodeURIComponent(path), body]);
    return { ok: true };
  };
  const admin = await mountPage("/settings/models", {
    "/scopes/org:acme": { baseModelOptions: [{ id: "a", name: "Alpha" }, { id: "b" }], webuiModels: ["a"] },
    "/custom-providers": { providers: [] },
    "PUT /scopes/org:acme/webui-models": record,
    "PUT /custom-providers/gw": record,
  });
  await admin.settle();
  type(admin, "#webui-models-add", "b");
  click(admin, "#webui-models-add-button");
  click(admin, '[data-save="webui-models"]');
  await admin.settle();
  click(admin, "#add-custom-provider");
  assert.equal(admin.document.querySelector<HTMLDialogElement>("#custom-provider-dialog")!.open, true);
  type(admin, "#custom-provider-id", "gw");
  type(admin, "#custom-provider-name", "Gateway");
  type(admin, "#custom-provider-url", "https://gw.example/v1");
  type(admin, "#custom-provider-models", "m1 | Model one | 1000");
  click(admin, "#custom-provider-save");
  await admin.settle();
  assert.deepEqual(plain(saves), [
    ["PUT", "/scopes/org:acme/webui-models", { ids: ["a", "b"] }],
    [
      "PUT",
      "/custom-providers/gw",
      {
        name: "Gateway",
        protocol: "openai",
        baseUrl: "https://gw.example/v1",
        models: [{ id: "m1", name: "Model one", contextWindow: 1000 }],
      },
    ],
  ]);
  assert.equal(admin.document.querySelector<HTMLDialogElement>("#custom-provider-dialog")!.open, false);
  assert.ok(admin.requests.filter((r) => r.path === "/custom-providers").length >= 2);
  admin.close();
});

test("saving branding merges the saved theme and reloads only when no other draft is open", async () => {
  for (const otherDraft of [false, true]) {
    const saves: any[] = [];
    const admin = await mountPage("/settings/customize", {
      "/scopes/org:acme": {
        branding: { selfLabel: "Saved name", accent: "#111111", iconUrl: "https://example.com/icon.png" },
        soul: "Original SOUL",
      },
      "PUT /scopes/org:acme/branding": ({ body }) => {
        saves.push(body);
        return { ok: true };
      },
    });
    await admin.settle();
    type(admin, "#branding-accent", "#123456");
    if (otherDraft) type(admin, "#card-soul textarea", "Unsaved SOUL");
    click(admin, '[data-save="branding"]');
    await admin.settle();
    assert.equal(saves.length, 1);
    assert.equal(saves[0].selfLabel, "Saved name");
    assert.equal(saves[0].accent, "#123456");
    assert.equal(saves[0].iconUrl, "https://example.com/icon.png");
    assert.equal(admin.document.querySelector<HTMLButtonElement>('[data-save="branding"]')!.disabled, true);
    assert.equal(
      admin.document.querySelector<HTMLTextAreaElement>("#card-soul textarea")!.value,
      otherDraft ? "Unsaved SOUL" : "Original SOUL",
    );
    assert.equal(
      admin.jsdomErrors.some((message) => /navigation/i.test(message)),
      !otherDraft,
      otherDraft ? "kept the SOUL draft" : "reloaded",
    );
    admin.close();
  }
});

test("a SOUL conflict loads the latest revision and keeps the draft", async () => {
  let version = 3;
  const admin = await mountPage("/settings/customize", {
    "/scopes/org:acme": () => ({ soul: "Server v" + version, soulVersion: version }),
    "PUT /scopes/org:acme/soul": ({ body }) => {
      assert.equal(body.expectedVersion, 3);
      version = 4;
      return { status: 409, body: { message: "conflict" } };
    },
  });
  await admin.settle();
  click(admin, "#soul-edit");
  type(admin, "#soul", "My draft");
  click(admin, '[data-save="soul"]');
  await admin.settle();
  assert.equal(admin.document.querySelector<HTMLTextAreaElement>("#soul")!.value, "My draft");
  assert.equal(admin.document.getElementById("soul-ver")!.textContent, "Saved version 4");
  assert.equal(
    admin.document.getElementById("st-soul")!.textContent,
    "SOUL changed; latest revision loaded and your draft was preserved.",
  );
  admin.close();
});

test("feature flags enable the scopes picked in a native multi-select", async () => {
  const saves: unknown[] = [];
  const admin = await mountPage("/settings/customize", {
    "/scopes/org:acme": {
      featureFlags: [
        { featureName: "alpha", label: "Alpha", enabledScopes: [] },
        { featureName: "solo", label: "Solo", personalOnly: true, enabledScopes: [] },
      ],
    },
    "/scopes": {
      scopes: [
        { scopeId: "personal:ann", label: "Ann" },
        { scopeId: "channel:c1", label: "#c1" },
      ],
    },
    "PUT /scopes/org:acme/feature-flags": ({ body }) => (saves.push(body), { ok: true }),
  });
  await admin.settle();
  const picker = admin.document.querySelector<HTMLSelectElement>("#feature-flag-scopes")!;
  type(admin, "#feature-flag-name", "solo", "change");
  assert.deepEqual(
    [...picker.options].map((o) => o.value),
    ["personal:ann"],
  );
  type(admin, "#feature-flag-name", "alpha", "change");
  for (const option of picker.options) option.selected = true;
  picker.dispatchEvent(new admin.window.Event("change"));
  click(admin, "#feature-flag-enable");
  await admin.settle();
  assert.deepEqual(plain(saves), [
    { featureName: "alpha", scopeId: "personal:ann", on: true },
    { featureName: "alpha", scopeId: "channel:c1", on: true },
  ]);
  assert.match(admin.document.getElementById("feature-flag-list")!.textContent!, /alpha: channel:c1/);
  admin.close();
});

test("credentials show loading, then a visible retry when the read fails", async () => {
  const read = withResolvers<unknown>();
  const admin = await mountPage("/settings/credentials", {
    "/scopes/org:acme": () => read.promise,
    "/keychain": { users: 2, standing: 1 },
  });
  await admin.settle();
  assert.equal(admin.document.getElementById("sc-list")!.textContent!.trim(), "Loading credentials…");
  assert.equal(admin.document.querySelector<HTMLButtonElement>("#sc-add")!.disabled, true);
  assert.equal(admin.document.getElementById("keychain-user-count")!.textContent, "2");
  read.resolve({ status: 500, body: { message: "boom" } });
  await admin.settle();
  assert.match(admin.document.getElementById("sc-list")!.textContent!, /Could not load credentials\./);
  const reads = admin.requests.filter((r) => r.path === "/scopes/org%3Aacme").length;
  click(admin, "#sc-list button");
  await admin.settle();
  assert.equal(admin.requests.filter((r) => r.path === "/scopes/org%3Aacme").length, reads + 1);
  admin.close();
});

test("credential usage fills in when it arrives, survives failure, and ignores replies for a view left behind", async () => {
  for (const outcome of ["current", "failed", "view"] as const) {
    const usage = withResolvers<unknown>();
    const admin = await mountPage("/settings/credentials", {
      "/scopes/org:acme": {
        serviceCredentials: [{ slug: "example", name: "Example", host: "example.com", grantees: ["org:acme"] }],
      },
      "/scopes/org:acme/credential-usage": () => usage.promise,
      "/keychain": {},
      "/custom-providers": { providers: [] },
    });
    await admin.settle();
    const list = () => admin.document.getElementById("sc-list")?.textContent ?? "";
    assert.match(list(), /Loading usage…/);
    if (outcome === "view") await visit(admin, "/settings/models");
    usage.resolve(
      outcome === "failed" ? { status: 500, body: {} } : { summaries: [{ slug: "example", usageCount: 7 }] },
    );
    await admin.settle();
    if (outcome === "current") assert.match(list(), /7 successful uses/);
    if (outcome === "failed") assert.match(list(), /Usage unavailable/);
    if (outcome === "view") assert.equal(list(), "");
    admin.close();
  }
});

test("credentials save from the dialog and delete after review", async () => {
  const saves: unknown[] = [];
  let rows: unknown[] = [];
  const admin = await mountPage("/settings/credentials", {
    "/scopes/org:acme": () => ({
      serviceCredentials: rows,
      directoryMembers: [{ principalId: "ann", displayName: "Ann" }],
    }),
    "/scopes/org:acme/credential-usage": { summaries: [] },
    "/keychain": {},
    "PUT /scopes/org:acme/service-credentials": ({ body }) => {
      saves.push(body);
      rows = body.delete ? [] : [{ ...body, hasSecret: true, updatedAt: 5 }];
      return { ok: true };
    },
  });
  await admin.settle();
  click(admin, "#sc-add");
  const dialog = admin.document.querySelector<HTMLDialogElement>("#sc-dialog")!;
  assert.equal(dialog.open, true);
  type(admin, "#sc-slug", "svc");
  type(admin, "#sc-name", "Service");
  type(admin, "#sc-host", "api.example.com");
  type(admin, "#sc-secret", "s3cret");
  click(admin, "#sc-save");
  await admin.settle();
  assert.equal(dialog.open, false);
  assert.match(admin.document.getElementById("sc-list")!.textContent!, /Service/);
  click(admin, '#sc-list [aria-label="Delete Service"]');
  await admin.settle();
  assert.match(admin.document.getElementById("governance-review-title")!.textContent!, /Delete “Service”/);
  click(admin, "#governance-review-confirm");
  await admin.settle();
  assert.deepEqual(plain(saves), [
    {
      slug: "svc",
      name: "Service",
      delivery: "broker",
      host: "api.example.com",
      secret: "s3cret",
      injection: {},
      allowedMethods: [],
      allowedPathPrefixes: [],
      enabled: true,
      deployments: true,
      grantees: ["org:acme"],
    },
    { slug: "svc", delete: true, expectedUpdatedAt: 5 },
  ]);
  assert.match(admin.document.getElementById("sc-list")!.textContent!, /No credentials configured/);
  admin.close();
});

const meta = (id: string) => ({
  id,
  name: id,
  label: id,
  buttonLabel: id,
  provider: "openai",
  api: "openai-responses",
});

test("the models view saves runtime rows chosen in the composer picker", async () => {
  const saves: [string, unknown][] = [];
  const save: Route = ({ path, body }) => {
    saves.push([decodeURIComponent(path), body]);
    return { ok: true };
  };
  const admin = await mountPage("/settings/models", {
    "/scopes/org:acme": {
      baseModelDefault: "model",
      baseModelOptions: [{ id: "model" }, { id: "fast" }],
      modelCatalog: { model: meta("model"), fast: meta("fast") },
      fastModeModelIds: ["fast"],
      runtime: { modelId: "fast", effortLevel: "auto", fastMode: false },
      cronRuntime: null,
      subagentRuntime: null,
      fallbackRuntime: null,
      memoryEmbeddingModel: null,
      memoryEmbeddingOptions: [{ id: "gateway/embed", name: "embed", provider: "qm:gateway" }],
    },
    "PUT /scopes/org:acme/runtime": save,
    "PUT /scopes/org:acme/cron-runtime": save,
    "PUT /scopes/org:acme/memory-embedding-model": save,
  });
  await admin.settle();
  const doc = admin.document;
  const row = (key: string) => doc.querySelector(`[data-runtime-row="${key}"]`)!;
  const open = (key: string) => row(key).querySelector<HTMLButtonElement>(".loadout-button")!.click();
  const recall = row("memory-embedding-model").querySelector("select")!;
  const pickRecall = (modelId: string) => {
    recall.value = modelId;
    recall.dispatchEvent(new admin.window.Event("change"));
  };
  const saveAll = async () => {
    doc.getElementById("runtimes-save")!.click();
    await admin.settle(10);
  };

  assert.equal(row("cron-runtime").querySelector(".menu-label")!.textContent, "Job's scope default");
  open("cron-runtime");
  assert.deepEqual(
    [...row("cron-runtime").querySelectorAll(".loadout-pick .loadout-name")].map((name) => name.textContent),
    ["model", "fast"],
  );
  for (const preset of ['[data-loadout-section="add"]', ".loadout-head", ".loadout-remove"])
    assert.equal(row("cron-runtime").querySelector(preset), null);
  row("cron-runtime").querySelector<HTMLButtonElement>(".loadout-pick")!.click();

  open("runtime");
  row("runtime").querySelector<HTMLButtonElement>('button[aria-label="Fast"]')!.click();
  row("runtime").querySelector<HTMLButtonElement>('[data-loadout-section="effort"]')!.click();
  [...row("runtime").querySelectorAll<HTMLButtonElement>(".loadout-effort")]
    .find((button) => button.textContent!.trim() === "High")!
    .click();
  assert.deepEqual(
    [...recall.options].map((option) => option.value),
    ["", "gateway/embed"],
  );
  pickRecall("gateway/embed");

  await saveAll();
  assert.deepEqual(plain(saves), [
    ["/scopes/org:acme/runtime", { modelId: "fast", effortLevel: "high", fastMode: true }],
    ["/scopes/org:acme/cron-runtime", { modelId: "model", effortLevel: "auto", fastMode: false }],
    ["/scopes/org:acme/memory-embedding-model", { modelId: "gateway/embed" }],
  ]);
  assert.equal(doc.querySelector(".dirty"), null);
  assert.equal(admin.window.localStorage.length, 0);

  open("cron-runtime");
  row("cron-runtime").querySelector<HTMLButtonElement>(".loadout-foot-btn")!.click();
  pickRecall("");
  await saveAll();
  assert.deepEqual(plain(saves.slice(3)), [
    ["/scopes/org:acme/cron-runtime", { inherit: true }],
    ["/scopes/org:acme/memory-embedding-model", { modelId: null }],
  ]);
  assert.equal(row("cron-runtime").querySelector(".menu-label")!.textContent, "Job's scope default");
  admin.close();
});
