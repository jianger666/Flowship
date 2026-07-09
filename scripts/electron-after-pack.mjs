/**
 * electron-builder afterPack hook（V0.7.0）
 *
 * 1. 把组好的 server 布局（dist/app-server）拷进安装包 resources/app-server。
 *    为什么不用 extraResources：builder 的 copier 硬排除 node_modules（显式 filter
 *    "**\/node_modules\/**" 也救不回、实测丢）、而 server 的依赖树全在 node_modules 里——
 *    afterPack 阶段自己 fs.cp 全量拷、绕开它的 file matcher。
 *    verbatimSymlinks：本地（pnpm isolated）布局里有相对 symlink、原样保留才能解析；
 *    CI 布局（hoisted）全实体、verbatim 无副作用。
 *
 * 2. mac：补一道完整 ad-hoc 签名（v0.7.10）。
 *    identity:null 是「跳过签名」、产物只剩 linker 级签名（Sealed Resources=none）、
 *    新 macOS + 浏览器下载（quarantine）评估直接「已损坏」死路（用户实测 0.7.9）。
 *    afterPack 时 app-server 已拷入、内容定型、此时 `codesign --force --deep -s -`
 *    整包封印 → Gatekeeper 给「无法验证开发者」、右键打开一次即可。
 *    彻底零确认 / mac 自动更新仍需 Apple 开发者证书、用户暂不买。
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export default async (context) => {
  const src = path.join(process.cwd(), "dist", "app-server");
  // getResourcesDir：mac → <app>.app/Contents/Resources、win → <out>/resources
  const dest = path.join(
    context.packager.getResourcesDir(context.appOutDir),
    "app-server",
  );
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(src, dest, { recursive: true, verbatimSymlinks: true });
  console.log(`  • afterPack：server 布局已拷入 ${dest}`);

  // V0.13.x：飞书 CLI 内置（scripts/fetch-feishu-cli.mjs 预取到 dist/feishu-tools）——
  // 存在才拷（本地没跑预取脚本时跳过、不阻断打包）；运行时首次 boot 从 resources
  // 种子拷贝到 data/tools/（feishu-cli.ts seedFeishuToolsFromResources）
  const toolsSrc = path.join(process.cwd(), "dist", "feishu-tools");
  try {
    await fs.access(toolsSrc);
    const toolsDest = path.join(
      context.packager.getResourcesDir(context.appOutDir),
      "feishu-tools",
    );
    await fs.rm(toolsDest, { recursive: true, force: true });
    await fs.cp(toolsSrc, toolsDest, { recursive: true });
    console.log(`  • afterPack：飞书 CLI 已内置 ${toolsDest}`);
  } catch {
    console.log("  • afterPack：dist/feishu-tools 不存在、跳过内置（运行时在线安装）");
  }

  if (context.electronPlatformName === "darwin") {
    // appOutDir 下找 .app（产物只有一个）
    const appName = (await fs.readdir(context.appOutDir)).find((n) =>
      n.endsWith(".app"),
    );
    if (!appName) throw new Error("afterPack：没找到 .app、无法 ad-hoc 签名");
    const appPath = path.join(context.appOutDir, appName);
    // --deep 已被 Apple 标记弃用、但 ad-hoc 整包签名场景仍是社区标准做法且有效；
    // maxBuffer 调大：deep 签名输出可能较多
    await execFileP(
      "codesign",
      ["--force", "--deep", "--sign", "-", appPath],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    // 签完立即验、失败让 CI 红、不带病发版
    await execFileP("codesign", ["--verify", "--deep", "--strict", appPath]);
    console.log(`  • afterPack：mac ad-hoc 签名完成 ${appName}`);
  }
};
