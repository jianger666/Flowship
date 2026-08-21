/**
 * 定位 @cursor/sdk 平台包里的 rg，并注入本进程 PATH。
 *
 * 自定义提供方的 pi `grep` 会 `ensureTool("rg")`：先 PATH、找不到再去 GitHub 下
 * BurntSushi/ripgrep。国内下载常挂，模型就报「rg is not available」。
 * Cursor 对话后端用的同一份 rg 已经随 `@cursor/sdk-<platform>` 进包（assemble-server
 * 会补进 app-server），这里接到 PATH 上，用户不用装 Cursor IDE、也不再走 GitHub。
 *
 * 故意只扫磁盘、不 `import "@cursor/sdk"`：instrumentation 的 webpack bundle 不吃
 * serverExternalPackages，静态引 SDK 会把整棵模块树拖进编译炸掉全部路由。
 */

import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

const rgFileName = (): string =>
  process.platform === "win32" ? "rg.exe" : "rg";

const platformPkgName = (): string =>
  `sdk-${process.platform}-${process.arch}`;

const rgAtBinDir = (binDir: string): string | null => {
  const file = path.join(binDir, rgFileName());
  return existsSync(file) ? file : null;
};

/**
 * 从某个安装根（通常 process.cwd()，即项目根或 Electron app-server）找出 rg。
 * 兼容三种布局：CI hoisted 顶层包、pnpm 里 @cursor/sdk 的兄弟包、.pnpm 实体目录。
 */
export const resolveSdkRgPathFrom = (rootDir: string): string | null => {
  const plat = platformPkgName();
  const nm = path.join(rootDir, "node_modules");
  if (!existsSync(nm)) return null;

  const hoisted = rgAtBinDir(path.join(nm, "@cursor", plat, "bin"));
  if (hoisted) return hoisted;

  const sdkPkg = path.join(nm, "@cursor", "sdk");
  if (existsSync(sdkPkg)) {
    try {
      const sdkReal = realpathSync(sdkPkg);
      const sibling = rgAtBinDir(path.join(path.dirname(sdkReal), plat, "bin"));
      if (sibling) return sibling;
    } catch {
      /* 断链 / 无权限：继续扫 .pnpm */
    }
  }

  const pnpm = path.join(nm, ".pnpm");
  if (!existsSync(pnpm)) return null;
  const prefixes = [`@cursor+${plat}@`, "@cursor+sdk@"];
  try {
    for (const ent of readdirSync(pnpm)) {
      if (!prefixes.some((p) => ent.startsWith(p))) continue;
      const found = rgAtBinDir(
        path.join(pnpm, ent, "node_modules", "@cursor", plat, "bin"),
      );
      if (found) return found;
    }
  } catch {
    return null;
  }
  return null;
};

/** 把平台包 bin 前置进 PATH（幂等）。找不到 rg 只 warn、不阻断启动。 */
export const injectSdkRgPathFrom = (rootDir: string): void => {
  const file = resolveSdkRgPathFrom(rootDir);
  const bin = file ? path.dirname(file) : null;
  if (!bin) {
    console.warn(
      "[sdk-rg] 未找到 SDK 平台包里的 rg，自定义提供方 grep 可能尝试从 GitHub 下载",
    );
    return;
  }
  const cur = process.env.PATH ?? "";
  if (cur.split(path.delimiter).includes(bin)) return;
  process.env.PATH = `${bin}${path.delimiter}${cur}`;
  console.log(`[sdk-rg] PATH 已注入：${bin}`);
};

export const injectSdkRgPath = (): void => injectSdkRgPathFrom(process.cwd());

export const resolveSdkRgPath = (): string | null =>
  resolveSdkRgPathFrom(process.cwd());

export const resolveSdkRgBinDir = (): string | null => {
  const file = resolveSdkRgPath();
  return file ? path.dirname(file) : null;
};
