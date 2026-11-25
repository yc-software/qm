import { app, net } from "electron";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const models = [
  {
    name: "ggml-large-v3-turbo-q5_0.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
    size: 574_041_195,
    hash: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
  },
  {
    name: "ggml-silero-v5.1.2.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
    size: 885_098,
    hash: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
  },
];
const fileOf = (model) => path.join(app.getPath("userData"), model.name);

async function matches(file, model) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex") === model.hash;
}

async function saved(file, model) {
  try {
    return (await stat(file)).size === model.size;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function download(model) {
  const file = fileOf(model);
  if (await saved(file, model)) return file;
  const response = await net.fetch(model.url);
  if (!response.ok) throw new Error(`Hugging Face answered HTTP ${response.status}`);
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(`${file}.part`));
    if (!(await matches(`${file}.part`, model)))
      throw new Error(`The download of ${model.name} did not match the expected model`);
    await rename(`${file}.part`, file);
  } finally {
    await rm(`${file}.part`, { force: true });
  }
  return file;
}

export async function downloadModel() {
  const files = [];
  for (const model of models) files.push(await download(model));
  return files;
}
