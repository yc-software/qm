import assert from "node:assert/strict";
import test from "node:test";
import { createLogger } from "vite";
import { createViteTestServer } from "./vite-test-server.ts";

test("Vite test servers do not compete for a WebSocket listener", async () => {
  const messages: string[] = [];
  const logger = createLogger();
  const error = logger.error;
  logger.error = (message, options) => {
    messages.push(message);
    error(message, options);
  };
  const servers = await Promise.all([
    createViteTestServer({ configFile: false, customLogger: logger }),
    createViteTestServer({ configFile: false, customLogger: logger }),
  ]);
  try {
    assert.deepEqual(
      messages.filter((message) => message.includes("WebSocket server error")),
      [],
    );
  } finally {
    await Promise.all(servers.map((server) => server.close()));
  }
});
