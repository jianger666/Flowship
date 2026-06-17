/**
 * hooks 注入（V0.6.3 stop、V0.6.27 加 beforeShellExecution）
 *
 * 目的：给 fe 起的 SDK agent 套两道硬约束——
 * 1. **stop hook**：agent 退出前必须交卷（调 wait_for_user）、否则 follow-up 同会话拉回补调。
 *    这是 L1-L4 所有后置 deterministic check 的「触发保证层」。探针实测见 HANDOFF V0.6.3 段。
 * 2. **beforeShellExecution hook（shell-guard）**：每条 shell 命令前问 fe /api/hooks/shell-check、
 *    踩硬禁令（--fix / force push / dev server 等）直接 deny——把 _shared.md 的 prompt
 *    软约束升级成确定性拦截（规则单一源：shell-guard-rules.ts）。
 *
 * 为什么注入到业务仓库：agent cwd = 业务仓库、settingSources:["project"] 只加载 cwd 的
 * .cursor/hooks.json（够不着全局 ~/.cursor/）、所以 fe 的 hook 必须写进业务仓库
 * .cursor/hooks.json。
 *
 * command 形式（V0.6.29 改 `node "<mjs 绝对路径>"`、原来是 .sh 绝对路径）：
 * - 同事 Windows 实测踩坑：.sh 没 shebang 机制、系统按文件关联处理、关联应用是 IDE →
 *   hook 每触发一次 IDE 就「打开」脚本一次、且两道闸在 Windows 从未真正生效
 * - ai-flow 跑在 Node 上、`node` 必在 PATH、跨平台必可执行、顺带去掉 bash/curl 依赖
 *
 * 策略（用户拍板方案 A、V0.6.27 微调、V0.6.29 升级逻辑改全量重写）：
 * - **没 .cursor/hooks.json 就建 fe 的**；有且是 fe 自己建的（command 引用 fe scripts/）
 *   → 跟期望内容比对、不一致就整体重写（旧版 .sh 形式 / 缺 hook 条目都走这条自动升级）；
 *   有且是业务仓库自己的 → 不动（该情况 fe hook 不生效、回退事后兜底）
 * - 建了**留存复用**（不删、下次直接用）+ 加 .git/info/exclude 防 agent 误 commit（仅 cwd 本身
 *   是 git 仓时；多仓公共父目录非 git 仓、文件不归任何仓管、无需 exclude）
 * - 因为 hooks.json 留在 repo、用户用 IDE 打开该 repo 时 IDE agent 也会触发它——但 hook 脚本
 *   fail-open + 向 fe 认领（fe 不认领就放行）、所以不会误伤 IDE agent
 */
import { promises as fs } from "node:fs";
import path from "node:path";

// fe 固定 hook 脚本绝对路径（process.cwd() = fe 项目根、Next.js 运行时）
// V0.6.29：command 包一层 node 调用——路径可能含空格、引号兜住；sh -c / cmd 都认这个写法
// V0.6.30：node 用 process.execPath（跑本服务的那个 node 的绝对路径）、不裸写 `node`——
//   Electron 安装包用户机器上系统 PATH 可能根本没有 node、只有包内 Electron（as node）、
//   execPath 正好指向它；源码跑的场景 execPath = 系统 node、行为不变。
// V0.8.x：command 自己显式带 ELECTRON_RUN_AS_NODE=1，不再依赖触发 hook 的进程继承环境。
//   hooks.json 留在业务仓库里，Cursor IDE agent 也会触发；IDE 进程没有这个 env 时，Windows
//   会把 AI工作流.exe 当 GUI app 拉起，用户看到“stop hook 终端/窗口”。显式前缀后统一静默按
//   Node 脚本执行，fe 不认领的 IDE agent 仍由脚本 fail-open 放行。
const quoteArg = (value: string): string => `"${value.replaceAll('"', '\\"')}"`;
const withElectronNodeEnv = (script: string): string => {
  const command = `${quoteArg(process.execPath)} ${quoteArg(script)}`;
  if (process.platform === "win32") {
    return `set ELECTRON_RUN_AS_NODE=1&& ${command}`;
  }
  return `ELECTRON_RUN_AS_NODE=1 ${command}`;
};

const stopHookCommand = (): string =>
  withElectronNodeEnv(path.join(process.cwd(), "scripts", "stop-hook.mjs"));
const shellGuardCommand = (): string =>
  withElectronNodeEnv(path.join(process.cwd(), "scripts", "shell-guard.mjs"));

// fe scripts 目录路径——判断已有 hooks.json 是不是 fe 自己建的（是才允许升级重写）
// 老形式 command = ".../scripts/xxx.sh"（startsWith）、新形式 = `node ".../scripts/xxx.mjs"`（includes）
// 统一用 includes 兼容两代
const feScriptsDir = (): string => path.join(process.cwd(), "scripts") + path.sep;
const isFeCommand = (cmd: string): boolean => cmd.includes(feScriptsDir());

interface HookEntry {
  command?: string;
  loop_limit?: number;
  [k: string]: unknown;
}
interface HooksJsonShape {
  version?: number;
  hooks?: Record<string, HookEntry[]>;
  [k: string]: unknown;
}

// 业务仓库 hooks.json 全量内容（首次注入 + 升级重写共用、单一期望源）
const buildHooksJson = (): string =>
  `${JSON.stringify(
    {
      version: 1,
      hooks: {
        stop: [{ command: stopHookCommand(), loop_limit: 3 }],
        beforeShellExecution: [{ command: shellGuardCommand() }],
      },
    },
    null,
    2,
  )}\n`;

/**
 * 确保业务仓库 cwd 装了 fe hooks（幂等、失败不抛、只 log）
 *
 * @param cwd agent 的 effective cwd（单仓 = 仓本身、多仓 = 公共父目录）
 */
export const ensureStopHookInstalled = async (cwd: string): Promise<void> => {
  if (!cwd) return;
  try {
    const cursorDir = path.join(cwd, ".cursor");
    const hooksJsonPath = path.join(cursorDir, "hooks.json");

    if (await pathExists(hooksJsonPath)) {
      // 已存在：fe 自己建的 → 增量补缺；业务仓库自己的 → 不动
      await upgradeFeHooksJson(hooksJsonPath);
      return;
    }

    await fs.mkdir(cursorDir, { recursive: true });
    await fs.writeFile(hooksJsonPath, buildHooksJson(), "utf8");
    console.log(`[stop-hook] 已注入 ${hooksJsonPath}`);

    // cwd 本身是 git 仓时、加 .git/info/exclude 防 agent 误 commit
    await addGitExclude(cwd);
  } catch (err) {
    // 注入失败不阻断 agent 启动、只是 hook 不生效、回退事后兜底
    console.error("[stop-hook] 注入失败（忽略、回退事后兜底）", err);
  }
};

/**
 * 旧版 fe hooks.json 升级（V0.6.29 起改「全量重写」、原 V0.6.27 是增量补条目）
 *
 * 只动「fe 自己建的」文件：所有已有 hook command 都引用 fe scripts/ 目录才算
 * （业务仓库自己的 hooks.json 一律不碰、哪怕里面恰好也有 stop）。
 *
 * 全量重写的理由：文件内容完全归 fe 所有（buildHooksJson 是单一期望源）、
 * 跟期望不一致（老 .sh command / 缺条目）直接覆盖、不再逐条 diff 补——
 * Windows .sh → node 迁移、用户拉代码重跑一次任务即自动修复。
 */
const upgradeFeHooksJson = async (hooksJsonPath: string): Promise<void> => {
  try {
    const raw = await fs.readFile(hooksJsonPath, "utf8");
    const parsed = JSON.parse(raw) as HooksJsonShape;
    if (!parsed || typeof parsed !== "object" || !parsed.hooks) return;

    const allEntries = Object.values(parsed.hooks).flat();
    if (allEntries.length === 0) return;
    const allOurs = allEntries.every(
      (e) => typeof e?.command === "string" && isFeCommand(e.command),
    );
    if (!allOurs) return; // 业务仓库自己的 hooks、不动

    const desired = buildHooksJson();
    if (raw === desired) return; // 已是最新

    await fs.writeFile(hooksJsonPath, desired, "utf8");
    console.log(`[stop-hook] 已升级 ${hooksJsonPath}（重写为最新 node hook 形式）`);
  } catch (err) {
    console.error("[stop-hook] 升级已有 hooks.json 失败（忽略）", err);
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
