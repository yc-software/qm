import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyFastSpeed,
  modelSupportsFastMode,
  wantsFastMode,
  TURN_PROVIDER_EFFORT_ALIASES,
} from "../src/harness/pi-harness.ts";
import { defaultInteractiveThinkingLevel } from "../src/model/pi-models.ts";

test("modelSupportsFastMode allows only the documented direct Opus ids", () => {
  for (const id of ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"]) {
    assert.equal(modelSupportsFastMode(id), true, `${id} should support fast mode`);
  }
  for (const id of [
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
    "claude-opus-4.8",
    "anthropic/claude-opus-4.8-fast",
    "",
    undefined,
  ]) {
    assert.equal(modelSupportsFastMode(id as string | undefined), false, `${String(id)} must not support fast mode`);
  }
});

test('applyFastSpeed injects speed:"fast" into the body only when fast is requested', () => {
  const on = { model: "claude-opus-4-8", messages: [] } as Record<string, unknown>;
  assert.equal(applyFastSpeed(on, true), on, "returns the same object (in-place mutation)");
  assert.equal(on.speed, "fast");

  const off = { model: "claude-opus-4-8", messages: [] } as Record<string, unknown>;
  applyFastSpeed(off, false);
  applyFastSpeed(off, undefined);
  assert.equal("speed" in off, false, "no speed field on a non-fast turn");
});

test("applyFastSpeed never throws on non-object payloads", () => {
  assert.doesNotThrow(() => applyFastSpeed(undefined, true));
  assert.doesNotThrow(() => applyFastSpeed(null, true));
  assert.doesNotThrow(() => applyFastSpeed("raw", true));
});

test("TURN_PROVIDER_EFFORT_ALIASES maps web-ui aliases to Anthropic effort values", () => {
  assert.equal(TURN_PROVIDER_EFFORT_ALIASES.max, "max");
  assert.equal(
    TURN_PROVIDER_EFFORT_ALIASES.ultracode,
    "max",
    "Ultracode is a UI alias, not a provider effort enum (#312)",
  );
  assert.equal(TURN_PROVIDER_EFFORT_ALIASES.auto, null, "auto leaves effort to the provider/default path");
});

test("defaultInteractiveThinkingLevel keeps human turns light by provider", () => {
  assert.equal(defaultInteractiveThinkingLevel({ provider: "anthropic", api: "anthropic-messages" }), "low");
  assert.equal(defaultInteractiveThinkingLevel({ provider: "openai", api: "openai-responses" }), "auto");
});

test("fast mode is opt-in: only an explicit true selects it", () => {
  // A turn that never mentions fastMode has expressed no preference. Reading that as "yes"
  // bills it against a tier nobody asked for, and on an organization with no fast-mode
  // quota the provider rejects every such turn outright.
  assert.equal(wantsFastMode(undefined, "claude-opus-5"), false, "unset must not select fast mode");
  assert.equal(wantsFastMode(false, "claude-opus-5"), false);
  assert.equal(wantsFastMode(true, "claude-opus-5"), true, "an explicit opt-in is honoured");
});

test("an explicit opt-in still cannot select fast mode on a model that lacks it", () => {
  assert.equal(wantsFastMode(true, "claude-sonnet-5"), false);
  assert.equal(wantsFastMode(true, undefined), false);
  assert.equal(wantsFastMode(true, ""), false);
});
