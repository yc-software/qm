import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveConnectorKey,
  encryptSecret,
  decryptSecret,
  type SecretKey,
} from "../src/connectors/connector-client-store.ts";

const SIGNING = "old-shared-signing-secret-0123456789ab";
const CONNECTOR = "new-distinct-connector-key-0123456789";

test("rows encrypted under the pre-split signing-secret key still decrypt after CONNECTOR_SECRET_KEY lands", () => {
  const oldKey = deriveConnectorKey(SIGNING, "keychain");
  const stored = encryptSecret("xoxp-legacy-token", oldKey);

  const newKey: SecretKey = { ...deriveConnectorKey(CONNECTOR, "keychain"), fallbacks: [oldKey] };
  assert.equal(decryptSecret(stored, newKey), "xoxp-legacy-token");

  const rewritten = encryptSecret("xoxp-legacy-token", newKey);
  assert.equal(
    decryptSecret(rewritten, { ...deriveConnectorKey(CONNECTOR, "keychain") }),
    "xoxp-legacy-token",
    "writes use only the new key",
  );
});

test("without the fallback, an old row throws — and a wrong fallback rethrows the primary failure", () => {
  const oldKey = deriveConnectorKey(SIGNING, "keychain");
  const stored = encryptSecret("s", oldKey);
  const bare = deriveConnectorKey(CONNECTOR, "keychain");
  assert.throws(() => decryptSecret(stored, bare));
  const wrongFallback: SecretKey = {
    ...bare,
    fallbacks: [deriveConnectorKey("some-other-material-0123456789abcdef", "keychain")],
  };
  assert.throws(() => decryptSecret(stored, wrongFallback));
});
