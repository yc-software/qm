import test from "node:test";
import assert from "node:assert/strict";
import { readBoundedText } from "../src/util/bytes.ts";

const tooLarge = () => new Error("too large");

function streamed(chunks: string[]) {
  let cancelled = false;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[index++]));
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(body), cancelled: () => cancelled };
}

test("readBoundedText returns the whole body when it fits, across chunk boundaries", async () => {
  const { response } = streamed(['{"a":', '"é"}']);
  assert.equal(await readBoundedText(response, 64, tooLarge), '{"a":"é"}');
  assert.equal(await readBoundedText(new Response(null), 64, tooLarge), "");
  const bom = new Response(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"a":1}')]));
  assert.deepEqual(JSON.parse(await readBoundedText(bom, 64, tooLarge)), { a: 1 });
});

test("readBoundedText refuses a declared oversize body before reading it", async () => {
  const response = new Response("x".repeat(10), { headers: { "content-length": "10" } });
  await assert.rejects(readBoundedText(response, 9, tooLarge), /too large/);
  await assert.rejects(response.text());
});

test("readBoundedText stops reading and cancels the stream once it passes the cap", async () => {
  const { response, cancelled } = streamed(["12345", "67890", "never read"]);
  await assert.rejects(readBoundedText(response, 8, tooLarge), /too large/);
  assert.equal(cancelled(), true);
});
