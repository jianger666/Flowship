/**
 * Windows 解锁组件资源文件的 SHA-256：计算 + 写回 electron-app/desktop/win-helper/protocol.mjs。
 *
 * 为什么要有哈希：安装解锁组件时会弹一次系统管理员授权框，授权后以管理员身份运行 install.ps1 并编译 FlowshipUnlockHelper.cs。
 * 这两个文件随安装包放在用户目录下（Flowship 是免管理员安装的），普通进程改得动它们。
 * 引导程序在提权之后、运行任何一行之前，先把文件读进内存算 SHA-256、和 protocol.mjs 里的期望值对（对不上就不运行），
 * 再从内存里执行（不再读第二遍磁盘，没有「校验完被替换」的空档）。
 * 期望值写死在代码里，而不是运行时现算——现算的话校验就等于没有。
 * 这挡不住「已经能改写 Flowship 安装目录里全部文件」的恶意程序（它连 protocol.mjs 一起改了），只挡损坏 / 被换掉单个文件 / 意外混入；
 * 这个残留风险在 docs/HANDOFF.md 里如实记着。
 *
 * 改了 .cs / .ps1 之后运行 `node scripts/win-helper-hashes.mjs` 写回；单测（tests/desktop-win-helper-protocol.test.ts）会拦住忘记更新的情况。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { ASSET_FILES, HELPER_ASSET_SHA256, assetSha256 } from "../../electron-app/desktop/win-helper/protocol.mjs";

export const BEGIN_MARK = "// <asset-hashes:begin>";
export const END_MARK = "// <asset-hashes:end>";

export const assetsDirOf = (repoRoot) => path.join(repoRoot, "electron-app", "desktop", "win-helper", "assets");
export const protocolPathOf = (repoRoot) => path.join(repoRoot, "electron-app", "desktop", "win-helper", "protocol.mjs");

/**
 * 读 assets 目录里的三个资源文件，算出「文件名 → 哈希」。
 * @param {string} assetsDir
 * @returns {Promise<Record<string, string>>}
 */
export const computeAssetHashes = async (assetsDir) => {
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of Object.values(ASSET_FILES)) {
    out[name] = assetSha256(await fs.readFile(path.join(assetsDir, name)));
  }
  return out;
};

/** @param {Record<string, string>} hashes */
export const renderHashBlock = (hashes) => {
  const lines = Object.values(ASSET_FILES).map((name) => {
    const h = hashes[name];
    if (typeof h !== "string" || !/^[0-9A-F]{64}$/.test(h)) throw new Error(`${name} 的哈希不合法`);
    return `  ${JSON.stringify(name)}: ${JSON.stringify(h)},`;
  });
  return `export const HELPER_ASSET_SHA256 = Object.freeze({\n${lines.join("\n")}\n});\n`;
};

/**
 * 把哈希块写进 protocol.mjs 的源码（只替换两个标记之间的内容）。
 * @param {string} source
 * @param {Record<string, string>} hashes
 */
export const rewriteHashBlock = (source, hashes) => {
  const start = source.indexOf(BEGIN_MARK);
  const end = source.indexOf(END_MARK);
  if (start < 0 || end < start) throw new Error("protocol.mjs 里找不到资源哈希的标记（asset-hashes:begin / end）");
  return `${source.slice(0, start + BEGIN_MARK.length)}\n${renderHashBlock(hashes)}${source.slice(end)}`;
};

/**
 * 打 Windows 包时（afterPack）把解锁组件的三个资源文件拷进 resources/win-helper/。
 * 不放 asar：PowerShell 要读它们，asar 里的文件系统外部程序读不到。
 * 拷之前逐个核对哈希——和 protocol.mjs 里登记的不一致就让构建失败（别把「组件永远装不上」的包发出去）。
 * @param {{ repoRoot: string, resourcesDir: string, expected?: Record<string, string> }} opts
 * @returns {Promise<string>}  目标目录
 */
export const installWinHelperAssets = async ({ repoRoot, resourcesDir, expected = HELPER_ASSET_SHA256 }) => {
  const srcDir = assetsDirOf(repoRoot);
  const destDir = path.join(resourcesDir, "win-helper");
  await fs.rm(destDir, { recursive: true, force: true });
  await fs.mkdir(destDir, { recursive: true });
  for (const name of Object.values(ASSET_FILES)) {
    let bytes;
    try {
      bytes = await fs.readFile(path.join(srcDir, name));
    } catch (err) {
      // 这三个文件是我们自己的源码：缺了就是提交 / 拷贝遗漏，不是环境问题——报出缺哪个、去哪补，别只丢一句 ENOENT
      if (/** @type {NodeJS.ErrnoException | null} */ (err)?.code === "ENOENT") {
        throw new Error(`解锁组件资源 ${name} 不存在（应该在 ${srcDir}）：请确认 electron-app/desktop/win-helper/assets/ 里的三个文件都在`);
      }
      throw err;
    }
    const got = assetSha256(bytes);
    const want = expected[name];
    if (!want || want !== got) {
      throw new Error(`解锁组件资源 ${name} 的哈希（${got}）和 protocol.mjs 里登记的（${want ?? "没有"}）不一致，先运行 node scripts/win-helper-hashes.mjs`);
    }
    await fs.writeFile(path.join(destDir, name), bytes);
  }
  return destDir;
};

/**
 * 重算并（可选）写回。
 * @param {{ repoRoot: string, write?: boolean }} opts
 * @returns {Promise<{ changed: boolean, hashes: Record<string, string> }>}
 */
export const syncAssetHashes = async ({ repoRoot, write = true }) => {
  const hashes = await computeAssetHashes(assetsDirOf(repoRoot));
  const file = protocolPathOf(repoRoot);
  const before = await fs.readFile(file, "utf8");
  const after = rewriteHashBlock(before, hashes);
  const changed = after !== before;
  if (changed && write) await fs.writeFile(file, after);
  return { changed, hashes };
};
