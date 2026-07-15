#!/usr/bin/env node
/**
 * 一次性生成「mac 自更新签名 manifest」的 Ed25519 密钥对（CR-02）
 *
 * 背景：mac 包不做 Apple 签名（内部分发）、自更新必须靠签名 manifest 自证——
 * CI 用私钥对 dmg 的 SHA-256 清单签名（generate-update-manifest.mjs）、
 * 壳内置公钥先验签再验哈希、验不过保留旧应用（fail-closed）。
 *
 * 使用（维护者跑一次）：
 *   node scripts/generate-update-keypair.mjs
 *   1. 私钥（整段 PEM）→ GitHub 仓库 Settings → Secrets → Actions → 新建
 *      `UPDATE_MANIFEST_PRIVATE_KEY`（⚠️ 别提交进仓库、别泄漏）
 *   2. 公钥已自动写到 electron-app/update-manifest-public-key.pem
 *      （壳 main.js + CI verify-update-manifest.mjs 共用、单一来源）
 *   3. 两者都配好后、后续 release 必带 update-manifest.json、壳强制验签
 *
 * 可选：UPDATE_MANIFEST_KEYPAIR_OUT=/path/to/private.pem 把私钥落到文件（默认只 stdout）
 */
import { generateKeyPairSync } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicKeyPath = path.join(root, "electron-app", "update-manifest-public-key.pem");
await fs.writeFile(publicKeyPath, pubPem, "utf8");

const outPriv = process.env.UPDATE_MANIFEST_KEYPAIR_OUT?.trim();
if (outPriv) {
  await fs.writeFile(outPriv, privPem, { mode: 0o600 });
  console.log(`私钥已写入 ${outPriv}（勿提交进仓库）`);
}

console.log("========== 私钥（存 GitHub secret：UPDATE_MANIFEST_PRIVATE_KEY、勿泄漏）==========\n");
console.log(privPem);
console.log(`========== 公钥已写入 ${publicKeyPath} ==========\n`);
console.log(pubPem);
console.log("生成完毕。私钥只显示这一次、请立即妥善保存。");
