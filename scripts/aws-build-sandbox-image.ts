#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  S3Client,
  PutObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  type BucketLocationConstraint,
} from "@aws-sdk/client-s3";
import { createMicrovmApi } from "../src/sandbox/aws-microvm-api.ts";
import { sleep } from "../src/util/async.ts";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = join(HERE, "..", "aws", "microvm-agent");

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env ${name}`);
  return v;
}

async function main(): Promise<void> {
  const region = process.env.AWS_SANDBOX_REGION ?? process.env.AWS_REGION ?? "us-west-2";
  const profile = process.env.AWS_SANDBOX_PROFILE;
  const imageName = process.env.AWS_SANDBOX_IMAGE ?? "qm-microvm-sandbox";
  const bucket = reqEnv("AWS_SANDBOX_BUILD_BUCKET");
  const buildRoleArn = reqEnv("AWS_SANDBOX_BUILD_ROLE_ARN");
  const baseImageArn = process.env.AWS_SANDBOX_BASE_IMAGE_ARN ?? `arn:aws:lambda:${region}:aws:microvm-image:al2023-1`;
  const key = `deployment/microvm-images/${imageName}.zip`;

  const s3 = new S3Client({ region, ...(profile ? { profile } : {}) });
  const api = createMicrovmApi({ region, ...(profile ? { profile } : {}) });

  console.log(`[build] region=${region} image=${imageName} bucket=${bucket}`);

  const work = mkdtempSync(join(tmpdir(), "aws-microvm-image-"));
  const zipPath = join(work, "context.zip");
  await execFileAsync("zip", ["-j", "-q", zipPath, join(AGENT_DIR, "Dockerfile"), join(AGENT_DIR, "agent.mjs")]);
  console.log(`[build] packaged Dockerfile + agent.mjs -> ${zipPath}`);

  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(
      new CreateBucketCommand({
        Bucket: bucket,
        CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint },
      }),
    );
    console.log(`[build] created bucket ${bucket}`);
  }
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: readFileSync(zipPath) }));
  console.log(`[build] uploaded s3://${bucket}/${key}`);

  const existing = await api.findImage(imageName);
  const operation = existing
    ? await api.updateImage({
        imageIdentifier: existing.imageArn,
        s3Uri: `s3://${bucket}/${key}`,
        baseImageArn,
        buildRoleArn,
        clientToken: `${imageName}-${Date.now()}`,
      })
    : await api.createImage({
        name: imageName,
        s3Uri: `s3://${bucket}/${key}`,
        baseImageArn,
        buildRoleArn,
        clientToken: `${imageName}-${Date.now()}`,
      });
  console.log(`[build] ${existing ? "update" : "create"}-microvm-image -> ${operation.imageArn} (building...)`);

  const deadline = Date.now() + 12 * 60_000;
  for (;;) {
    const img = await api.findImage(imageName);
    const state = img?.state;
    console.log(`[build] image state: ${state} activeVersion: ${img?.latestActiveImageVersion ?? "-"}`);
    if (state === "CREATED" || state === "UPDATED") {
      console.log(
        `\n[build] DONE\n  imageArn: ${img!.imageArn}\n  version : ${img!.latestActiveImageVersion}\n  set AWS_SANDBOX_IMAGE=${imageName}`,
      );
      return;
    }
    if (state === "CREATE_FAILED" || state === "UPDATE_FAILED")
      throw new Error(`image build failed: ${JSON.stringify(img)}`);
    if (Date.now() > deadline) throw new Error("image build timed out");
    await sleep(10_000);
  }
}

main().catch((e) => {
  console.error("[build] error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
