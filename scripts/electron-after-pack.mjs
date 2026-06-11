/**
 * electron-builder afterPack hook（V0.7.0）
 *
 * 把组好的 server 布局（dist/app-server）拷进安装包 resources/app-server。
 *
 * 为什么不用 extraResources：builder 的 copier 硬排除 node_modules（显式 filter
 * "**\/node_modules\/**" 也救不回、实测丢）、而 server 的依赖树全在 node_modules 里——
 * afterPack 阶段自己 fs.cp 全量拷、绕开它的 file matcher。
 * verbatimSymlinks：本地（pnpm isolated）布局里有相对 symlink、原样保留才能解析；
 * CI 布局（hoisted）全实体、verbatim 无副作用。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

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
};
