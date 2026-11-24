import { app, net } from "electron";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, rename, rm } from "node:fs/promises";
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
const total = models.reduce((sum, model) => sum + model.size, 0);
const fileOf = (model) => path.join(app.getPath("userData"), model.name);

async function download(model, progress) {
  const file = fileOf(model);
  if (
    await access(file).then(
      () => true,
      () => false,
    )
  )
    return file;
  const response = await net.fetch(model.url);
  if (!response.ok) throw new Error(`Hugging Face answered HTTP ${response.status}`);
  const hash = createHash("sha256");
  let received = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      async function* (chunks) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          received += chunk.length;
          progress(received);
          yield chunk;
        }
      },
      createWriteStream(`${file}.part`),
    );
    if (received !== model.size || hash.digest("hex") !== model.hash)
      throw new Error("The download did not match the expected model");
    await rename(`${file}.part`, file);
  } finally {
    await rm(`${file}.part`, { force: true });
  }
  return file;
}

export async function downloadModel(progress) {
  const files = [];
  let done = 0;
  for (const model of models) {
    files.push(await download(model, (received) => progress((done + received) / total)));
    done += model.size;
  }
  return files;
}

export async function discardCorruptModels() {
  let discarded = false;
  for (const model of models) {
    const hash = createHash("sha256");
    try {
      for await (const chunk of createReadStream(fileOf(model))) hash.update(chunk);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      discarded = true;
      continue;
    }
    if (hash.digest("hex") === model.hash) continue;
    await rm(fileOf(model), { force: true });
    discarded = true;
  }
  return discarded;
}
