import { packager } from "@electron/packager";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const release = process.argv.includes("--release");
const identity = process.env.QM_MAC_SIGN_IDENTITY;
const keychainProfile = process.env.QM_MAC_NOTARY_PROFILE;
if (release && (process.platform !== "darwin" || !identity || !keychainProfile)) {
  throw new Error("Mac releases require macOS, QM_MAC_SIGN_IDENTITY and QM_MAC_NOTARY_PROFILE.");
}
const apps = await packager({
  dir: directory,
  name: "QM",
  appBundleId: "com.qm.desktop",
  protocols: [{ name: "QM", schemes: ["qm-desktop"] }],
  icon: path.join(directory, "assets/qm"),
  out: path.join(directory, "dist"),
  overwrite: true,
  asar: true,
  ignore: /^\/(dist|test|README\.md|package\.mjs)/,
  ...(release ? { osxSign: { identity }, osxNotarize: { keychainProfile } } : {}),
});
for (const app of apps) console.log(app);
