import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const assetsDir = join(process.cwd(), "dist", "assets");
const assetNames = await readdir(assetsDir);
const xtermAssets = assetNames.filter((name) => /^xterm-.*\.js$/.test(name));

if (xtermAssets.length === 0) {
  throw new Error("xterm build check failed: dist/assets/xterm-*.js was not found");
}

// Vite 6 could erase the enum backing variable in xterm's requestMode method,
// leaving an assignment to an undeclared identifier in the production chunk.
const brokenRequestMode = /requestMode\([^)]*\)\{[^{}]{0,80}\([A-Za-z_$][\w$]*=>[\s\S]{0,500}?\)\(void 0\|\|\(([A-Za-z_$][\w$]*)=\{\}\)\)/;

const bundleParts = [];
for (const assetName of xtermAssets) {
  const asset = await readFile(join(assetsDir, assetName), "utf8");
  bundleParts.push(asset);
  const match = asset.match(brokenRequestMode);
  if (match) {
    throw new Error(
      `xterm build check failed: requestMode assigns to undeclared variable ${match[1]} in ${assetName}`,
    );
  }
}

const webglPackage = JSON.parse(await readFile(join(process.cwd(), "node_modules/@xterm/addon-webgl/package.json"), "utf8"));
if (webglPackage.version !== "0.19.0") throw new Error("Review the shared atlas adapter before changing addon-webgl versions");
const bundle = bundleParts.join("\n");
for (const hook of ["_clearModel", "_requestClearModel"]) {
  if (!bundle.includes(hook)) throw new Error(`xterm build lost required atlas hook: ${hook}`);
}

console.log(`xterm build check passed (${xtermAssets.join(", ")})`);
