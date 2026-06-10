#!/usr/bin/env node
/**
 * 绿色包组包脚本（V0.6.30）——给零 node 环境的同事产出「解压即用」Windows 包
 *
 * 前置：`BUILD_STANDALONE=1 pnpm build`（next.config 里 env 开 standalone 输出）
 *
 * 产物（dist/fe-ai-flow-win-x64.zip、顶层带 fe-ai-flow/ 目录）：
 *   fe-ai-flow/
 *     server.js + .next/ + node_modules/   ← Next standalone 自包含产物
 *     prompts/ + scripts/                  ← 运行时按 process.cwd() 读、必须随包
 *     node/node.exe                        ← 官方便携 node（latest v22.x）、同事机器零依赖
 *     launcher/ + 启动fe-ai-flow.bat       ← 静默启动 + 自动更新 + 桌面快捷方式
 *     VERSION                              ← 发版 tag、launcher 自动更新比对用
 *
 * 用法：
 *   RELEASE_TAG=v0.6.30 node scripts/package-release.mjs          # CI 完整组包
 *   SKIP_NODE_RUNTIME=1 SKIP_ZIP=1 node scripts/package-release.mjs  # 本地验证布局
 *
 * 为什么 standalone 能直接当包根：Next standalone 的 server.js 启动时
 * process.chdir(__dirname)、所以把 prompts/scripts 平铺在 server.js 旁、
 * 运行时 process.cwd() 全部命中——data/ 也会落在包根、更新时被 launcher 排除保留。
 */

import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const DIST = path.join(ROOT, "dist");
const PKG = path.join(DIST, "pkg", "fe-ai-flow");
const TAG = process.env.RELEASE_TAG || "v0.0.0-dev";

const exists = async (p) => fs.access(p).then(() => true, () => false);

const cp = async (src, dest) => {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(src, dest, { recursive: true });
};

// ---------- 1. standalone 产物 ----------
const standaloneDir = path.join(ROOT, ".next", "standalone");
if (!(await exists(standaloneDir))) {
  console.error("缺 .next/standalone——先跑 BUILD_STANDALONE=1 pnpm build");
  process.exit(1);
}
await fs.rm(path.join(DIST, "pkg"), { recursive: true, force: true });
await cp(standaloneDir, PKG);
// standalone 不带静态资源、官方要求手动拷（没 public/ 目录就只拷 .next/static）
await cp(path.join(ROOT, ".next", "static"), path.join(PKG, ".next", "static"));
if (await exists(path.join(ROOT, "public"))) {
  await cp(path.join(ROOT, "public"), path.join(PKG, "public"));
}

// 隐私剔除：file tracing 会把本机 data/（任务数据 + mcp-oauth 凭证）一并拖进
// standalone、绝对不能随包分发——无条件删掉、同事侧首次运行自动重建空目录
await fs.rm(path.join(PKG, "data"), { recursive: true, force: true });

// ---------- 2. 运行时按 cwd 读的目录（tracing 对动态 fs 读不保证、显式拷一遍兜底） ----------
await cp(path.join(ROOT, "prompts"), path.join(PKG, "prompts"));
await cp(path.join(ROOT, "skills"), path.join(PKG, "skills"));
for (const f of ["stop-hook.mjs", "shell-guard.mjs"]) {
  await cp(path.join(ROOT, "scripts", f), path.join(PKG, "scripts", f));
}

// ---------- 3. launcher ----------
await cp(path.join(ROOT, "packaging", "launch.ps1"), path.join(PKG, "launcher", "launch.ps1"));
await cp(path.join(ROOT, "packaging", "launch.vbs"), path.join(PKG, "launcher", "launch.vbs"));
await cp(path.join(ROOT, "packaging", "start.bat"), path.join(PKG, "启动fe-ai-flow.bat"));
await fs.writeFile(path.join(PKG, "VERSION"), `${TAG}\n`, "utf8");

// ---------- 4. 便携 node（win-x64、版本动态取 latest v22.x） ----------
if (!process.env.SKIP_NODE_RUNTIME) {
  const shasums = await (await fetch("https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt")).text();
  const zipName = shasums.match(/node-v[\d.]+-win-x64\.zip/)?.[0];
  if (!zipName) {
    console.error("没从 SHASUMS256.txt 解析出 win-x64 zip 名");
    process.exit(1);
  }
  console.log(`下载便携 node：${zipName}`);
  const buf = Buffer.from(
    await (await fetch(`https://nodejs.org/dist/latest-v22.x/${zipName}`)).arrayBuffer(),
  );
  const nodeZip = path.join(DIST, zipName);
  await fs.writeFile(nodeZip, buf);
  // 只抽 node.exe 一个文件（-j 去目录层级）——跑 server + hooks 都只需要它
  await fs.mkdir(path.join(PKG, "node"), { recursive: true });
  execFileSync("unzip", ["-j", "-o", nodeZip, "*/node.exe", "-d", path.join(PKG, "node")]);
  await fs.rm(nodeZip);
}

// ---------- 5. 打 zip ----------
if (!process.env.SKIP_ZIP) {
  const zipOut = path.join(DIST, "fe-ai-flow-win-x64.zip");
  await fs.rm(zipOut, { force: true });
  // cd 到 pkg/ 打、让 zip 顶层是 fe-ai-flow/（同事手动解压不会散一地）
  execFileSync("zip", ["-qry", zipOut, "fe-ai-flow"], { cwd: path.join(DIST, "pkg") });
  const { size } = await fs.stat(zipOut);
  console.log(`打包完成：${zipOut}（${(size / 1024 / 1024).toFixed(1)} MB）`);
} else {
  console.log(`组包完成（跳过 zip）：${PKG}`);
}
