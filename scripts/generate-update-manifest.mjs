#!/usr/bin/env node
/**
 * 生成签名的更新 manifest（CR-02、CI 发版链用）
 *
 * 用法：node scripts/generate-update-manifest.mjs <version> <asset 文件...>
 *   - 对每个 asset 算 SHA-256 + size、拼 manifest payload
 *   - 用 env `UPDATE_MANIFEST_PRIVATE_KEY`（Ed25519 私钥 PEM、GitHub secret）签名
 *   - 产出 `update-manifest.json`（CI 随后传到同 tag release）
 *   - **secret 未配置时**：打警告、退出 0、不产文件——渐进启用、不打断现有发版
 *
 * manifest 结构（签名覆盖 version + files、字段顺序即 JSON.stringify 顺序、验签方必须同序重建）：
 *   { version, files: [{ name, size, sha256 }], signature: base64(Ed25519(payload)) }
 *
 * 壳侧验证见 electron-app/main.js 的 verifyDownloadedUpdate。
 */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

const [version, ...assetPaths] = process.argv.slice(2);
if (!version || assetPaths.length === 0) {
  console.error("用法：node scripts/generate-update-manifest.mjs <version> <asset 文件...>");
  process.exit(1);
}

const privateKeyPem = process.env.UPDATE_MANIFEST_PRIVATE_KEY?.trim();
if (!privateKeyPem) {
  // GitHub Actions 的 ::warning:: 注解、在 job 摘要里可见
  console.log(
    "::warning::UPDATE_MANIFEST_PRIVATE_KEY 未配置、跳过更新 manifest 签名——" +
      "自更新将不带完整性校验；用 scripts/generate-update-keypair.mjs 生成密钥对后启用",
  );
  process.exit(0);
}

// 流式算 SHA-256（dmg 100MB+、不整读进内存）
const sha256File = (file) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });

const files = [];
for (const assetPath of assetPaths) {
  const stat = await fs.stat(assetPath);
  files.push({
    name: path.basename(assetPath),
    size: stat.size,
    sha256: await sha256File(assetPath),
  });
}

// 签名 payload：只覆盖 version + files（signature 字段本身不进 payload）
const payload = JSON.stringify({ version, files });
const signature = sign(
  null, // Ed25519 不用外部 digest 算法
  Buffer.from(payload, "utf8"),
  createPrivateKey(privateKeyPem),
).toString("base64");

const outPath = "update-manifest.json";
await fs.writeFile(
  outPath,
  JSON.stringify({ version, files, signature }, null, 2),
  "utf8",
);
console.log(`已生成 ${outPath}：`);
for (const f of files) console.log(`  ${f.name}  ${f.size} bytes  sha256=${f.sha256}`);
