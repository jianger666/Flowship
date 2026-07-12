/**
 * 存量 fe hooks.json 清理（settingSources:[] 后 hooks 链路整体退役）
 *
 * 历史：task 启动时 `ensureStopHookInstalled` 会往业务仓写 `.cursor/hooks.json`
 * （stop + beforeShellExecution），command 指向 fe 的 `scripts/stop-hook.mjs` /
 * `shell-guard.mjs`。现已改用 `agent.send` 追问交卷、不再注入 hooks。
 *
 * 本模块只做一次性清理：发现是 fe 自己建的旧 hooks.json → 删掉；
 * 仓库自己的 hooks.json（command 不引用 fe scripts/）一律不碰。
 * `.git/info/exclude` 里当初加的 `.cursor/hooks.json` 条目可留、无害。
 */
import { promises as fs } from "node:fs";
import path from "node:path";

interface HookEntry {
  command?: string;
  [k: string]: unknown;
}
interface HooksJsonShape {
  hooks?: Record<string, HookEntry[]>;
  [k: string]: unknown;
}

// fe scripts 目录路径——判断 hooks.json 是不是 fe 自己建的
// 老形式 command = ".../scripts/xxx.sh"（startsWith）、新形式含 `.../scripts/xxx.mjs`
// 统一用 includes 兼容两代
const feScriptsDir = (): string => path.join(process.cwd(), "scripts") + path.sep;
const isFeCommand = (cmd: string): boolean => cmd.includes(feScriptsDir());

/**
 * 若 cwd 下 `.cursor/hooks.json` 是 fe 注入的 → 删掉（幂等、失败只 log）
 *
 * @param cwd agent 的 effective cwd（单仓 = 仓本身、多仓 = 公共父目录 / worktree）
 */
export const cleanupFeHooksJson = async (cwd: string): Promise<void> => {
  if (!cwd) return;
  const hooksJsonPath = path.join(cwd, ".cursor", "hooks.json");
  try {
    const raw = await fs.readFile(hooksJsonPath, "utf8");
    const parsed = JSON.parse(raw) as HooksJsonShape;
    if (!parsed || typeof parsed !== "object" || !parsed.hooks) return;

    const allEntries = Object.values(parsed.hooks).flat();
    if (allEntries.length === 0) return;
    // 所有 hook command 都引用 fe scripts/ 才算 fe 自建；业务仓自己的不动
    const allOurs = allEntries.every(
      (e) => typeof e?.command === "string" && isFeCommand(e.command),
    );
    if (!allOurs) return;

    await fs.unlink(hooksJsonPath);
    console.log(`[cleanup-fe-hooks] 已删除 fe 旧 hooks.json：${hooksJsonPath}`);
  } catch (err) {
    // 文件不存在 / 解析失败 / 删失败都不阻断启动
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    console.error("[cleanup-fe-hooks] 清理失败（忽略）", err);
  }
};
