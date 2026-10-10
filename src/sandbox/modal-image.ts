import type { ModalClient } from "modal";

export const MODAL_DEFAULT_IMAGE =
  "node:24-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d";
const PYTHON_PACKAGES = [
  "beautifulsoup4==4.15.0",
  "lxml==6.1.3",
  "requests==2.34.2",
  "openpyxl==3.1.5",
  "pypdf==6.19.0",
  "python-docx==1.2.0",
];
const UV_VERSION = "0.12.19";
const UV_SHA256 = "23bf5552d220e0842b65c862097b2ebaeba0064b74eda5e565e77fd25969d8c8";
const AWSCLI_VERSION = "2.34.54";
const AWSCLI_SHA256 = "de278754dec97e0f6e9b4e8167d4bd1a27004c3e56e9c2da10002597f76ca35a";
export const MODAL_DEFAULT_IMAGE_SETUP =
  "RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git jq tar xz-utils unzip python3 python3-venv openssh-client && rm -rf /var/lib/apt/lists/*" +
  ` && curl -fsSL -o /tmp/uv.tgz https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz` +
  ` && echo "${UV_SHA256}  /tmp/uv.tgz" | sha256sum -c -` +
  " && tar -xzf /tmp/uv.tgz -C /usr/local/bin --strip-components=1 && rm /tmp/uv.tgz" +
  " && mkdir -p /etc/uv && printf '[pip]\\nsystem = true\\nbreak-system-packages = true\\n' > /etc/uv/uv.toml" +
  ` && uv pip install --no-cache --only-binary=:all: ${PYTHON_PACKAGES.join(" ")}` +
  ` && curl -fsSL -o /tmp/awscliv2.zip https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWSCLI_VERSION}.zip` +
  ` && echo "${AWSCLI_SHA256}  /tmp/awscliv2.zip" | sha256sum -c -` +
  " && unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/aws /tmp/awscliv2.zip && aws --version";

export async function resolveModalImage(client: ModalClient, reference?: string) {
  if (reference?.startsWith("im-")) return client.images.fromId(reference);
  if (reference) return client.images.fromRegistry(reference);
  return client.images.fromRegistry(MODAL_DEFAULT_IMAGE).dockerfileCommands([MODAL_DEFAULT_IMAGE_SETUP]);
}
