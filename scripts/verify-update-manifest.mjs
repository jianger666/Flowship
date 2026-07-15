#!/usr/bin/env node
/**
 * CI 自检：用壳内置公钥验签刚生成的 update-manifest.json（fail-closed）
 *
 * 用法：node scripts/verify-update-manifest.mjs [manifest路径]
 * 公钥单一来源：electron-app/update-manifest-public-key.pem（跟 main.js 同一文件、防双源漂移）
 *
 * 任一步失败 exit 1：文件缺失 / JSON 坏 / 签名空 / 验签不过。
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

console.log(
  `update-manifest 验签通过：v${manifest.version}、${manifest.files.length} 个 asset`,
);
for (const f of manifest.files) {
  console.log(`  ${f.name}  ${f.size} bytes  sha256=${f.sha256}`);
}
