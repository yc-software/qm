import type { ModalClient } from "modal";

export const MODAL_DEFAULT_IMAGE =
  "node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";
export const MODAL_DEFAULT_IMAGE_SETUP =
  "RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git jq tar xz-utils unzip python3 python3-venv openssh-client && rm -rf /var/lib/apt/lists/*";

export async function resolveModalImage(client: ModalClient, reference?: string) {
  if (reference?.startsWith("im-")) return client.images.fromId(reference);
  if (reference) return client.images.fromRegistry(reference);
  return client.images.fromRegistry(MODAL_DEFAULT_IMAGE).dockerfileCommands([MODAL_DEFAULT_IMAGE_SETUP]);
}
