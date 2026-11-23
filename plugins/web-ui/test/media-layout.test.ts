import assert from "node:assert/strict";
import test from "node:test";
import { formatDuration, justifyRows, mediaKind } from "../src/media-layout.ts";

test("attachments are classified by MIME type, falling back to the extension only for untyped files", () => {
  assert.equal(mediaKind("photo.jpg", "image/jpeg"), "image");
  assert.equal(mediaKind("scan.tiff", "image/tiff"), null);
  assert.equal(mediaKind("clip", "video/mp4; codecs=avc1"), "video");
  assert.equal(mediaKind("memo", "audio/mpeg"), "audio");
  assert.equal(mediaKind("clip.MOV", "application/octet-stream"), "video");
  assert.equal(mediaKind("memo.m4a"), "audio");
  assert.equal(mediaKind("clip.mp4", "application/pdf"), null);
  assert.equal(mediaKind("plan.pdf", "application/pdf"), null);
});

test("durations read as m:ss, or h:mm:ss past an hour", () => {
  assert.equal(formatDuration(7.9), "0:07");
  assert.equal(formatDuration(125), "2:05");
  assert.equal(formatDuration(3725), "1:02:05");
  assert.equal(formatDuration(Number.NaN), "0:00");
});

test("the mosaic keeps every tile in order, gives videos their own row and caps rows at four", () => {
  assert.deepEqual(justifyRows([16 / 9, 1, 1.5, 0.66, 3], [true, false, false, false, false], 700), [
    [0],
    [1, 2, 3, 4],
  ]);
  const many = justifyRows(Array(9).fill(1), Array(9).fill(false), 700);
  assert.deepEqual(many.flat(), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(many.every((row) => row.length <= 4));
});
