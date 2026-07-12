/**
 * 组「可运行的 server 布局」公共函数（V0.7.0 抽出、给 Electron 发版链复用）
 *
 * 产出布局（destDir/）：
 *   server.js + .next/ + node_modules/   ← Next standalone 自包含产物（纯 JS、跨平台）
 *   prompts/ + skills/ + scripts/        ← 运行时按 process.cwd() 读、必须随包
 *
 * 为什么 standalone 能直接当布局根：server.js 启动时 process.chdir(__dirname)、
 * 所以 prompts/scripts 平铺在 server.js 旁、运行时 process.cwd() 全部命中。
 *
 * 消费方：
 * - Electron：scripts/assemble-electron-server.mjs（产物走 extraResources 进安装包）
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const exists = async (p) => fs.access(p).then(() => true, () => false);

// verbatimSymlinks: true——standalone 的 node_modules 是 pnpm symlink 拓扑
// （顶层 next -> .pnpm/.../next、require 靠 .pnpm 内兄弟链接解析）、必须原样保留：
// - fs.cp 默认（verbatim:false）会把相对链接改写成「构建机绝对路径」死链
// - dereference:true 物化又会破坏 pnpm 兄弟解析（next 副本找不到 styled-jsx、踩过）
// Windows 产物的 symlink 兼容问题在 CI 侧解决：build job 用 node-linker=hoisted
// 装依赖、standalone 直接产实体平铺、根本没有 symlink（见 release.yml）
const cp = async (src, dest) => {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(src, dest, { recursive: true, verbatimSymlinks: true });
};

// 补 SDK 平台二进制包（nft 追不到、必须显式补）
// @cursor/sdk 运行时按 `@cursor/sdk-${platform}-${arch}` 动态拼名 require 平台包
// （含 Connect RPC native / ripgrep / 沙箱 helper）、Next file-tracing 静态分析追不到、
// 不进 standalone node_modules → 缺包时 SDK 连 API key exchange 直接 fetch failed
// （本地 electron:dist:test 打的包踩过、chat 全 status=error）。
// CI 在目标平台 job 用 npm install 补（release.yml）；本地打包走这里补「当前平台」包。
// 仅处理 pnpm symlink 拓扑（本地 isolated）；hoisted 平铺（CI ubuntu build）无 .pnpm、
// 跳过交 CI 补——对 CI 零影响。
const addSdkPlatformPackage = async (rootDir, destDir) => {
  const destPnpm = path.join(destDir, "node_modules", ".pnpm");
  if (!(await exists(destPnpm))) return; // hoisted 布局（CI）、交 CI npm install 补

  const platformPkg = `sdk-${process.platform}-${process.arch}`; // 如 sdk-darwin-arm64
  // 版本从已进包的 @cursor/sdk 主包读（平台包跟主包钉死同版本）
  let version;
  try {
    const raw = await fs.readFile(
      path.join(rootDir, "node_modules", "@cursor", "sdk", "package.json"),
      "utf8",
    );
    version = JSON.parse(raw).version;
  } catch {
    console.warn("[assemble] 读不到 @cursor/sdk 版本、跳过补平台包");
    return;
  }

  const srcEntity = path.join(
    rootDir,
    "node_modules",
    ".pnpm",
    `@cursor+${platformPkg}@${version}`,
  );
  if (!(await exists(srcEntity))) {
    console.warn(
      `[assemble] 本机缺 @cursor/${platformPkg}@${version}、跳过补包` +
        "（运行时 SDK 会 fetch failed、需 pnpm install 装上当前平台 SDK）",
    );
    return;
  }

  // 1. 拷平台包实体进 .pnpm
  await cp(srcEntity, path.join(destPnpm, `@cursor+${platformPkg}@${version}`));
  // 2. 在 @cursor/sdk 包的 node_modules/@cursor 下建 symlink 指向实体（复刻 pnpm 拓扑）
  const linkDir = path.join(
    destPnpm,
    `@cursor+sdk@${version}`,
    "node_modules",
    "@cursor",
  );
  if (await exists(linkDir)) {
    const linkPath = path.join(linkDir, platformPkg);
    await fs.rm(linkPath, { force: true, recursive: true }).catch(() => {});
    await fs.symlink(
      path.join(
        "..",
        "..",
        "..",
        `@cursor+${platformPkg}@${version}`,
        "node_modules",
        "@cursor",
        platformPkg,
      ),
      linkPath,
    );
  }
  console.log(`[assemble] 已补 SDK 平台包 @cursor/${platformPkg}@${version}`);
};

// 递归删指定扩展名文件（sourcemap 瘦身用）
const removeFilesByExt = async (dir, ext) => {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await removeFilesByExt(p, ext);
    else if (e.isFile() && e.name.endsWith(ext)) {
      await fs.rm(p, { force: true }).catch(() => {});
    }
  }
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

  // 瘦身：sourcemap 生产运行时用不到（报错栈不映射也够定位）、随包纯死重
  await removeFilesByExt(destDir, ".map");

  // ---------- 2. 运行时按 cwd 读的目录（tracing 对动态 fs 读不保证、显式拷一遍兜底） ----------
  await cp(path.join(rootDir, "prompts"), path.join(destDir, "prompts"));
  await cp(path.join(rootDir, "skills"), path.join(destDir, "skills"));

  // ---------- 3. SDK 平台二进制包（standalone trace 漏的 optional 平台包）----------
  await addSdkPlatformPackage(rootDir, destDir);
};
