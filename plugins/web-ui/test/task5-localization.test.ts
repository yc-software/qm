import assert from "node:assert/strict";
import test from "node:test";
import { webMessage } from "../src/messages.ts";

test("connectors and deployments expose Japanese labels", () => {
  assert.equal(webMessage("ja", "connector.keychainTitle"), "認証情報");
  assert.equal(webMessage("ja", "keychain.add"), "認証情報を追加");
  assert.equal(webMessage("ja", "deployment.yours"), "自分のアプリ");
  assert.equal(webMessage("ja", "deployment.deployWithAgent"), "エージェントでアプリを公開");
});

test("one-off keychain access uses the localized API mode label", async () => {
  const keychain = (await import("../src/keychain-state.ts")) as unknown as {
    keychainAccessModeLabel?: (mode: string, selected: "en" | "ja") => string;
  };
  assert.equal(keychain.keychainAccessModeLabel?.("once", "ja"), "1回限りの");
});

test("context badges are localized and Google product names stay intact", () => {
  assert.equal(webMessage("ja", "context.access.shared"), "共有");
  assert.equal(webMessage("ja", "context.access.owned"), "所有");
  assert.equal(webMessage("ja", "context.access.private"), "非公開");
  assert.equal(webMessage("ja", "context.activeAt", { time: "3分前" }), "アクティブ 3分前");
  assert.equal(webMessage("ja", "connector.googleHosts"), "Gmail、Google Calendar、Google Drive、Google Sheets");
  assert.match(webMessage("ja", "connector.googleDescription"), /Google Calendar.*Google Sheets.*Google Drive/);
});
