/**
 * shell 命令策略引擎（V0.6.27、纯函数、零 IO）
 *
 * 背景：_shared.md「shell 安全」段的三类禁令（自动改写文件 / 长驻进程 / 危险 git）
 * 原来是纯 prompt 软约束——agent 漂了照跑不误、真实事故见 _shared.md（某 Angular 仓
 * `npm run lint` = `ng lint --fix=true` 把整仓改花）。本模块把这批禁令升级为
 * beforeShellExecution hook 的硬拦截：业务仓库 hooks.json → scripts/shell-guard.mjs
 * → POST /api/hooks/shell-check → 本引擎判定。
 *
 * 设计原则：
 * - **保守黑名单**——只拦「prompt 已明令禁止 + 误伤面可控」的命令、宁放过不误杀
 *   （误杀会卡住正常 action 流、比放过的代价更大）
 * - **deny 不终结 Run**——hook 返回 deny 后 agent 收到 agent_message、换只读命令重试即可
 * - 规则全部带 reason、deny 时写进 task 事件流（可观测、可审计）
 */

export interface ShellGuardVerdict {
  verdict: "allow" | "deny";
  // deny 时给 agent 的解释（它会换命令重试）
  reason?: string;
}

interface GuardRule {
  // 规则名（事件流 / 测试断言用）
  name: string;
  // 命中 = 拦（对整条命令文本做 test）
  pattern: RegExp;
  // 豁免：命中 pattern 但同时命中 exempt → 放行（如 __conflict 分支允许 force push）
  exempt?: RegExp;
  reason: string;
}

/**
 * 黑名单规则表（与 prompts/_shared.md「shell 安全」段一一对应、改这里记得同步 prompt）
 */
export const SHELL_GUARD_RULES: GuardRule[] = [
  {
    name: "auto-fix",
    // --fix / --fix=true / --write（prettier）——词边界防误伤（如 --fixture）
    pattern: /\s--(fix|write)(=\S*)?(\s|$)/,
    reason:
      "禁跑会自动改写源码的命令（--fix / --write）。改用只读校验：tsc --noEmit / 不带 fix 的 lint。",
  },
  {
    name: "force-push",
    // git push -f / --force / --force-with-lease（含 git -C <path> push 形态）
    pattern: /git(\s+-C\s+\S+)?\s+push\s+(.*\s)?(-f|--force(-with-lease)?)(\s|$)/,
    // 唯一豁免：一次性 __conflict 分支（action-ship.md §3.6 智能解冲突）
    exempt: /__conflict/,
    reason:
      "禁 force push（feature / 测试分支必须保持线性历史）。唯一豁免是 ship 智能解冲突的 __conflict 一次性分支。",
  },
  {
    name: "git-reset-hard",
    pattern: /git(\s+-C\s+\S+)?\s+reset\s+(.*\s)?--hard(\s|$)/,
    reason:
      "禁 git reset --hard（会丢弃工作区 / 本地提交、破坏 build 增量）。",
  },
  {
    name: "git-rebase",
    pattern: /git(\s+-C\s+\S+)?\s+rebase(\s|$)/,
    reason:
      "禁 git rebase（工作流铁律：feature 分支保持干净、不许 rebase 测试分支进来；解冲突走 ship 的 __conflict 流程）。",
  },
  {
    name: "git-clean",
    pattern: /git(\s+-C\s+\S+)?\s+clean\s+(.*\s)?-[a-zA-Z]*f/,
    reason: "禁 git clean -f（会永久删除未跟踪文件、不可恢复）。",
  },
  {
    name: "dev-server",
    // pnpm/npm/yarn/bun dev|start|serve（含 run dev 形态）——长驻进程会挂死 Run + 留孤儿
    pattern: /\b(pnpm|npm|yarn|bun)\s+(run\s+)?(dev|start|serve)(\s|$)/,
    reason:
      "禁起 dev server / 长驻进程（不返回、挂死 Run、留孤儿进程）。要验证用一次性命令。",
  },
  {
    name: "watch-mode",
    pattern: /\s--watch(=\S*)?(\s|$)|\btail\s+-[a-zA-Z]*f/,
    reason: "禁 --watch / tail -f 等不退出的命令（挂死 Run）。",
  },
  {
    name: "global-install",
    pattern: /\b(npm|pnpm|yarn)\s+(install|add|i)\s+(.*\s)?(-g|--global)(\s|$)/,
    reason: "禁全局安装依赖（污染用户机器环境、task 范围外操作）。",
  },
];

/**
 * 判定一条 shell 命令是否放行
 *
 * 注意输入是 agent 提交的整条命令文本（可能含 && / ; / 换行串多条）、
 * 规则按子串匹配整段——串联命令里任意一段踩线即拦（保守正确）。
 */
export const evaluateShellCommand = (command: string): ShellGuardVerdict => {
  const cmd = command.trim();
  if (!cmd) return { verdict: "allow" };

  for (const rule of SHELL_GUARD_RULES) {
    if (rule.pattern.test(cmd)) {
      if (rule.exempt && rule.exempt.test(cmd)) continue;
      return {
        verdict: "deny",
        reason: `[shell-guard:${rule.name}] ${rule.reason}`,
      };
    }
  }
  return { verdict: "allow" };
};
