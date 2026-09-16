import { readFile } from "node:fs/promises";
import { ModalClient } from "modal";
import { resolveModalImage } from "../src/sandbox/modal-image.ts";

const client = new ModalClient();
try {
  const app = await client.apps.fromName(process.env.MODAL_APP_NAME ?? "qm", { createIfMissing: true });
  const files = await Promise.all(
    ["package.json", "package-lock.json", "build.mjs"].map(async (name) => {
      const data = await readFile(new URL(`../deploy/connector-sdk/${name}`, import.meta.url));
      return `printf '%s' '${data.toString("base64")}' | base64 -d > /tmp/qm-connector-build/${name}`;
    }),
  );
  const base = await resolveModalImage(client, process.env.MODAL_IMAGE);
  const image = await base
    .dockerfileCommands([
      `RUN mkdir -p /tmp/qm-connector-build && ${files.join(" && ")} && cd /tmp/qm-connector-build && npm ci --ignore-scripts --no-audit --no-fund && node build.mjs /opt/qm/composio && rm -rf /tmp/qm-connector-build /root/.npm`,
      `RUN cd /opt/qm/composio && node -e 'if (typeof require("./sdk.cjs").Composio !== "function") process.exit(1)' && sha256sum sdk.cjs | cut -d ' ' -f1 | cmp - sha256`,
    ])
    .build(app);
  console.log(`MODAL_IMAGE=${image.imageId}`);
} finally {
  client.close();
}
