#!/usr/bin/env node
import { resolve } from "node:path";
import { createRelayServer } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
const stateFile = resolve(
  process.env.INWISE_QM_STATE_FILE ?? "./data/qm-relay.json",
);
const publicUrl = process.env.INWISE_QM_PUBLIC_URL;
const requestTimeoutMs = Number(
  process.env.INWISE_QM_REQUEST_TIMEOUT_MS ?? 45_000,
);

const server = createRelayServer({ stateFile, publicUrl, requestTimeoutMs });
server.listen(port, "0.0.0.0", () => {
  console.log(`Inwise QM relay listening on port ${port}`);
});
