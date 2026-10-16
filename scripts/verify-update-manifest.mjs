#!/usr/bin/env node
/**
 * CI 自检：用壳内置公钥验签刚生成的 update-manifest.json（fail-closed）
 *
 * 用法：node scripts/verify-update-manifest.mjs [manifest路径]
 * 公钥单一来源：electron-app/update-manifest-public-key.pem（跟 main.js 同一文件、防双源漂移）
 *
 * 任一步失败 exit 1：文件缺失 / JSON 坏 / 签名空 / 验签不过 / 条目覆盖面不对。
 *
 * 覆盖面检查（R9-01 起）：manifest 里必须是「2 枚 mac dmg（arm64 + x64）+ 1 枚 Windows exe」。
 * 壳按 asset 名在 manifest 里找条目、找不到就 fail-closed 拒绝自动安装——所以少任何一类，
 * 对应平台的自动更新就整体失效；与其发出这种 release、不如在转正前让 CI 红。
 * 这里不再假设「只有 dmg」：exe 与 dmg 同等对待。
 */
import { createPublicKey, verify } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.resolve(process.argv[2] || "update-manifest.json");
const publicKeyPath = path.join(root, "electron-app", "update-manifest-public-key.pem");

const publicKeyPem = (await fs.readFile(publicKeyPath, "utf8")).trim();
if (!publicKeyPem) {
  console.error(`::error::公钥文件为空：${publicKeyPath}`);
  process.exit(1);
}

let raw;
try {
  raw = await fs.readFile(manifestPath, "utf8");
} catch (err) {
  console.error(`::error::manifest 不存在：${manifestPath}（${err?.message || err}）`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(raw);
} catch (err) {
  console.error(`::error::manifest JSON 解析失败：${err?.message || err}`);
  process.exit(1);
}

if (!manifest?.version || !Array.isArray(manifest?.files) || !manifest?.signature) {
  console.error("::error::manifest 缺 version / files / signature 字段");
  process.exit(1);
}

// payload 重建必须与 generate-update-manifest.mjs / 壳 verifyDownloadedUpdate 同序
const payload = JSON.stringify({ version: manifest.version, files: manifest.files });
const ok = verify(
  null,
  Buffer.from(payload, "utf8"),
  createPublicKey(publicKeyPem),
  Buffer.from(String(manifest.signature), "base64"),
);

if (!ok) {
  console.error("::error::update-manifest 验签失败——私钥/公钥不匹配或 payload 被篡改");
  process.exit(1);
}

// ---- 条目结构 + 覆盖面（签名通过之后、对已被信任的内容做检查） ----
const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};

const names = new Set();
for (const f of manifest.files) {
  if (typeof f?.name !== "string" || !f.name) fail("manifest 条目缺 name");
  if (names.has(f.name)) fail(`manifest 条目重名：${f.name}`);
  names.add(f.name);
  if (!Number.isSafeInteger(f.size) || f.size <= 0) fail(`${f.name} 的 size 非法：${f.size}`);
  if (!/^[0-9a-f]{64}$/.test(String(f.sha256))) fail(`${f.name} 的 sha256 不是 64 位小写 hex`);
}

// 壳里的文件名约定：mac `fe-ai-flow-<ver>-mac-<arm64|x64>.dmg`（main.js 硬编码这两个）、
// win `fe-ai-flow-<ver>-win-<arch>.exe`（electron-builder.yml artifactName 的产物）；
// 文件名必须带本次版本号，防止把旧版本残留的 asset 误签进来
const prefix = `fe-ai-flow-${manifest.version}-`;
const dmgs = [...names].filter((n) => n.endsWith(".dmg")).sort();
const exes = [...names].filter((n) => n.endsWith(".exe"));
const expectedDmgs = [`${prefix}mac-arm64.dmg`, `${prefix}mac-x64.dmg`].sort();
if (JSON.stringify(dmgs) !== JSON.stringify(expectedDmgs)) {
  fail(`mac dmg 条目应恰为 ${expectedDmgs.join(" + ")}、实际：${dmgs.join(", ") || "无"}`);
}
const winPrefix = `${prefix}win-`;
const winExeOk =
  exes.length === 1 &&
  exes[0].startsWith(winPrefix) &&
  /^[A-Za-z0-9_]+\.exe$/.test(exes[0].slice(winPrefix.length));
if (!winExeOk) {
  fail(`Windows exe 条目应恰为 1 枚 ${winPrefix}<arch>.exe、实际：${exes.join(", ") || "无"}`);
}
// 除上面三枚外不该有别的条目（多出来的是误签 / 残留，如 .blockmap / .yml）
const extras = [...names].filter((n) => !dmgs.includes(n) && !exes.includes(n));
if (extras.length > 0) fail(`manifest 含预期之外的条目：${extras.join(", ")}`);

console.log(
  `update-manifest 验签通过：v${manifest.version}、${manifest.files.length} 个 asset`,
);
for (const f of manifest.files) {
  console.log(`  ${f.name}  ${f.size} bytes  sha256=${f.sha256}`);
}
