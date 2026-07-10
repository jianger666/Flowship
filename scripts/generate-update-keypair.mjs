#!/usr/bin/env node
/**
 * 一次性生成「mac 自更新签名 manifest」的 Ed25519 密钥对（CR-02）
 *
 * 背景：mac 包不做 Apple 签名（内部分发）、自更新原来只校验 Content-Length——
 * GitHub 账号 / Release asset / 下载链任一被攻破都能向所有用户投递任意代码。
 * 改用「签名 manifest」：CI 用私钥对 dmg 的 SHA-256 清单签名（generate-update-manifest.mjs）、
 * 壳内置公钥先验签再验哈希、验不过保留旧应用。
 *
 * 使用（维护者跑一次）：
 *   node scripts/generate-update-keypair.mjs
 *   1. 私钥（整段 PEM）→ GitHub 仓库 Settings → Secrets → Actions → 新建
 *      `UPDATE_MANIFEST_PRIVATE_KEY`（⚠️ 别提交进仓库、别泄漏）
 *   2. 公钥（整段 PEM）→ 粘贴到 electron-app/main.js 的
 *      `UPDATE_MANIFEST_PUBLIC_KEY` 常量、随下个版本发布
 *   3. 两者都配好后、后续 release 自动带 update-manifest.json、壳强制验签
 */
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

console.log("========== 私钥（存 GitHub secret：UPDATE_MANIFEST_PRIVATE_KEY、勿泄漏）==========\n");
console.log(privPem);
console.log("========== 公钥（粘贴到 electron-app/main.js 的 UPDATE_MANIFEST_PUBLIC_KEY）==========\n");
console.log(pubPem);
console.log("生成完毕。私钥只显示这一次、请立即妥善保存。");
