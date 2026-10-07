import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { app, BrowserWindow, shell } from "electron";
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
async function waitFor(read) {
  for (let i = 0; i < 200; i++) {
    const result = await read();
    if (result) return result;
    await tick();
  }
  throw new Error("Timed out waiting for desktop navigation");
}
(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qm-navigation-"));
  app.setPath("userData", directory);
  app.setPath("sessionData", directory);
  const opened = [];
  shell.openExternal = async (url) => {
    opened.push(url);
  };
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/") res.setHeader("set-cookie", "qm_navigation_test=yes; Path=/; HttpOnly");
    res.end(
      `<title>Navigation fixture</title><main>${req.method}:${req.headers.cookie?.includes("qm_navigation_test=yes") ? "session" : "initial"}</main>`,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.QM_DESKTOP_URL = origin;
  try {
    await import("../main.mjs");
    const main = await waitFor(() =>
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === origin + "/"),
    );
    await waitFor(() => main.webContents.executeJavaScript("!!window.qmDesktop"));
    await main.webContents.executeJavaScript('window.open("/preview", "_blank"); void 0');
    const preview = await waitFor(() =>
      BrowserWindow.getAllWindows().find((w) => w !== main && w.webContents.getURL() === origin + "/preview"),
    );
    assert.equal(
      await preview.webContents.executeJavaScript('document.querySelector("main").textContent'),
      "GET:session",
    );
    assert.equal(main.webContents.getURL(), origin + "/");
    assert.equal(await preview.webContents.executeJavaScript("typeof require"), "undefined");
    assert.equal(preview.webContents.getLastWebPreferences().sandbox, true);
    await main.webContents.executeJavaScript(
      'window.open(URL.createObjectURL(new Blob(["<title>Blob preview</title>"], {type:"text/html"})), "_blank"); void 0',
    );
    await waitFor(() => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith("blob:")));
    await main.webContents.executeJavaScript(
      'const p=window.open("", "_blank"); const form=p.document.createElement("form"); form.method="POST"; form.action="' +
        origin +
        '/posted"; p.document.body.append(form); form.submit(); void 0',
    );
    const posted = await waitFor(() =>
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === origin + "/posted"),
    );
    assert.equal(
      await posted.webContents.executeJavaScript('document.querySelector("main").textContent'),
      "POST:session",
    );
    await main.webContents.executeJavaScript('window.qmDesktop.openBrowser("/settings")');
    assert.deepEqual(opened, [origin + "/settings"]);
    const refused = await main.webContents.executeJavaScript(
      'window.qmDesktop.openBrowser("https://evil.example/").then(()=>false,()=>true)',
    );
    assert.equal(refused, true);
    assert.equal(opened.length, 1);
    main.destroy();
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    console.log(
      "PASS: separate previews, cookie isolation, blob URLs, blank POST popups, sandbox, browser bridge and child cleanup",
    );
  } finally {
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    app.quit();
  }
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
