import { app, net } from "electron";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const modelName = "ggml-large-v3-turbo-q5_0.bin";
const modelUrl = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelName}`;
const modelSize = 574_041_195;
const modelHash = "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2";

export async function downloadModel(progress) {
  const file = path.join(app.getPath("userData"), modelName);
  if (
    await access(file).then(
      () => true,
      () => false,
    )
  )
    return file;
  const response = await net.fetch(modelUrl);
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
          progress(received / modelSize);
          yield chunk;
        }
      },
      createWriteStream(`${file}.part`),
    );
    if (received !== modelSize || hash.digest("hex") !== modelHash)
      throw new Error("The download did not match the expected model");
    await rename(`${file}.part`, file);
  } finally {
    await rm(`${file}.part`, { force: true });
  }
  return file;
}
