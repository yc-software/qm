import assert from "node:assert/strict";
import { app, BrowserWindow, Menu } from "electron";
import { mkdtempSync, rmSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(tmpdir(), "qm-meetings-"));
const wav = path.join(directory, "talk.wav");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-file-for-fake-audio-capture", wav);
const waitFor = async (check) => {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 100));
};
(async () => {
  const rate = 16_000;
  const samples = Int16Array.from({ length: rate * 5 }, (_, i) =>
    i < rate * 3 ? Math.round(9000 * Math.sin((2 * Math.PI * 220 * i) / rate)) : 0,
  );
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.byteLength, 40);
  await writeFile(wav, Buffer.concat([header, Buffer.from(samples.buffer)]));
  await writeFile(path.join(directory, "meetings.json"), JSON.stringify({ automatic: true }));
  const desk = path.join(directory, "desk.mjs");
  await writeFile(
    desk,
    `#!/usr/bin/env node
const line = (apps) => console.log(JSON.stringify({ type: "microphone", apps }));
line([]);
setTimeout(() => line([{ bundle_id: "us.zoom.xos", pid: 42 }]), 1000);
setTimeout(() => line([{ bundle_id: "com.qm.desktop.helper", pid: 43 }]), 30000);
setInterval(() => {}, 1000);
`,
  );
  await chmod(desk, 0o700);
  app.setPath("userData", directory);
  app.setPath("sessionData", directory);
  process.env.QM_DESK_BIN = desk;

  const log = [];
  const stopped = Promise.withResolvers();
  let failedOnce = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "http://stub");
    const reply = (status, value) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (!url.pathname.startsWith("/api/")) {
      res.setHeader("content-type", "text/html");
      return res.end(`<title>${url.pathname}</title>`);
    }
    if (req.method === "GET") return reply(200, { enabled: true });
    const [, , , id, action] = url.pathname.split("/");
    const entry = { action: action ?? "create", id, client: req.headers["x-qm-client"], origin: req.headers.origin };
    if (action === "speech") {
      Object.assign(entry, {
        speaker: url.searchParams.get("speaker"),
        at: Number(url.searchParams.get("at")),
        type: req.headers["content-type"],
        ebml: body.subarray(0, 4).toString("hex"),
        bytes: body.length,
      });
      log.push(entry);

      if (!failedOnce) {
        failedOnce = true;
        return reply(503, { error: "busy" });
      }
      return reply(200, { text: "hello" });
    }
    Object.assign(entry, JSON.parse(body));
    log.push(entry);

    if (action === "stop") {
      stopped.resolve(entry);
      return reply(202, {});
    }
    reply(201, { path: `/meetings/${entry.id}` });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.QM_DESKTOP_URL = origin;
  const started = Date.now();
  await app.whenReady();
  try {
    await import("../main.mjs");
    const stop = await stopped.promise;
    const ended = Date.now() - started;
    assert.ok(
      ended > 45_000 && ended < 70_000,
      `detected recording stopped ~20 s after the meeting ended (${ended} ms)`,
    );
    const [create, ...rest] = log;
    assert.equal(create.action, "create");
    assert.equal(create.app, "Zoom");
    assert.equal(create.id.length, 36);
    assert.equal(typeof create.timezone, "string");
    assert.equal(create.client, "desktop");
    assert.equal(create.origin, origin);
    assert.equal(rest.at(-1), stop);
    const speech = rest.slice(0, -1);
    assert.ok(speech.every((entry) => entry.action === "speech" && entry.id === create.id));
    assert.ok(speech.every((entry) => entry.type === "audio/webm" && entry.ebml === "1a45dfa3" && entry.bytes > 1000));
    const retried = speech.filter((entry) => entry.speaker === speech[0].speaker);
    assert.deepEqual(retried[0], retried[1], "a failed upload is retried with the same segment");
    for (const speaker of ["me", "others"]) {
      const at = [...new Set(speech.filter((entry) => entry.speaker === speaker).map((entry) => entry.at))];
      assert.ok(at.length >= 3, `${speaker} segments uploaded: ${at.length}`);
      assert.deepEqual(
        at,
        at.toSorted((a, b) => a - b),
        `${speaker} segments upload in order`,
      );
    }
    assert.ok(stop.endedAt >= Math.max(...speech.map((entry) => entry.at)));
    const menuItem = (label) =>
      Menu.getApplicationMenu()
        .items.flatMap((item) => item.submenu?.items ?? [])
        .find((item) => item.label === label);
    menuItem("Open Meeting Notes").click();
    const main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().startsWith(origin));
    await new Promise((resolve) => main.webContents.once("did-finish-load", resolve));
    assert.equal(main.webContents.getURL(), `${origin}/meetings/${create.id}`);
    menuItem("Start Recording").click();
    await waitFor(() => log.some((entry) => entry.action === "speech" && entry.id !== create.id));
    const manual = log.findLast((entry) => entry.action === "create");
    assert.equal(manual.app, undefined);
    app.on("will-quit", () => {
      server.close();
      rmSync(directory, { recursive: true, force: true });
      const last = log.at(-1);
      if (last.action !== "stop" || last.id !== manual.id) {
        console.error("Quitting did not flush and stop the recording", JSON.stringify(log, null, 1));
        return app.exit(1);
      }
      console.log(
        `PASS: detected Zoom, created the meeting lazily, uploaded ${speech.length} segments in order per track, retried a 503, stopped after the meeting ended, opened notes; a manual recording flushed and stopped on quit`,
      );
    });
    app.quit();
  } catch (error) {
    console.error(error, JSON.stringify(log, null, 1));
    app.exit(1);
  }
})();
