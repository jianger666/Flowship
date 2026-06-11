#!/usr/bin/env node
/**
 * 绿色包组包脚本（V0.6.30、V0.6.31 加 mac）——给零 node 环境的同事产出「解压即用」包
 *
 * 前置：`BUILD_STANDALONE=1 pnpm build`（next.config 里 env 开 standalone 输出）
 *
 * 产物（dist/fe-ai-flow-<platform>.zip、顶层带 fe-ai-flow/ 目录）：
 *   fe-ai-flow/
 *     server.js + .next/ + node_modules/   ← Next standalone 自包含产物（纯 JS、跨平台通用）
 *     prompts/ + skills/ + scripts/        ← 运行时按 process.cwd() 读、必须随包
 *     node/node(.exe)                      ← 官方便携 node（latest v22.x、按平台分）
 *     launcher（win：bat+vbs+ps1 / mac：.command）+ VERSION
 *
 * 用法：
 *   RELEASE_TAG=v0.6.31 node scripts/package-release.mjs win-x64 darwin-arm64 darwin-x64
 *   SKIP_NODE_RUNTIME=1 SKIP_ZIP=1 node scripts/package-release.mjs darwin-arm64   # 本地验证布局
 *
 * 为什么 standalone 能直接当包根：Next standalone 的 server.js 启动时
 * process.chdir(__dirname)、所以把 prompts/scripts 平铺在 server.js 旁、
 * 运行时 process.cwd() 全部命中——data/ 也会落在包根、更新时被 launcher 排除保留。
 */

import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { assembleServerLayout } from "./lib/assemble-server.mjs";

const ROOT = process.cwd();
const DIST = path.join(ROOT, "dist");
const TAG = process.env.RELEASE_TAG || "v0.0.0-dev";

const SUPPORTED = ["win-x64", "darwin-arm64", "darwin-x64"];
const platforms = process.argv.slice(2).filter(Boolean);
if (platforms.length === 0) platforms.push("win-x64");
for (const p of platforms) {
  if (!SUPPORTED.includes(p)) {
    console.error(`不支持的平台：${p}（可选：${SUPPORTED.join(" / ")}）`);
    process.exit(1);
  }
}

const exists = async (p) => fs.access(p).then(() => true, () => false);

const cp = async (src, dest) => {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(src, dest, { recursive: true });
};

const standaloneDir = path.join(ROOT, ".next", "standalone");
if (!(await exists(standaloneDir))) {
  console.error("缺 .next/standalone——先跑 BUILD_STANDALONE=1 pnpm build");
  process.exit(1);
}

// node 版本动态取 latest v22.x（一次解析、多平台复用）
let nodeVersion = null;
const resolveNodeVersion = async () => {
  if (nodeVersion) return nodeVersion;
  const shasums = await (await fetch("https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt")).text();
  nodeVersion = shasums.match(/node-(v[\d.]+)-win-x64\.zip/)?.[1];
  if (!nodeVersion) throw new Error("没从 SHASUMS256.txt 解析出 node 版本号");
  return nodeVersion;
};

// 下载并抽出对应平台的 node 可执行文件到 pkg/node/
const fetchNodeRuntime = async (platform, pkg) => {
  const ver = await resolveNodeVersion();
  await fs.mkdir(path.join(pkg, "node"), { recursive: true });
  if (platform === "win-x64") {
    const name = `node-${ver}-win-x64.zip`;
    console.log(`下载便携 node：${name}`);
    const buf = Buffer.from(
      await (await fetch(`https://nodejs.org/dist/${ver}/${name}`)).arrayBuffer(),
    );
    const zipPath = path.join(DIST, name);
    await fs.writeFile(zipPath, buf);
    // 只抽 node.exe 一个文件（-j 去目录层级）——跑 server + hooks 都只需要它
    execFileSync("unzip", ["-j", "-o", zipPath, "*/node.exe", "-d", path.join(pkg, "node")]);
    await fs.rm(zipPath);
  } else {
    const name = `node-${ver}-${platform}.tar.gz`;
    console.log(`下载便携 node：${name}`);
    const buf = Buffer.from(
      await (await fetch(`https://nodejs.org/dist/${ver}/${name}`)).arrayBuffer(),
    );
    const tarPath = path.join(DIST, name);
    await fs.writeFile(tarPath, buf);
    // 只抽 bin/node 一个文件、--strip-components 去前缀目录
    execFileSync("tar", [
      "-xzf", tarPath,
      "-C", path.join(pkg, "node"),
      "--strip-components", "2",
      `node-${ver}-${platform}/bin/node`,
    ]);
    await fs.chmod(path.join(pkg, "node", "node"), 0o755);
    await fs.rm(tarPath);
  }
};

for (const platform of platforms) {
  const PKG = path.join(DIST, "pkg", platform, "fe-ai-flow");
  console.log(`\n=== 组包 ${platform} ===`);

  // ---------- 1~2. server 布局（standalone + prompts/skills/scripts、删 data/） ----------
  // V0.7.0 抽到 lib/assemble-server.mjs、跟 Electron extraResources 组包共用
  await fs.rm(path.join(DIST, "pkg", platform), { recursive: true, force: true });
  await assembleServerLayout(ROOT, PKG);

  // ---------- 3. launcher（按平台分） ----------
  if (platform === "win-x64") {
    await cp(path.join(ROOT, "packaging", "launch.ps1"), path.join(PKG, "launcher", "launch.ps1"));
    await cp(path.join(ROOT, "packaging", "launch.vbs"), path.join(PKG, "launcher", "launch.vbs"));
    await cp(path.join(ROOT, "packaging", "start.bat"), path.join(PKG, "启动fe-ai-flow.bat"));
  } else {
    const cmdPath = path.join(PKG, "启动fe-ai-flow.command");
    await cp(path.join(ROOT, "packaging", "launch-mac.command"), cmdPath);
    await fs.chmod(cmdPath, 0o755);
  }
  await fs.writeFile(path.join(PKG, "VERSION"), `${TAG}\n`, "utf8");

  // ---------- 4. 便携 node ----------
  if (!process.env.SKIP_NODE_RUNTIME) {
    await fetchNodeRuntime(platform, PKG);
  }

  // ---------- 5. 打 zip ----------
  if (!process.env.SKIP_ZIP) {
    const zipOut = path.join(DIST, `fe-ai-flow-${platform}.zip`);
    await fs.rm(zipOut, { force: true });
    // cd 到 pkg/<platform>/ 打、让 zip 顶层是 fe-ai-flow/（同事手动解压不会散一地）
    // -y 保留软链、-r 递归；mac 包里 node 可执行权限由 zip 保留
    execFileSync("zip", ["-qry", zipOut, "fe-ai-flow"], {
      cwd: path.join(DIST, "pkg", platform),
    });
    const { size } = await fs.stat(zipOut);
    console.log(`打包完成：${zipOut}（${(size / 1024 / 1024).toFixed(1)} MB）`);
  } else {
    console.log(`组包完成（跳过 zip）：${PKG}`);
  }
}
