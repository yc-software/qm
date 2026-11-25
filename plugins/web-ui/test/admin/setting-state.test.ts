import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingState } from "../../src/admin/setting-state.ts";

test("shared settings keep edits made while a save is pending", () => {
  const state = new SettingState("example");
  state.draft = { value: "initial" };
  state.loaded();
  state.draft.value = "submitted";
  const submitted = state.collect();
  Object.assign(state, { saving: true, message: "Saving…", tone: "saving" });
  state.draft.value = "newer edit";
  state.changed();
  assert.equal(state.message, "Saving…");
  state.commit(submitted);
  assert.equal(state.draft.value, "newer edit");
  assert.equal(state.dirty, true);
  assert.equal(state.saving, false);
  assert.equal(state.message, "Unsaved changes");
  state.draft.value = "submitted";
  state.changed();
  assert.equal(state.dirty, false);
});

test("shared settings compare normalized payloads and validate before saving", () => {
  class NormalizedSetting extends SettingState {
    collect(validate = true) {
      const value = this.draft.value.trim();
      if (validate && !value) throw new Error("Required");
      return { value };
    }
  }
  const state = new NormalizedSetting("example");
  state.draft = { value: "initial" };
  state.loaded();
  state.draft.value = " initial ";
  assert.equal(state.dirty, false);
  state.draft.value = " ";
  assert.equal(state.dirty, true);
  assert.throws(() => state.collect(), /Required/);
});
