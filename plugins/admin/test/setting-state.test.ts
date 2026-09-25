import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingState, settingRegistry } from "../ui/setting-state.ts";

test("shared settings keep edits made while a save is pending", () => {
  const state = new SettingState("example");
  const registry = settingRegistry(new Map([[state.key, state]]));
  state.draft = { value: "initial" };
  registry.capture(state.key);
  state.draft.value = "submitted";
  const submitted = registry.collect(state.key);
  registry.status(state.key, "Saving…", "saving");
  state.draft.value = "newer edit";
  state.changed();
  assert.equal(state.message, "Saving…");
  registry.commit(state.key, submitted);
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
  const registry = settingRegistry(new Map([[state.key, state]]));
  state.draft = { value: "initial" };
  registry.capture(state.key);
  state.draft.value = " initial ";
  assert.equal(state.dirty, false);
  state.draft.value = " ";
  assert.equal(state.dirty, true);
  assert.throws(() => registry.collect(state.key), /Required/);
  assert.equal(registry.statusKey("st-example"), state.key);
  assert.equal(registry.statusKey("st-missing"), undefined);
});
