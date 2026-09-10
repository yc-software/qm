import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const source = readFileSync(new URL("../../admin/public/index.html", import.meta.url), "utf8");
const card = source.match(/<section class="card sv-governance hidden" id="card-ambient-policy">[^]*?<\/section>/)![0];
const functions = source.slice(
  source.indexOf("      const BOT_MODES ="),
  source.indexOf('      $("add-rule").onclick'),
);
const loadHandler = source.slice(
  source.indexOf("      let governanceReq ="),
  source.indexOf("      async function refreshSoulConflict"),
);
const saveHandler = source.slice(
  source.indexOf("      let governanceSaveSeq ="),
  source.indexOf('      $("view-governance").addEventListener("input"'),
);
const policy = (supportsAmbient: boolean) => ({
  orders: "keep",
  bots: { CI: { mode: "action" } },
  ambientEnabled: true,
  updatedAt: 42,
  supportsAmbient,
});

function fixture() {
  const dom = new JSDOM(card, { runScripts: "outside-only" });
  dom.window.eval(`
    const $ = (id) => document.getElementById(id);
    let scope = "group:web-project-317";
    let loadedGovernanceScope = scope;
    const SAVE_ST = { "ambient-policy": "st-ambient-policy" };
    const governanceSaveReview = async () => true;
    const renderGovernanceOverview = () => {};
    const captureSection = () => {};
    const updateSectionDirty = () => {};
    const setStatus = (id, text) => $(id).textContent = text;
    ${functions}
    const SAVE = { "ambient-policy": collectAmbientPolicy };
    const api = (...args) => window.request(...args);
    ${loadHandler}
    ${saveHandler}
    window.load = (nextScope) => { scope = nextScope; return loadScope(); };
    window.show = (p, nextScope = scope) => { scope = nextScope; governanceReq++; renderAmbientPolicy(p); };
  `);
  const w = dom.window as any;
  const doc = dom.window.document;
  const save = doc.querySelector<HTMLButtonElement>('[data-save="ambient-policy"]')!;
  const hidden = (el: Element) => !!el.closest(".hidden, [hidden]");
  doc.getElementById("card-ambient-policy")!.classList.remove("hidden");
  return { dom, w, doc, save, hidden };
}

test("admin policy DOM retains orders and sends only supported fields", async () => {
  const { dom, w, doc, save, hidden } = fixture();
  try {
    for (const [scope, supportsAmbient] of [
      ["group:web-project-317", false],
      ["group:G317", true],
      ["channel:C317", true],
      ["group:web-project-317", false],
    ] as const) {
      w.show(policy(supportsAmbient), scope);
      assert.equal(hidden(doc.getElementById("ambient-enabled")!), !supportsAmbient);
      assert.equal(hidden(doc.getElementById("add-bot")!), !supportsAmbient);
      assert.equal(hidden(doc.querySelector('[data-viewlink="judgments"]')!), !supportsAmbient);
      const orders = doc.getElementById("ambient-orders") as HTMLTextAreaElement;
      assert.equal(hidden(orders), false);
      assert.equal(orders.value, "keep");
      orders.value = "after";
      let sent: any;
      w.request = async (method: string, url: string, body: unknown) => {
        if (method === "PUT") {
          sent = body;
          assert.ok(url.includes(encodeURIComponent(scope)));
        }
        return { ok: true, data: { ambientPolicy: policy(supportsAmbient) } };
      };
      await save.onclick!(new dom.window.MouseEvent("click") as unknown as PointerEvent);
      assert.deepEqual(JSON.parse(JSON.stringify(sent)), {
        orders: "after",
        baseUpdatedAt: 42,
        ...(supportsAmbient ? { bots: policy(true).bots, ambientEnabled: true } : {}),
      });
    }
    for (const p of [undefined, { orders: "old", bots: {}, updatedAt: 1 }]) {
      save.disabled = false;
      w.show(p);
      assert.equal(save.disabled, true);
      let writes = 0;
      w.request = async () => {
        writes++;
        return { ok: true };
      };
      await save.onclick!(new dom.window.MouseEvent("click") as unknown as PointerEvent);
      assert.equal(writes, 0);
      assert.match(doc.getElementById("st-ambient-policy")!.textContent!, /reload/i);
    }
  } finally {
    dom.window.close();
  }
});

for (const backToProject of [false, true])
  test(`admin policy save refresh ignores stale scope responses (round trip=${backToProject})`, async () => {
    const { dom, w, doc, save } = fixture();
    try {
      w.show(policy(false));
      let refresh!: () => void;
      const started = new Promise<void>((resolve) => {
        refresh = resolve;
      });
      let resolve!: (r: unknown) => void;
      w.request = async (method: string) => {
        if (method === "PUT") return { ok: true };
        refresh();
        return new Promise((r) => {
          resolve = r;
        });
      };
      const saving = save.onclick!(new dom.window.MouseEvent("click") as unknown as PointerEvent);
      await started;
      w.show({ ...policy(true), orders: "new scope" }, "channel:C317");
      if (backToProject) w.show({ ...policy(false), orders: "new scope" }, "group:web-project-317");
      resolve({ ok: true, data: { ambientPolicy: { ...policy(false), orders: "stale" } } });
      await saving;
      assert.equal((doc.getElementById("ambient-orders") as HTMLTextAreaElement).value, "new scope");
      assert.notEqual(doc.getElementById("st-ambient-policy")!.textContent, "Saved");
    } finally {
      dom.window.close();
    }
  });

test("admin scope load clears unsupported controls and cannot submit before a successful response", async () => {
  const { dom, w, doc, save, hidden } = fixture();
  try {
    w.show(policy(true));
    let resolve!: (r: unknown) => void;
    let writes = 0;
    w.request = async (method: string) => {
      if (method === "PUT") writes++;
      return new Promise((r) => {
        resolve = r;
      });
    };
    const loading = w.load("group:another-project");
    assert.equal(save.disabled, true);
    assert.equal(hidden(doc.getElementById("ambient-enabled")!), true);
    await save.onclick!(new dom.window.MouseEvent("click") as unknown as PointerEvent);
    assert.equal(writes, 0);
    w.show(policy(false), "group:web-project-317");
    resolve({ ok: true, data: { ambientPolicy: policy(true) } });
    await loading;
    assert.equal(hidden(doc.getElementById("ambient-enabled")!), true);
  } finally {
    dom.window.close();
  }
});
