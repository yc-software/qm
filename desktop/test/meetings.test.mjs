import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";
import vm from "node:vm";

const context = { window: {} };
vm.runInNewContext(await readFile(new URL("../segments.js", import.meta.url), "utf8"), context);

function segments(loud, until = 40_000) {
  const cut = context.window.createSegmenter(0);
  const found = [];
  for (let now = 100; now <= until; now += 100) {
    const segment = cut(now, loud(now));
    if (segment) found.push({ ...segment, end: now });
  }
  return [...found, { ...cut(until, false, true), end: until }];
}

test("segments end at the first pause after ten seconds, at thirty seconds otherwise, and flag speech", () => {
  assert.deepEqual(
    segments((now) => now < 12_000),
    [
      { at: 0, speech: true, end: 12_700 },
      { at: 12_700, speech: false, end: 22_700 },
      { at: 22_700, speech: false, end: 32_700 },
      { at: 32_700, speech: false, end: 40_000 },
    ],
  );
  assert.deepEqual(
    segments(() => true, 61_000).map(({ at, end }) => [at, end]),
    [
      [0, 30_000],
      [30_000, 60_000],
      [60_000, 61_000],
    ],
  );
  assert.equal(segments((now) => now === 5_000)[0].speech, false, "a click is not speech");
});

test("meeting detection counts only listed meeting apps, including browser helpers", async () => {
  mock.module("electron", {
    namedExports: {
      app: {},
      net: {},
      Menu: {},
      nativeImage: {},
      Notification: class {},
      systemPreferences: {},
      Tray: class {},
    },
  });
  mock.module("../desk.mjs", { namedExports: { startWhisper() {}, watchMicrophone() {} } });
  mock.module("../recorder.mjs", { namedExports: { registerRecorder() {}, startCapture() {} } });
  const { meetingApp } = await import("../meetings.mjs");
  assert.equal(meetingApp([{ bundle_id: "us.zoom.xos", pid: 1 }]), "Zoom");
  assert.equal(
    meetingApp([
      { bundle_id: null, pid: 2 },
      { bundle_id: "com.apple.VoiceMemos", pid: 3 },
      { bundle_id: "com.google.Chrome.helper", pid: 4 },
    ]),
    "Google Chrome",
  );
  assert.equal(meetingApp([{ bundle_id: "com.apple.WebKit.GPU", pid: 5 }]), "Safari");
  assert.equal(meetingApp([{ bundle_id: "com.qm.desktop.helper", pid: 6 }]), undefined);
  assert.equal(meetingApp([]), undefined);
});
