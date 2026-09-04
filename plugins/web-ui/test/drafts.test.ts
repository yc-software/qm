import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearAllDrafts, clearDraft, flushDrafts, newChatDraftKey, saveDraft, storedDraft } from "../src/drafts.ts";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

beforeEach(() => {
  clearAllDrafts();
  store.clear();
});

test("a saved draft comes back for its conversation and not others", () => {
  saveDraft("web:me:a", "half-typed thought");
  assert.equal(storedDraft("web:me:a"), "half-typed thought");
  assert.equal(storedDraft("web:me:b"), "");
});

test("saving updates in place and clearing or blanking removes the entry", () => {
  saveDraft("web:me:a", "first");
  saveDraft("web:me:a", "second");
  assert.equal(storedDraft("web:me:a"), "second");
  saveDraft("web:me:a", "   ");
  assert.equal(storedDraft("web:me:a"), "");
  saveDraft("web:me:b", "kept");
  clearDraft("web:me:b");
  assert.equal(storedDraft("web:me:b"), "");
});

test("the store is LRU-capped: oldest drafts fall off, recently touched ones survive", () => {
  for (let i = 0; i < 30; i++) saveDraft(`t${i}`, `draft ${i}`);
  saveDraft("t0", "still warm");
  saveDraft("t30", "newest");
  assert.equal(storedDraft("t1"), "");
  assert.equal(storedDraft("t0"), "still warm");
  assert.equal(storedDraft("t30"), "newest");
});

test("corrupt storage is treated as empty rather than throwing", () => {
  store.set("web-ui:drafts", "{not json");
  assert.equal(storedDraft("anything"), "");
  saveDraft("web:me:a", "recovers");
  assert.equal(storedDraft("web:me:a"), "recovers");
});

test("an oversized draft is truncated instead of blowing the storage budget", () => {
  saveDraft("big", "x".repeat(50_000));
  assert.equal(storedDraft("big").length, 20_000);
});

test("the new-chat slot is scoped per user, so accounts on a shared browser don't cross", () => {
  saveDraft(newChatDraftKey("alice"), "alice's unsent text");
  assert.equal(storedDraft(newChatDraftKey("alice")), "alice's unsent text");
  assert.equal(storedDraft(newChatDraftKey("bob")), "");
  clearDraft(newChatDraftKey("alice"));
  assert.equal(storedDraft(newChatDraftKey("alice")), "");
});

test("sign-out wipes every stored draft", () => {
  saveDraft("web:me:a", "private half-thought");
  saveDraft(newChatDraftKey("me"), "more private text");
  clearAllDrafts();
  assert.equal(storedDraft("web:me:a"), "");
  assert.equal(storedDraft(newChatDraftKey("me")), "");
});

test("keystroke saves are read-your-writes but the storage write is debounced", () => {
  saveDraft("web:me:hot", "typed fast");
  assert.equal(storedDraft("web:me:hot"), "typed fast");
  assert.equal(store.get("web-ui:drafts") ?? "", "", "no synchronous storage write per keystroke");
  flushDrafts();
  assert.match(store.get("web-ui:drafts") ?? "", /typed fast/, "flush lands the pending draft");
});

test("another writer's storage update wins over a stale cache once flushed", () => {
  saveDraft("web:me:tab1", "mine");
  flushDrafts();
  store.set("web-ui:drafts", JSON.stringify([["web:me:tab2", "other tab"]]));
  assert.equal(storedDraft("web:me:tab2"), "other tab");
});
