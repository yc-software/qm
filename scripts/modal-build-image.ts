import { ModalClient } from "modal";
import { resolveModalImage } from "../src/sandbox/modal-image.ts";

const client = new ModalClient();
try {
  const app = await client.apps.fromName(process.env.MODAL_APP_NAME ?? "qm", { createIfMissing: true });
  const image = await (await resolveModalImage(client, process.env.MODAL_IMAGE)).build(app);
  console.log(`MODAL_IMAGE=${image.imageId}`);
} finally {
  client.close();
}
