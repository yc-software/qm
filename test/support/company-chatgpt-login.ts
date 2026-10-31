import assert from "node:assert/strict";
import type { Keychain } from "../../src/credentials/keychain.ts";
import { hashId } from "../../src/util/crypto.ts";

export const COMPANY_CHATGPT_CREDENTIAL = hashId(["ops@x.com", "codex", "file"]);

export async function saveCompanyChatGPTLogin(keychain: Keychain | undefined, auth: object): Promise<void> {
  assert.ok(keychain, "the test app needs a keychain to hold the company ChatGPT login");
  const saved = await keychain.save({
    ownerId: "ops@x.com",
    service: "codex",
    files: [{ path: ".codex/auth.json", contentBase64: Buffer.from(JSON.stringify(auth)).toString("base64") }],
  });
  assert.equal(saved.id, COMPANY_CHATGPT_CREDENTIAL);
}
