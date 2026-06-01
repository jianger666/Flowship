/**
 * stop hook 注入（V0.6.3）
 *
 * 目的：给 fe 起的 SDK agent 套一道「退出前必须交卷（调 wait_for_user）」的硬约束——agent 想结束
 * Run 时 Cursor 触发 stop hook、fe 检查 action 没交卷就 follow-up 把它同会话拉回补调。这是 L1-L4
 * 所有后置 deterministic check 的「触发保证层」（检查全挂在 wait_for_user→runActionCheck 上、
 * agent 不交卷整条检查链落空）。探针实测见 docs/HANDOFF.md V0.6.3 段。
 *
 * 为什么注入到业务仓库：agent cwd = 业务仓库、settingSources:["project"] 只加载 cwd 的
 * .cursor/hooks.json（够不着全局 ~/.cursor/）、所以 fe 的 stop hook 必须写进业务仓库
 * .cursor/hooks.json（command 指向 fe 固定脚本绝对路径）。
 *
 * 策略（用户拍板方案 A）：
 * - **没 .cursor/hooks.json 就建 fe 的、有就不注入**——尊重业务仓库已有的（那种情况 stop hook
 *   不生效、回退「Run 结束发现没 ack 标 error」事后兜底）
 * - 建了**留存复用**（不删、下次直接用）+ 加 .git/info/exclude 防 agent 误 commit（仅 cwd 本身
 *   是 git 仓时；多仓公共父目录非 git 仓、文件不归任何仓管、无需 exclude）
 * - 因为 hooks.json 留在 repo、用户用 IDE 打开该 repo 时 IDE agent 也会触发它——但 hook 脚本
 *   fail-open + 向 fe 认领（fe 不认领就放行）、所以不会误伤 IDE agent
 */
import { promises as fs } from "node:fs";
import path from "node:path";

// fe 固定 stop hook 脚本绝对路径（process.cwd() = fe 项目根、Next.js 运行时）
const stopHookScriptPath = (): string =>
  path.join(process.cwd(), "scripts", "stop-hook.sh");

// 业务仓库 hooks.json 内容（command 指向 fe 脚本绝对路径、loop_limit 防死循环）
const buildHooksJson = (): string =>
  `${JSON.stringify(
    {
      version: 1,
      hooks: {
        stop: [{ command: stopHookScriptPath(), loop_limit: 3 }],
      },
    },
    null,
    2,
  )}\n`;

/**
 * 确保业务仓库 cwd 装了 fe stop hook（幂等、失败不抛、只 log）
 *
 * @param cwd agent 的 effective cwd（单仓 = 仓本身、多仓 = 公共父目录）
 */
export const ensureStopHookInstalled = async (cwd: string): Promise<void> => {
  if (!cwd) return;
  try {
    const cursorDir = path.join(cwd, ".cursor");
    const hooksJsonPath = path.join(cursorDir, "hooks.json");

    // 有就不注入（尊重业务仓库已有 hooks、或 fe 上次建的复用）
    if (await pathExists(hooksJsonPath)) return;

    await fs.mkdir(cursorDir, { recursive: true });
    await fs.writeFile(hooksJsonPath, buildHooksJson(), "utf8");
    console.log(`[stop-hook] 已注入 ${hooksJsonPath}`);

    // cwd 本身是 git 仓时、加 .git/info/exclude 防 agent 误 commit
    await addGitExclude(cwd);
  } catch (err) {
    // 注入失败不阻断 agent 启动、只是 stop hook 不生效、回退事后兜底
    console.error("[stop-hook] 注入失败（忽略、回退事后兜底）", err);
  }
};

const pathExists = async (p: string): Promise<boolean> => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * 把 `.cursor/hooks.json` 加进 cwd/.git/info/exclude（仅 cwd 本身是 git 仓时）
 *
 * 多仓公共父目录不是 git 仓、文件不归任何仓管、无需 exclude、直接跳过。
 */
const addGitExclude = async (cwd: string): Promise<void> => {
  const gitDir = path.join(cwd, ".git");
  // .git 必须是目录（worktree 的 .git 是文件、保守跳过）
  try {
    const stat = await fs.stat(gitDir);
    if (!stat.isDirectory()) return;
  } catch {
    return; // 没 .git（多仓公共父目录）、跳过
  }

  const gitInfoDir = path.join(gitDir, "info");
  const excludePath = path.join(gitInfoDir, "exclude");
  const entry = ".cursor/hooks.json";
  try {
    let content = "";
    if (await pathExists(excludePath)) {
      content = await fs.readFile(excludePath, "utf8");
    }
    // 已有该条目就不重复写
    if (content.split("\n").some((line) => line.trim() === entry)) return;

    const needsLeadingNl = content.length > 0 && !content.endsWith("\n");
    const next = `${content}${needsLeadingNl ? "\n" : ""}${entry}\n`;
    await fs.mkdir(gitInfoDir, { recursive: true });
    await fs.writeFile(excludePath, next, "utf8");
  } catch (err) {
    console.error("[stop-hook] 写 .git/info/exclude 失败（忽略）", err);
  }
};
