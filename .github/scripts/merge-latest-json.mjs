// publish-updater-json job（串行、唯一写者）：聚合各 build job 的
// updater-metadata 工件，从零构建 latest.json。key 形态与 tauri-action 一致：
// 基础 key（windows-x86_64）指向该平台的首选 bundle，另为每个 bundle 变体
// 生成后缀 key（windows-x86_64-nsis）。
//
// env: VERSION, TAG, REPO
// 输入文件: metadata/**/*.json（download-artifact 落盘）、
//           release-body.txt（notes）、release-assets.txt（资产名单，逐行）
import fs from "node:fs";
import path from "node:path";

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`missing env ${name}`);
    process.exit(1);
  }
  return value;
}

const version = required("VERSION");
const tag = required("TAG");
const repo = required("REPO");

const PREFERRED_SUFFIX = { linux: "appimage", windows: "nsis", darwin: "app" };
const EXPECTED_KEYS = [
  "windows-x86_64",
  "windows-aarch64",
  "darwin-aarch64",
  "darwin-x86_64",
  "linux-x86_64",
];

const entries = [];
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.isFile() && entry.name.endsWith(".json")) {
      entries.push(...JSON.parse(fs.readFileSync(p, "utf8")));
    }
  }
}
walk("metadata");

if (entries.length === 0) {
  console.error("no updater metadata collected — all build jobs failed or artifacts missing");
  process.exit(1);
}

const releaseAssets = new Set(
  fs
    .readFileSync("release-assets.txt", "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean),
);

const platforms = {};
const missingAssets = [];
for (const entry of entries) {
  if (typeof entry.signature !== "string" || !entry.signature.trim()) {
    console.error(`missing updater signature for ${entry.asset}`);
    process.exit(1);
  }
  if (!releaseAssets.has(entry.asset)) {
    missingAssets.push(entry.asset);
    continue;
  }
  const url = `https://github.com/${repo}/releases/download/${tag}/${entry.asset}`;
  const value = { signature: entry.signature, url };
  platforms[`${entry.platformKey}-${entry.suffix}`] = value;
  const os = entry.platformKey.split("-")[0];
  if (PREFERRED_SUFFIX[os] === entry.suffix) {
    platforms[entry.platformKey] = value;
  }
}

if (missingAssets.length > 0) {
  // 引用不存在的资产 = updater 侧 404，宁可整个 job 红掉也不发坏清单
  console.error(`referenced assets missing from release: ${missingAssets.join(", ")}`);
  process.exit(1);
}

const missingPlatforms = EXPECTED_KEYS.filter(key => !platforms[key]);
if (missingPlatforms.length > 0) {
  console.error(`incomplete release: missing updater platforms ${missingPlatforms.join(", ")}`);
  process.exit(1);
}

const latest = {
  version,
  notes: fs.readFileSync("release-body.txt", "utf8").trim(),
  pub_date: new Date().toISOString(),
  platforms,
};

fs.writeFileSync("latest.json", `${JSON.stringify(latest, null, 2)}\n`);
console.log(`latest.json platforms: ${Object.keys(platforms).sort().join(", ")}`);
