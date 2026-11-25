#!/usr/bin/env node
/**
 * 重新计算 Windows 解锁组件资源文件（FlowshipUnlockHelper.cs / install.ps1 / uninstall.ps1）的 SHA-256，写回 protocol.mjs。
 *
 *   node scripts/win-helper-hashes.mjs           重算并写回（改了资源文件之后跑一次）
 *   node scripts/win-helper-hashes.mjs --check   只检查，不改文件；不一致就以非零码退出
 *
 * 原理与取舍见 scripts/lib/win-helper-hashes.mjs。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { syncAssetHashes } from "./lib/win-helper-hashes.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

try {
  const { changed, hashes } = await syncAssetHashes({ repoRoot, write: !check });
  for (const [name, hash] of Object.entries(hashes)) console.log(`${hash}  ${name}`);
  if (check) {
    if (changed) {
      console.error("[win-helper-hashes] protocol.mjs 里的期望哈希和磁盘上的资源文件对不上，运行 node scripts/win-helper-hashes.mjs 写回");
      process.exit(1);
    }
    console.log("[win-helper-hashes] 一致");
  } else {
    console.log(changed ? "[win-helper-hashes] 已写回 protocol.mjs" : "[win-helper-hashes] 没有变化");
  }
} catch (err) {
  console.error(`[win-helper-hashes] 失败：${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
