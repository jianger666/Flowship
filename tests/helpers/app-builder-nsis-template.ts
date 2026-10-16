/**
 * 定位 electron-builder 自带的官方 NSIS 模板目录（app-builder-lib/templates/nsis）。
 * 不写死 `.pnpm` 目录布局：从 electron-builder 的包位置出发 `require.resolve`，
 * pnpm 嵌套 / npm hoisted / yarn 布局都能找到。
 *
 * 找不到时：CI（环境变量 CI 非空）直接 throw——「对账官方模板」的断言在 CI 里不允许静默失效；
 * 本地返回 null 并 console.warn 原因，调用方用 `it.skipIf(!dir)` 显式跳过（报告里能看见 skipped）。
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");

export function locateAppBuilderNsisTemplateDir(): { dir: string | null; reason: string } {
  const rootRequire = createRequire(path.join(root, "package.json"));
  const candidates: Array<() => string> = [
    // hoisted 布局：根上直接可解析
    () => rootRequire.resolve("app-builder-lib/package.json"),
    // pnpm 布局：app-builder-lib 是 electron-builder 的依赖、根上解析不到，经 electron-builder 转一跳
    () =>
      createRequire(rootRequire.resolve("electron-builder/package.json")).resolve(
        "app-builder-lib/package.json",
      ),
  ];
  const errors: string[] = [];
  for (const resolvePkg of candidates) {
    try {
      const dir = path.join(path.dirname(resolvePkg()), "templates", "nsis");
      if (existsSync(dir)) return { dir, reason: "" };
      errors.push(`解析到 app-builder-lib 但缺 ${dir}`);
    } catch (err) {
      errors.push(err instanceof Error ? err.message.split("\n")[0]! : String(err));
    }
  }
  return {
    dir: null,
    reason: `找不到 electron-builder 官方 NSIS 模板目录（app-builder-lib/templates/nsis）：${errors.join(" | ")}`,
  };
}

/** CI 找不到就 throw；本地返回 null 并打印原因（调用方 `it.skipIf(!dir)`）。 */
export function findAppBuilderTemplateDir(): string | null {
  const { dir, reason } = locateAppBuilderNsisTemplateDir();
  if (dir) return dir;
  if (process.env.CI) {
    throw new Error(`${reason}（CI 环境不允许跳过官方模板对账）`);
  }
  console.warn(`[skip] ${reason}；依赖官方模板的对账用例将被跳过（本地）`);
  return null;
}
