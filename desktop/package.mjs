import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const mac = process.platform === "darwin";
const release = process.argv.includes("--release");
const identity = process.env.QM_MAC_SIGN_IDENTITY;
if (release && (process.platform !== "darwin" || process.arch !== "arm64" || !identity)) {
  throw new Error("Mac releases require Apple Silicon macOS, QM_MAC_SIGN_IDENTITY and a signed-in Xcode account.");
}
if (mac)
  execFileSync("cargo", ["build", "--release", "--manifest-path", path.join(directory, "desk/Cargo.toml")], {
    stdio: "inherit",
  });
const apps = await packager({
  dir: directory,
  name: "QM",
  appBundleId: "com.qm.desktop",
  protocols: [{ name: "QM", schemes: ["qm-desktop"] }],
  icon: path.join(directory, "assets/qm"),
  out: path.join(directory, "dist"),
  overwrite: true,
  asar: true,
  ignore: /^\/(dist|test|desk(\/|$)|README\.md|package\.mjs)/,
  ...(mac ? { extraResource: [path.join(directory, "desk/target/release/desk")] } : {}),
  ...(mac && identity ? { osxSign: { identity } } : {}),
});
for (const app of apps) console.log(app);

if (release) {
  const execFile = promisify(execFileCallback);
  const output = path.join(directory, "dist");
  const archive = path.join(output, "QM.xcarchive");
  const app = path.join(apps[0], "QM.app");
  const { version } = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  const signature = await execFile("codesign", ["-dv", "--verbose=4", app]);
  const team = signature.stderr
    .split("\n")
    .find((line) => line.startsWith("TeamIdentifier="))
    ?.split("=")[1];
  if (!team) throw new Error("Signed app has no team identifier");
  for (const name of ["QM.xcarchive", "submission", "notarized"]) {
    await rm(path.join(output, name), { recursive: true, force: true });
  }
  await mkdir(path.join(archive, "Products", "Applications"), { recursive: true });
  await execFile("ditto", [app, path.join(archive, "Products", "Applications", "QM.app")]);
  const plist = async (file, data) => {
    await writeFile(file, JSON.stringify(data));
    await execFile("plutil", ["-convert", "xml1", file]);
  };
  await plist(path.join(archive, "Info.plist"), {
    ArchiveVersion: 2,
    Name: "QM",
    SchemeName: "QM",
    ApplicationProperties: {
      ApplicationPath: "Applications/QM.app",
      CFBundleIdentifier: "com.qm.desktop",
      CFBundleShortVersionString: version,
      CFBundleVersion: version,
      SigningIdentity: identity,
      Team: team,
      Architectures: [process.arch],
    },
  });
  const options = path.join(output, "export.plist");
  await plist(options, {
    method: "developer-id",
    destination: "upload",
    signingStyle: "manual",
    signingCertificate: identity,
    teamID: team,
  });
  await execFile("xcodebuild", [
    "-exportArchive",
    "-archivePath",
    archive,
    "-exportOptionsPlist",
    options,
    "-exportPath",
    path.join(output, "submission"),
  ]);
  console.log("Uploaded to Apple; waiting for notarization");
  const notarized = path.join(output, "notarized");
  for (let attempt = 0; ; attempt++) {
    try {
      await execFile("xcodebuild", ["-exportNotarizedApp", "-archivePath", archive, "-exportPath", notarized]);
      break;
    } catch (error) {
      if (attempt >= 20 || !`${error.stdout} ${error.stderr}`.includes("is processing and not ready")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
  const signedApp = path.join(notarized, "QM.app");
  await execFile("codesign", ["--verify", "--deep", "--strict", signedApp]);
  await execFile("xcrun", ["stapler", "validate", signedApp]);
  await execFile("spctl", ["--assess", "--type", "execute", signedApp]);
  const filename = `QM-mac-${process.arch}.zip`;
  await execFile("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", signedApp, path.join(output, filename)]);
  const bytes = await readFile(path.join(output, filename));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(output, "SHA256SUMS.txt"), `${sha256}  ${filename}\n`);
  await writeFile(
    path.join(output, "RELEASES.json"),
    JSON.stringify(
      {
        currentRelease: version,
        releases: [
          {
            version,
            updateTo: {
              version,
              name: `QM ${version}`,
              pub_date: new Date().toISOString(),
              url: `https://github.com/yc-software/qm/releases/download/desktop-v${version}/${filename}`,
              sha256,
              size: bytes.length,
            },
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`Verified release files: ${output}`);
}
