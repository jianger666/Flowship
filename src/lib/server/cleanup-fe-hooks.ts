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
 *
 * 判定改「内容指纹」（不再锚定当前进程 scripts 绝对路径）——app 改名 / 换路径 /
 * test 与正式互装后，旧 hooks.json 仍指向已删脚本、Cursor IDE 开仓会每次报错。
 * 指纹：command 含 `scripts/stop-hook.(mjs|sh)` 或 `scripts/shell-guard.(mjs|sh)`；
 * mjs 代还要求带 `ELECTRON_RUN_AS_NODE`（V0.8+ 注入模板稳定特征）；sh 旧代无该 env。
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

/**
 * 内容指纹：是否 fe 注入的 hook command（与当前 process.cwd() 无关）。
 * 覆盖：mjs + ELECTRON_RUN_AS_NODE（V0.8+）、以及更早的 .sh 绝对路径形态。
 */
const isFeCommand = (cmd: string): boolean => {
  const isFeScript =
    /scripts[/\\](?:stop-hook|shell-guard)\.(?:mjs|sh)/.test(cmd);
  if (!isFeScript) return false;
  // mjs 代注入模板固定带 ELECTRON_RUN_AS_NODE；缺这个更像误伤同名脚本
  if (/\.mjs(?:\s|"|$)/.test(cmd) || cmd.includes(".mjs")) {
    return cmd.includes("ELECTRON_RUN_AS_NODE");
  }
  // .sh 旧代：无 ELECTRON_RUN_AS_NODE、脚本名本身即指纹
  return true;
};

/**
 * 若 cwd 下 `.cursor/hooks.json` 含 fe 注入条目 → 清理（幂等、失败只 log）
 *
 * - 全部是 fe 的 → 删整文件
 * - 混合（业务仓自有 + fe）→ 只删 fe 条目、写回剩余（保守：不动别人的 hook）
 * - 全是业务仓自己的 → 不动
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

    const hooks = parsed.hooks;
    let removed = 0;
    let remaining = 0;
    for (const [name, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue;
      const kept: HookEntry[] = [];
      for (const e of entries) {
        if (typeof e?.command === "string" && isFeCommand(e.command)) {
          removed += 1;
        } else {
          kept.push(e);
          remaining += 1;
        }
      }
      if (kept.length === 0) {
        delete hooks[name];
      } else {
        hooks[name] = kept;
      }
    }
    if (removed === 0) return;

    if (remaining === 0) {
      // 全是 fe 的 → 删整文件
      await fs.unlink(hooksJsonPath);
      console.log(`[cleanup-fe-hooks] 已删除 fe 旧 hooks.json：${hooksJsonPath}`);
      return;
    }

    // 混合：只写回非 fe 条目
    await fs.writeFile(
      hooksJsonPath,
      `${JSON.stringify(parsed, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `[cleanup-fe-hooks] 已从 hooks.json 移除 ${removed} 条 fe 条目：${hooksJsonPath}`,
    );
  } catch (err) {
    // 文件不存在 / 解析失败 / 删失败都不阻断启动
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    console.error("[cleanup-fe-hooks] 清理失败（忽略）", err);
  }
};
