/**
 * assemble-server 补 SDK 平台包（pnpm isolated 布局）：顶层 node_modules/@cursor/sdk-<平台> 链接。
 *
 * 事故（2026-10-09）：本机 isolated 打的包里平台包 @cursor/sdk-darwin-arm64 在 .pnpm 内、
 * 也有 @cursor/sdk 的兄弟链接（够 Node require 用），但顶层 node_modules/@cursor/ 下没有它。
 * 而 SDK 的 platform-package-locator（@cursor/sdk dist/cjs/index.js，1.0.31 / 1.0.37 一致）定位 tree-sitter /
 * rg / cursorsandbox 时**不走 require 解析**——从入口脚本（server.js）所在目录起逐级向上找
 * `node_modules/@cursor/sdk-<平台>/<相对路径>`。顶层缺链接 → 三者全部定位失败：
 * shell 命令分析静默降级（日志 `tree-sitter natives are unavailable ... parsingFailed`）、
 * rg / 沙箱 helper 不可用。CI 用 hoisted 布局（平台包本来就在顶层）不走这个分支，
 * 所以官方包一直没暴露，只有本机构建的包会踩。
 *
 * 这里用最小的 pnpm isolated 夹具复现，并用「复刻的 SDK 定位算法」做断言。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addSdkPlatformPackage } from "../scripts/lib/assemble-server.mjs";

// 与实现一致：按当前运行平台取包名，测试在 macOS / Linux / Windows 上都构造对应夹具
const PLAT = `sdk-${process.platform}-${process.arch}`;
const VER = "1.0.31";
const ENC_SDK = `@cursor+sdk@${VER}`;
const ENC_PLAT = `@cursor+${PLAT}@${VER}`;

const tmpDirs: string[] = [];
const mkTmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "assemble-platpkg-"));
  tmpDirs.push(d);
  return d;
};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const writeFile = (file: string, content: string, mode?: number): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mode !== undefined) fs.chmodSync(file, mode);
};
const writeJson = (file: string, value: unknown): void => writeFile(file, JSON.stringify(value));

/** 在 linkPath 建指向 target 的相对 symlink（pnpm 的链接都是相对的） */
const relLink = (linkPath: string, target: string): void => {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(linkPath), target), linkPath);
};

const sdkMainDir = (root: string): string =>
  path.join(root, "node_modules", ".pnpm", ENC_SDK, "node_modules", "@cursor", "sdk");

/** 源仓库（本机 pnpm isolated）：@cursor/sdk 主包 + 当前平台的平台包（含 vendor 与 bin） */
const buildRoot = (root: string, opts: { withPlatformPkg?: boolean } = {}): void => {
  const pnpm = path.join(root, "node_modules", ".pnpm");
  writeJson(path.join(sdkMainDir(root), "package.json"), { name: "@cursor/sdk", version: VER });
  relLink(path.join(root, "node_modules", "@cursor", "sdk"), sdkMainDir(root));
  if (opts.withPlatformPkg === false) return;

  const plat = path.join(pnpm, ENC_PLAT, "node_modules", "@cursor", PLAT);
  writeJson(path.join(plat, "package.json"), { name: `@cursor/${PLAT}`, version: VER });
  for (const pkg of ["tree-sitter", "tree-sitter-bash"]) {
    writeFile(path.join(plat, "vendor", pkg, "index.js"), "module.exports = {};\n");
  }
  for (const bin of ["rg", "cursorsandbox"]) {
    writeFile(path.join(plat, "bin", bin), "#!/bin/sh\n", 0o755);
  }
  // pnpm 对 optionalDependencies 的兄弟链接
  relLink(path.join(sdkMainDir(root), "..", PLAT), plat);
};

/**
 * 目标目录（Next standalone 产物）：只带 @cursor/sdk 主包（nft 追不到平台包）。
 * pnpm 还会在主包兄弟目录预建一条指向「不随包的平台包」的断链——模拟它，覆盖「先清再建」路径。
 */
const buildDest = (dest: string): void => {
  writeJson(path.join(sdkMainDir(dest), "package.json"), { name: "@cursor/sdk", version: VER });
  relLink(path.join(dest, "node_modules", "@cursor", "sdk"), sdkMainDir(dest));
  fs.symlinkSync("../../../@cursor+nonexistent@0.0.0/node_modules/@cursor/x", path.join(sdkMainDir(dest), "..", PLAT));
  writeFile(path.join(dest, "server.js"), "");
};

// ───────── 复刻 SDK 的 platform-package-locator ─────────
// 源码：@cursor/sdk dist/cjs/index.js 的 "./src/agent/platform-package-locator.ts"
// （1.0.31 与 1.0.37 逐字一致，仅压缩后的变量名不同；夹具里的 VER 只是目录名，与实际安装版本无关）。
// 真实算法一路向上到文件系统根；这里在 stopAt（dest 的父目录）止步，避免被运行机器上层目录里
// 恰好存在的 node_modules 污染——真实起点 dirname(server.js) 就是 dest，第一层即命中。
const locate = (
  startDir: string,
  stopAt: string,
  relativePath: string,
  accept: (p: string) => boolean,
): string | undefined => {
  let dir = startDir;
  while (dir !== stopAt && dir !== path.parse(dir).root) {
    const cand = path.join(dir, "node_modules", "@cursor", PLAT, relativePath);
    if (accept(cand)) return cand;
    dir = path.dirname(dir);
  }
  return undefined;
};
const isExecutable = (f: string): boolean => {
  try {
    const s = fs.statSync(f);
    return s.isFile() && (process.platform === "win32" || !!(73 & s.mode));
  } catch {
    return false;
  }
};

describe("addSdkPlatformPackage：isolated 布局的顶层链接", () => {
  const run = async (): Promise<{ root: string; dest: string }> => {
    const root = mkTmp();
    const dest = mkTmp();
    buildRoot(root);
    buildDest(dest);
    await addSdkPlatformPackage(root, dest);
    return { root, dest };
  };

  it("SDK 定位算法能从 server.js 目录找到 tree-sitter / rg / cursorsandbox（回归：顶层缺链接会全部失败）", async () => {
    const { dest } = await run();
    const start = path.dirname(path.join(dest, "server.js"));
    const stop = path.dirname(dest);
    const treeSitter = locate(start, stop, "vendor", (p) =>
      fs.existsSync(path.join(p, "tree-sitter", "index.js")),
    );
    const rg = locate(start, stop, path.join("bin", "rg"), isExecutable);
    const sandbox = locate(start, stop, path.join("bin", "cursorsandbox"), isExecutable);
    expect(treeSitter, "tree-sitter vendor 目录").toBeDefined();
    expect(rg, "rg").toBeDefined();
    expect(sandbox, "cursorsandbox").toBeDefined();
    // tree-sitter-bash 与 tree-sitter 同在 vendor 下，一并可达
    expect(fs.existsSync(path.join(treeSitter!, "tree-sitter-bash", "index.js"))).toBe(true);
  });

  it("顶层链接是相对路径，解析到 dest 自己的 .pnpm（包拷去别处仍有效、不指回源目录）", async () => {
    const { root, dest } = await run();
    const link = path.join(dest, "node_modules", "@cursor", PLAT);
    expect(fs.lstatSync(link).isSymbolicLink(), "顶层应是 symlink").toBe(true);
    expect(path.isAbsolute(fs.readlinkSync(link)), "链接应是相对路径").toBe(false);
    const real = fs.realpathSync(link);
    expect(real.startsWith(path.join(fs.realpathSync(dest), "node_modules", ".pnpm") + path.sep)).toBe(true);
    expect(real.startsWith(fs.realpathSync(root) + path.sep), "不应指回源目录").toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(link, "package.json"), "utf8")).name).toBe(`@cursor/${PLAT}`);
  });

  it("原有的 @cursor/sdk 兄弟链接保持可用（Node require 路径不变），并覆盖 pnpm 预建的断链", async () => {
    const { dest } = await run();
    const sibling = path.join(sdkMainDir(dest), "..", PLAT);
    expect(fs.lstatSync(sibling).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(sibling, "package.json"), "utf8")).version).toBe(VER);
  });

  it("平台包实体连同可执行位一起拷进 dest/.pnpm", async () => {
    const { dest } = await run();
    const bin = path.join(dest, "node_modules", ".pnpm", ENC_PLAT, "node_modules", "@cursor", PLAT, "bin", "rg");
    expect(isExecutable(bin)).toBe(true);
  });

  it("幂等：重复调用不抛错，结果不变", async () => {
    const { root, dest } = await run();
    const link = path.join(dest, "node_modules", "@cursor", PLAT);
    const before = fs.readlinkSync(link);
    await expect(addSdkPlatformPackage(root, dest)).resolves.toBeUndefined();
    expect(fs.readlinkSync(link)).toBe(before);
    expect(fs.existsSync(path.join(link, "vendor", "tree-sitter", "index.js"))).toBe(true);
  });
});

describe("addSdkPlatformPackage：不该动的场景", () => {
  it("hoisted 布局（CI，无 .pnpm）：什么都不做，不建顶层链接", async () => {
    const root = mkTmp();
    const dest = mkTmp();
    buildRoot(root);
    // 目标是 hoisted 平铺：没有 .pnpm
    writeJson(path.join(dest, "node_modules", "@cursor", "sdk", "package.json"), { name: "@cursor/sdk", version: VER });

    await addSdkPlatformPackage(root, dest);

    expect(fs.existsSync(path.join(dest, "node_modules", ".pnpm"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "node_modules", "@cursor", PLAT))).toBe(false);
  });

  it("本机没装当前平台的平台包：告警并跳过，不留断链", async () => {
    const root = mkTmp();
    const dest = mkTmp();
    buildRoot(root, { withPlatformPkg: false });
    buildDest(dest);

    await addSdkPlatformPackage(root, dest);

    expect(warn).toHaveBeenCalled();
    expect(fs.existsSync(path.join(dest, "node_modules", "@cursor", PLAT))).toBe(false);
    // lstat 也不应有残留（existsSync 对断链返回 false，所以单独用 lstat 查）
    expect(() => fs.lstatSync(path.join(dest, "node_modules", "@cursor", PLAT))).toThrow();
  });
});
