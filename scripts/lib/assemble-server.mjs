/**
 * 组「可运行的 server 布局」公共函数（V0.7.0 从 package-release.mjs 抽出）
 *
 * 产出布局（destDir/）：
 *   server.js + .next/ + node_modules/   ← Next standalone 自包含产物（纯 JS、跨平台）
 *   prompts/ + skills/ + scripts/        ← 运行时按 process.cwd() 读、必须随包
 *
 * 为什么 standalone 能直接当布局根：server.js 启动时 process.chdir(__dirname)、
 * 所以 prompts/scripts 平铺在 server.js 旁、运行时 process.cwd() 全部命中。
 *
 * 两个消费方：
 * - 绿色 zip 包：scripts/package-release.mjs（在此之上再加便携 node + launcher）
 * - Electron：scripts/assemble-electron-server.mjs（产物走 extraResources 进安装包）
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const exists = async (p) => fs.access(p).then(() => true, () => false);

const cp = async (src, dest) => {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(src, dest, { recursive: true });
};

export const assembleServerLayout = async (rootDir, destDir) => {
  const standaloneDir = path.join(rootDir, ".next", "standalone");
  if (!(await exists(standaloneDir))) {
    throw new Error("缺 .next/standalone——先跑 BUILD_STANDALONE=1 pnpm build");
  }

  // ---------- 1. standalone 产物 ----------
  await fs.rm(destDir, { recursive: true, force: true });
  await cp(standaloneDir, destDir);
  // standalone 不带静态资源、官方要求手动拷（没 public/ 目录就只拷 .next/static）
  await cp(
    path.join(rootDir, ".next", "static"),
    path.join(destDir, ".next", "static"),
  );
  if (await exists(path.join(rootDir, "public"))) {
    await cp(path.join(rootDir, "public"), path.join(destDir, "public"));
  }

  // 隐私剔除：file tracing 会把本机 data/（任务数据 + mcp-oauth 凭证）一并拖进
  // standalone、绝对不能随包分发——无条件删掉、首次运行自动重建空目录
  await fs.rm(path.join(destDir, "data"), { recursive: true, force: true });

  // ---------- 2. 运行时按 cwd 读的目录（tracing 对动态 fs 读不保证、显式拷一遍兜底） ----------
  await cp(path.join(rootDir, "prompts"), path.join(destDir, "prompts"));
  await cp(path.join(rootDir, "skills"), path.join(destDir, "skills"));
  for (const f of ["stop-hook.mjs", "shell-guard.mjs"]) {
    await cp(path.join(rootDir, "scripts", f), path.join(destDir, "scripts", f));
  }
};
