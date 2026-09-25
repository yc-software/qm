import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModalClient } from "modal";
import { MODAL_DEFAULT_IMAGE, MODAL_DEFAULT_IMAGE_SETUP, resolveModalImage } from "../src/sandbox/modal-image.ts";

function client() {
  const calls: unknown[][] = [];
  const image = {
    dockerfileCommands(commands: string[]) {
      calls.push(["commands", commands]);
      return image;
    },
  };
  const sdk = {
    images: {
      fromRegistry(reference: string) {
        calls.push(["registry", reference]);
        return image;
      },
      async fromId(reference: string) {
        calls.push(["id", reference]);
        return image;
      },
    },
  } as unknown as ModalClient;
  return { calls, image, sdk };
}

test("Modal resolves a prebuilt image ID without creating registry layers", async () => {
  const { calls, image, sdk } = client();
  assert.equal(await resolveModalImage(sdk, "im-connector"), image);
  assert.deepEqual(calls, [["id", "im-connector"]]);
});

test("Modal preserves custom registry images and the default baseline", async () => {
  const { calls, sdk } = client();
  await resolveModalImage(sdk, "registry.example/sandbox@sha256:abc");
  assert.deepEqual(calls, [["registry", "registry.example/sandbox@sha256:abc"]]);
  calls.length = 0;
  await resolveModalImage(sdk);
  assert.deepEqual(calls, [
    ["registry", MODAL_DEFAULT_IMAGE],
    ["commands", [MODAL_DEFAULT_IMAGE_SETUP]],
  ]);
});
