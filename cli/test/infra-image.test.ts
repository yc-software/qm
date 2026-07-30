import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAwsMicrovmImage, deleteAwsMicrovmImage, microvmBuildArchive } from "../src/commands/infra.ts";
import { loadConfigAt, type QmConfig } from "../src/config.ts";

function config(): QmConfig {
  return {
    contract: 1,
    orgId: "acme",
    publicUrl: "http://acme.example.com",
    target: "aws",
    services: ["core"],
    plugins: [],
    skills: [],
    env: { core: { HARNESS: "mock", AWS_DEPLOY_IMAGE: "acme-microvm" } },
    imageOverrides: {},
    aws: {
      accountId: "123456789012",
      region: "us-west-2",
      cluster: "acme-qm",
      deployRoleArn: "arn:aws:iam::123456789012:role/deploy",
      secretsPrefix: "acme/qm/",
      imageLabel: "latest",
      networking: { cloudMapNamespace: "acme.internal" },
      services: { core: { ecrRepository: "core", ecsService: "core", cpu: 256, memory: 512 } },
    },
  };
}

function fakeAws(dir: string): string {
  const path = join(dir, "aws-fake");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AWS_LOG, args.join(" ") + "\\n");
const command = args.slice(0, 2).join(" ");
const arn = "arn:aws:lambda:us-west-2:123456789012:microvm-image:acme-microvm";
const readState = () => fs.existsSync(process.env.FAKE_AWS_STATE) ? JSON.parse(fs.readFileSync(process.env.FAKE_AWS_STATE, "utf8")) : undefined;
const writeState = (state) => fs.writeFileSync(process.env.FAKE_AWS_STATE, JSON.stringify(state));
const lockPath = process.env.FAKE_AWS_STATE + ".lock";
const readLock = () => fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, "utf8")) : undefined;
const writeLock = (lock) => fs.writeFileSync(lockPath, JSON.stringify(lock));
const initial = () => {
  if (process.env.FAKE_MODE === "create") return undefined;
  if (process.env.FAKE_MODE === "deleted") return {version:2,state:"DELETED"};
  if (process.env.FAKE_MODE === "inflight") return {version:2,state:"UPDATING",externalInFlight:true};
  return {version:1,state:"UPDATED"};
};
let state = readState();
if (!state) {
  state = initial();
  if (state && process.env.FAKE_AWS_STATE) writeState(state);
}
const image = () => ({name:"acme-microvm",imageArn:process.env.FAKE_IMAGE_ARN || arn,state:state.state,latestActiveImageVersion:String(state.version)});
if (command === "dynamodb put-item") {
  const item = JSON.parse(args[args.indexOf("--item") + 1]);
  const current = readLock();
  if (current && Number(current.expiresAt) >= Math.floor(Date.now() / 1000)) {
    console.error("ConditionalCheckFailedException: lock held");
    process.exit(6);
  }
  writeLock({key:item.lockKey.S,holder:item.holder.S,expiresAt:item.expiresAt.N});
  console.log("{}");
} else if (command === "dynamodb delete-item") {
  const current = readLock();
  const values = JSON.parse(args[args.indexOf("--expression-attribute-values") + 1]);
  if (!current || current.holder !== values[":holder"].S) {
    console.error("ConditionalCheckFailedException: lease lost");
    process.exit(6);
  }
  fs.unlinkSync(lockPath);
  console.log("{}");
} else if (command === "sts get-caller-identity") console.log(process.env.FAKE_ACCOUNT || "123456789012");
else if (command === "s3api put-object") {
  if (!fs.existsSync(args[args.indexOf("--body") + 1])) process.exit(9);
  console.log("{}");
} else if (command === "s3api list-object-versions") {
  if (process.env.FAKE_EMPTY_OBJECT_VERSIONS !== "1") {
    console.log(JSON.stringify({Versions:[{Key:"deployment/microvm-images/a.zip",VersionId:"v1"}],DeleteMarkers:[{Key:"deployment/microvm-images/a.zip",VersionId:"m1"}]}));
  }
} else if (command === "s3api delete-objects") {
  console.log("{}");
} else if (command === "lambda-microvms list-microvm-images") {
  if (!state) console.log(JSON.stringify({items:[]}));
  else {
    if (state.externalInFlight && state.externalSeen) {
      state.state = "UPDATED";
      delete state.externalInFlight;
      delete state.externalSeen;
      writeState(state);
    } else if (state.externalInFlight) {
      state.externalSeen = true;
      writeState(state);
    } else if (state.state === "DELETING") {
      state.state = "DELETED";
      writeState(state);
    }
    console.log(JSON.stringify({items:[image()]}));
  }
} else if (command === "lambda-microvms list-tags") {
  console.log(JSON.stringify({Tags:{ManagedBy:"qm-cli",Deployment:process.env.FAKE_DEPLOYMENT_TAG || "acme"}}));
} else if (command === "lambda-microvms create-microvm-image" || command === "lambda-microvms update-microvm-image") {
  state = state || {version:0,state:"CREATED"};
  if (process.env.FAKE_CONFLICT === "1" && !state.conflictUsed) {
    state.conflictUsed = true;
    state.version++;
    state.state = "UPDATING";
    state.externalInFlight = true;
    writeState(state);
    console.error("ConflictException: another operation is in progress");
    process.exit(2);
  }
  state.version++;
  state.state = command.includes("create") ? "CREATING" : "UPDATING";
  state.operationVersion = String(state.version);
  state.versionPolls = 0;
  writeState(state);
  console.log(JSON.stringify({...image(),name:process.env.FAKE_OP_NAME || "acme-microvm",imageVersion:state.operationVersion}));
} else if (command === "lambda-microvms get-microvm-image-version") {
  const requested = args[args.indexOf("--image-version") + 1];
  if (requested !== state.operationVersion) process.exit(7);
  state.versionPolls++;
  const failed = process.env.FAKE_VERSION_FAIL === "1";
  const complete = state.versionPolls > 1;
  if (complete) state.state = failed ? "UPDATE_FAILED" : "UPDATED";
  writeState(state);
  console.log(JSON.stringify({imageArn:arn,imageVersion:requested,state:complete ? (failed ? "FAILED" : "SUCCESSFUL") : "IN_PROGRESS",status:complete && !failed ? "ACTIVE" : "INACTIVE",stateReason:failed ? "broken archive" : undefined}));
} else if (command === "lambda-microvms list-microvms") {
  console.log(JSON.stringify({items:state.microvmTerminated ? []:[{microvmId:"vm-1",state:"RUNNING"}]}));
} else if (command === "lambda-microvms terminate-microvm") {
  state.microvmTerminated = true;
  writeState(state);
  console.log("{}");
} else if (command === "lambda-microvms list-microvm-image-versions") {
  console.log(JSON.stringify({items:state.versionDeleted ? [{imageVersion:String(state.version),state:"DELETED"}]:[{imageVersion:String(state.version),state:"SUCCESSFUL"}]}));
} else if (command === "lambda-microvms delete-microvm-image-version") {
  state.versionDeleted = true;
  writeState(state);
  console.log("{}");
} else if (command === "lambda-microvms delete-microvm-image") {
  state.state = "DELETING";
  writeState(state);
  console.log("{}");
} else process.exit(8);
`,
  );
  chmodSync(path, 0o755);
  return path;
}

interface Harness {
  dir: string;
  configPath: string;
  log: string;
  calls: () => string;
}

async function withHarness(env: Record<string, string>, fn: (h: Harness) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "qm-infra-image-"));
  const configPath = join(dir, "qm.config.jsonc");
  const log = join(dir, "aws.log");
  writeFileSync(log, "");
  writeFileSync(configPath, `// deployment\n${JSON.stringify(config(), null, 2)}\n`);
  const names = [
    "AWS_BIN",
    "FAKE_AWS_LOG",
    "FAKE_AWS_STATE",
    "FAKE_MODE",
    "FAKE_ACCOUNT",
    "FAKE_CONFLICT",
    "FAKE_VERSION_FAIL",
    "FAKE_IMAGE_ARN",
    "FAKE_OP_NAME",
    "FAKE_EMPTY_OBJECT_VERSIONS",
    "FAKE_DEPLOYMENT_TAG",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.AWS_BIN = fakeAws(dir);
  process.env.FAKE_AWS_LOG = log;
  process.env.FAKE_AWS_STATE = join(dir, "state");
  for (const [name, value] of Object.entries(env)) process.env[name] = value;
  try {
    await fn({ dir, configPath, log, calls: () => readFileSync(log, "utf8") });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("infra delete-image accepts an empty successful S3 version response", async () => {
  await withHarness({ FAKE_MODE: "deleted", FAKE_EMPTY_OBJECT_VERSIONS: "1" }, async ({ calls }) => {
    await deleteAwsMicrovmImage(config(), { intervalMs: 0 });
    assert.match(calls(), /s3api list-object-versions/);
    assert.doesNotMatch(calls(), /s3api delete-objects/);
  });
});

test("the packaged MicroVM archive is deterministic and contains both root build files", () => {
  const first = microvmBuildArchive();
  assert.deepEqual(first, microvmBuildArchive());
  assert.equal(first.readUInt32LE(0), 0x04034b50);
  assert.ok(first.includes(Buffer.from("Dockerfile")));
  assert.ok(first.includes(Buffer.from("agent.mjs")));
});

for (const mode of ["create", "update"] as const) {
  test(`infra build-image ${mode}s the image and records immutable runtime coordinates`, async () => {
    await withHarness({ FAKE_MODE: mode }, async ({ configPath, calls }) => {
      const result = await buildAwsMicrovmImage(config(), configPath, { intervalMs: 0 });
      const expectedVersion = mode === "create" ? "1" : "2";
      assert.equal(result.version, expectedVersion);
      const loaded = loadConfigAt(configPath).config;
      assert.equal(loaded.env.core?.AWS_DEPLOY_IMAGE_VERSION, expectedVersion);
      assert.equal(loaded.env.core?.AWS_DEPLOY_EXEC_ROLE_ARN, "arn:aws:iam::123456789012:role/acme-qm-microvm-exec");
      assert.match(readFileSync(configPath, "utf8"), /^\/\/ deployment/);
      const logged = calls();
      assert.match(logged, /s3api put-object .*deployment\/microvm-images\/[a-f0-9]{64}\.zip/);
      assert.match(logged, new RegExp(`lambda-microvms ${mode}-microvm-image`));
      assert.match(logged, /--build-role-arn arn:aws:iam::123456789012:role\/acme-qm-microvm-build/);
      assert.match(
        logged,
        new RegExp(
          `lambda-microvms get-microvm-image-version --image-identifier .* --image-version ${expectedVersion}`,
        ),
      );
      assert.equal(logged.match(/lambda-microvms get-microvm-image-version/g)?.length, 2);
      if (mode === "create") assert.match(logged, /--tags \{"ManagedBy":"qm-cli","Deployment":"acme"\}/);
    });
  });
}

test("infra build-image checks the AWS account before uploading", async () => {
  await withHarness({ FAKE_ACCOUNT: "999999999999" }, async ({ configPath, calls }) => {
    await assert.rejects(buildAwsMicrovmImage(config(), configPath), /AWS account mismatch/);
    assert.doesNotMatch(calls(), /put-object|create-microvm-image/);
  });
});

test("infra build-image uses a fresh idempotency token for each explicit rebuild", async () => {
  await withHarness({ FAKE_MODE: "create" }, async ({ configPath, calls }) => {
    assert.equal((await buildAwsMicrovmImage(config(), configPath, { intervalMs: 0 })).version, "1");
    assert.equal((await buildAwsMicrovmImage(config(), configPath, { intervalMs: 0 })).version, "2");
    const tokens = [...calls().matchAll(/--client-token ([^\s]+)/g)].map((match) => match[1]);
    assert.equal(tokens.length, 2);
    assert.notEqual(tokens[0], tokens[1]);
    assert.match(tokens[0]!, /^[a-f0-9]{64}-[a-f0-9-]{36}$/);
  });
});

test("infra build-image reports failure from the exact version returned by update", async () => {
  await withHarness({ FAKE_MODE: "update", FAKE_VERSION_FAIL: "1" }, async ({ configPath, calls }) => {
    await assert.rejects(
      buildAwsMicrovmImage(config(), configPath, { intervalMs: 0 }),
      /version 2 failed: broken archive/,
    );
    const logged = calls();
    assert.match(logged, /get-microvm-image-version .* --image-version 2/);
    assert.match(logged, /dynamodb delete-item .*"lockKey":\{"S":"deploy"\}/);
  });
});

for (const scenario of ["inflight", "conflict"] as const) {
  test(`infra build-image waits out a ${scenario} build and polls only its own returned version`, async () => {
    const env: Record<string, string> =
      scenario === "inflight" ? { FAKE_MODE: "inflight" } : { FAKE_MODE: "update", FAKE_CONFLICT: "1" };
    await withHarness(env, async ({ configPath, calls }) => {
      const result = await buildAwsMicrovmImage(config(), configPath, { intervalMs: 0 });
      assert.equal(result.version, "3");
      const logged = calls();
      assert.match(logged, /get-microvm-image-version .* --image-version 3/);
      assert.doesNotMatch(logged, /get-microvm-image-version .* --image-version 2/);
      if (scenario === "conflict") assert.equal(logged.match(/update-microvm-image/g)?.length, 2);
    });
  });
}

for (const contender of ["build-image", "delete-image"] as const) {
  test(`infra image lifecycle lease serializes build-image against ${contender}`, async () => {
    await withHarness({ FAKE_MODE: "create" }, async ({ configPath, calls }) => {
      let entered!: () => void;
      let resume!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      try {
        const first = buildAwsMicrovmImage(config(), configPath, {
          intervalMs: 0,
          sleep: async () => {
            entered();
            await gate;
          },
        });
        await waiting;
        const second =
          contender === "build-image"
            ? buildAwsMicrovmImage(config(), configPath, { intervalMs: 0 })
            : deleteAwsMicrovmImage(config(), { intervalMs: 0 });
        await assert.rejects(second, /another QM operation holds the "deploy" lease/);
        const whileHeld = calls();
        assert.equal(whileHeld.match(/lambda-microvms (?:create|update)-microvm-image/g)?.length, 1);
        assert.doesNotMatch(whileHeld, /terminate-microvm|delete-microvm-image-version|delete-microvm-image --/);
        resume();
        assert.equal((await first).version, "1");
        const logged = calls();
        assert.equal(logged.match(/dynamodb put-item .*"lockKey":\{"S":"deploy"\}/g)?.length, 2);
        assert.equal(logged.match(/dynamodb delete-item .*"lockKey":\{"S":"deploy"\}/g)?.length, 1);
      } finally {
        resume();
      }
    });
  });
}

for (const operation of ["build", "delete"] as const) {
  test(`infra ${operation}-image refuses an image with an unexpected ARN before mutating anything`, async () => {
    await withHarness(
      { FAKE_MODE: "update", FAKE_IMAGE_ARN: "arn:aws:lambda:us-east-1:999999999999:microvm-image:acme-microvm" },
      async ({ configPath, calls }) => {
        const run =
          operation === "build"
            ? buildAwsMicrovmImage(config(), configPath, { intervalMs: 0 })
            : deleteAwsMicrovmImage(config(), { intervalMs: 0 });
        await assert.rejects(run, /unexpected MicroVM image ARN/);
        assert.doesNotMatch(calls(), /put-object|update-microvm-image|terminate-microvm|delete-microvm-image/);
      },
    );
  });
}

test("infra build-image refuses an operation response naming an unexpected image", async () => {
  await withHarness({ FAKE_MODE: "create", FAKE_OP_NAME: "other-image" }, async ({ configPath, calls }) => {
    await assert.rejects(
      buildAwsMicrovmImage(config(), configPath, { intervalMs: 0 }),
      /unexpected MicroVM image name/,
    );
    assert.doesNotMatch(calls(), /get-microvm-image-version/);
  });
});

for (const operation of ["build", "delete"] as const) {
  test(`infra ${operation}-image refuses a same-name image owned by another deployment`, async () => {
    await withHarness({ FAKE_MODE: "update", FAKE_DEPLOYMENT_TAG: "other" }, async ({ configPath, calls }) => {
      const run =
        operation === "build"
          ? buildAwsMicrovmImage(config(), configPath, { intervalMs: 0 })
          : deleteAwsMicrovmImage(config(), { intervalMs: 0 });
      await assert.rejects(run, /ownership tags do not match deployment acme/);
      assert.doesNotMatch(calls(), /put-object|update-microvm-image|terminate-microvm|delete-microvm-image --/);
    });
  });
}

for (const mode of ["update", "deleted"] as const) {
  test(`infra delete-image is idempotent for ${mode === "deleted" ? "an already deleted" : "an active"} image and removes versioned artifacts`, async () => {
    await withHarness({ FAKE_MODE: mode }, async ({ calls }) => {
      await deleteAwsMicrovmImage(config(), { intervalMs: 0 });
      const logged = calls();
      assert.match(logged, /s3api list-object-versions .* --prefix deployment\/microvm-images\//);
      assert.match(logged, /s3api delete-objects .*VersionId":"v1".*VersionId":"m1"/);
      if (mode === "deleted") {
        assert.doesNotMatch(logged, /list-microvms|list-microvm-image-versions|delete-microvm-image/);
      } else {
        assert.match(logged, /terminate-microvm/);
        assert.doesNotMatch(logged, /list-microvm-image-versions|delete-microvm-image-version/);
        assert.match(logged, /lambda-microvms delete-microvm-image --image-identifier/);
      }
    });
  });
}
