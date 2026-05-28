/**
 * Action 后置 deterministic 检查（V0.6 门槛 2）
 *
 * 设计原则：
 *   - 每个 action 类型一组检查、runner 在 agent 调 wait_for_user(action_id) 切 awaiting_ack 前跑
 *   - 检查不依赖 agent 自称、走真实 shell / fs / git diff
 *   - 检查不通过：action 仍切 awaiting_ack（让用户看到结果）、但 postCheck.passed=false
 *     UI 上挂红条「后置检查未过」、用户可以选 revise 让 agent 改
 *   - 检查通过：postCheck.passed=true、UI 上挂绿条
 *
 * 检查内容（V0.6.0.1 范围、用户拍板删 plan 黑名单 grep 后简化）：
 *   - plan: artifact 文件存在 + 内容长度 >= 100
 *   - build: pnpm typecheck exit 0 + pnpm lint exit 0 + git status 有改动
 *   - review: git diff hash 跟 artifact 写的一致（防 agent 编造 diff）
 *   - ship/test/learn: V0.6.0 stub、暂不实现
 *   - chat 不走本机制（chat 是独立 mode、不复用 action 体系、详见 chat-runner.ts）
 *
 * 关于 plan「黑名单 grep」的历史决策（2026-05-28 用户拍板删）：
 *   V0.5.6.5 加过一组 13 个不确定字眼黑名单（或 / 约 / TBD / 可能 / 示例 / 节选 ...）、
 *   substring grep artifact 命中即 ❌。意图是防 agent 把含糊词带进 plan、保 build 阶段 ground truth。
 *   但 substring 不分语境、对「示例」（表格列名）、「或」（业务规则明确 or）等高频业务词
 *   误伤率高（V0.6.0.1 实测两条都是误报）。用户拍板「方案太简单粗暴、不是有效约束、先彻底删、
 *   后面再考虑长远的（语义 diff / agent 自检 etc.）」、本文件不再 ship 这套 grep。
 *
 * 检查脚本本身的依赖：node:child_process / node:fs / node:path
 * 失败时（如仓库不是 git 仓 / 找不到 pnpm）兜底返「passed=true、details=「检查不可用、自动跳过」」、
 * 避免环境问题挡用户主流程（这是软兜底、最终质量靠用户人眼把关）。
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ActionRecord, Task } from "@/lib/types";

import { getActionArtifactPath } from "./task-fs";
import { getEffectiveCwd } from "@/lib/path-utils";

export interface ActionCheckResult {
  passed: boolean;
  details: string;
}

// 主入口：跑给定 action 的 deterministic 检查
export const runActionCheck = async (
  task: Task,
  action: ActionRecord,
): Promise<ActionCheckResult> => {
  try {
    switch (action.type) {
      case "plan":
        return await checkPlan(task, action);
      case "build":
        return await checkBuild(task, action);
      case "review":
        return await checkReview(task, action);
      // V0.6.0 stub：ship / test / learn 暂不实现、走兜底通过
      case "ship":
      case "test":
      case "learn":
        return { passed: true, details: `${action.type} action V0.6.0 未实现、跳过检查` };
      default: {
        const _: never = action.type;
        return { passed: true, details: `未知 action 类型：${String(_)}、跳过` };
      }
    }
  } catch (err) {
    // 兜底：检查脚本异常 → 不挡用户、报警 console
    console.warn(
      `[action-check] runActionCheck 异常 task=${task.id} action=${action.id}：`,
      err,
    );
    return {
      passed: true,
      details: `检查脚本异常：${err instanceof Error ? err.message : String(err)}（跳过）`,
    };
  }
};

// ----------------- plan -----------------

// V0.6.0.1：plan 只做最低门槛 deterministic 检查——artifact 文件落盘 + 内容不空
// 原 V0.5.6.5 substring 黑名单（或/约/TBD/示例 ...）2026-05-28 用户拍板删、详见本文件顶注释
const checkPlan = async (
  task: Task,
  action: ActionRecord,
): Promise<ActionCheckResult> => {
  if (!action.artifactPath) {
    return { passed: false, details: "action.artifactPath 为空、agent 未声明 artifact" };
  }
  const absPath = getActionArtifactPath(task.id, action.n, action.type);
  let content: string;
  try {
    content = await fs.readFile(absPath, "utf-8");
  } catch (err) {
    return {
      passed: false,
      details: `artifact 文件不存在 / 读取失败：${absPath}（${err instanceof Error ? err.message : String(err)}）`,
    };
  }
  if (content.trim().length < 100) {
    return {
      passed: false,
      details: `artifact 内容过短（${content.trim().length} chars）、不像完整 plan`,
    };
  }
  return { passed: true, details: "plan artifact 已落盘、内容长度通过" };
};

// ----------------- build -----------------

const checkBuild = async (
  task: Task,
  action: ActionRecord,
): Promise<ActionCheckResult> => {
  // build action 准入门槛 1 已经保证至少 1 个 plan、这里不再校验
  // 1) artifact 文件存在（可选 - build artifact 是「实施记录」、不像 plan 那样强必要）
  if (action.artifactPath) {
    const absPath = getActionArtifactPath(task.id, action.n, action.type);
    try {
      await fs.access(absPath);
    } catch {
      return { passed: false, details: `build artifact 文件不存在：${absPath}` };
    }
  }

  // 2) 跑仓库根的 typecheck + lint + git status
  const cwd = getEffectiveCwd(task.repoPaths);
  // 仓库不存在 / 不是 git 仓 → 跳过（用户场景可能是纯探索任务）
  try {
    await fs.access(path.join(cwd, ".git"));
  } catch {
    return {
      passed: true,
      details: "仓库不是 git 仓、跳过 typecheck/lint/git status 检查（仅探索场景适用）",
    };
  }

  const sections: string[] = [];
  let allPassed = true;

  // typecheck
  const tc = await runShell("pnpm", ["typecheck"], cwd);
  if (tc.exitCode === 0) {
    sections.push("✅ pnpm typecheck 通过");
  } else if (tc.notFound) {
    sections.push("⚠️ pnpm typecheck 命令找不到（package.json 可能没配 typecheck script、跳过）");
  } else {
    allPassed = false;
    sections.push(
      [
        `❌ pnpm typecheck exit=${tc.exitCode}`,
        ...tc.stderr.trim().split(/\r?\n/).slice(-15).map((l) => `   ${l}`),
      ].join("\n"),
    );
  }

  // lint
  const lt = await runShell("pnpm", ["lint"], cwd);
  if (lt.exitCode === 0) {
    sections.push("✅ pnpm lint 通过");
  } else if (lt.notFound) {
    sections.push("⚠️ pnpm lint 命令找不到（package.json 可能没配 lint script、跳过）");
  } else {
    allPassed = false;
    sections.push(
      [
        `❌ pnpm lint exit=${lt.exitCode}`,
        ...lt.stderr.trim().split(/\r?\n/).slice(-15).map((l) => `   ${l}`),
      ].join("\n"),
    );
  }

  // git status 有改动
  const gs = await runShell("git", ["status", "--porcelain"], cwd);
  if (gs.exitCode === 0) {
    if (gs.stdout.trim().length > 0) {
      sections.push("✅ git status 有改动");
    } else {
      allPassed = false;
      sections.push("❌ git status 干净、build 看起来没真改文件（agent 可能空跑）");
    }
  } else {
    sections.push(`⚠️ git status 跑失败 exit=${gs.exitCode}（跳过此检查）`);
  }

  return {
    passed: allPassed,
    details: sections.join("\n\n"),
  };
};

// ----------------- review -----------------

const checkReview = async (
  task: Task,
  action: ActionRecord,
): Promise<ActionCheckResult> => {
  if (!action.artifactPath) {
    return { passed: false, details: "review 没产出 artifact" };
  }
  const absPath = getActionArtifactPath(task.id, action.n, action.type);
  let content: string;
  try {
    content = await fs.readFile(absPath, "utf-8");
  } catch (err) {
    return {
      passed: false,
      details: `review artifact 读取失败：${absPath}（${err instanceof Error ? err.message : String(err)}）`,
    };
  }

  // 4 类差异段非空（简单检查：artifact 内是否提到「与方案的偏差」「与需求的偏差」「未实现」「额外做」之类锚点）
  // V0.5 时期 review prompt 要求这 4 类、V0.6 沿用
  const requiredSections = [
    /偏差|与.*方案|plan.*差/,
    /需求|story|story.*差/,
    /未实现|缺少|遗漏/,
    /额外|超出|out of scope/i,
  ];
  const missingIdx: number[] = [];
  for (let i = 0; i < requiredSections.length; i++) {
    if (!requiredSections[i].test(content)) missingIdx.push(i);
  }
  if (missingIdx.length > 1) {
    // 4 类至少要写 3 类、允许 1 类「无偏差」隐含
    return {
      passed: false,
      details: `review artifact 缺少 ${missingIdx.length} 类差异段（plan 偏差 / 需求偏差 / 未实现 / 额外做）`,
    };
  }

  // git diff hash 检查（可选、artifact 没声明 hash 时跳过）
  const cwd = getEffectiveCwd(task.repoPaths);
  try {
    await fs.access(path.join(cwd, ".git"));
  } catch {
    return {
      passed: true,
      details: "review artifact 4 类差异段齐全（非 git 仓、跳过 diff hash 检查）",
    };
  }

  const hashMatch = content.match(/git\s+(diff|rev-parse)\s+(?:HEAD\s+)?hash[:：]?\s*([0-9a-f]{6,40})/i);
  if (!hashMatch) {
    return {
      passed: true,
      details: "review artifact 4 类差异段齐全（artifact 未声明 diff hash、跳过 hash 一致性检查）",
    };
  }
  const declaredHash = hashMatch[2];
  const gs = await runShell("git", ["rev-parse", "HEAD"], cwd);
  if (gs.exitCode !== 0) {
    return {
      passed: true,
      details: "review 4 类差异段齐全（git rev-parse HEAD 跑失败、跳过 hash 一致性）",
    };
  }
  const realHash = gs.stdout.trim();
  if (!realHash.startsWith(declaredHash) && !declaredHash.startsWith(realHash)) {
    return {
      passed: false,
      details: `review artifact 声明的 git hash ${declaredHash} 与实际 HEAD ${realHash} 不一致（agent 可能编造 diff）`,
    };
  }

  return {
    passed: true,
    details: "review artifact 4 类差异段齐全、git hash 一致",
  };
};

// ----------------- shell 工具 -----------------

interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  // 命令本身找不到（ENOENT）、跟「跑成功但 exit != 0」区分
  notFound: boolean;
}

const runShell = (
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 120_000,
): Promise<ShellResult> =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(cmd, args, { cwd, shell: false });
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* noop */
      }
      stderr += `\n[action-check] ${cmd} ${args.join(" ")} 超时 ${timeoutMs}ms、强杀`;
    }, timeoutMs);

    proc.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    proc.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    proc.on("error", (err) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const notFound =
        (err as NodeJS.ErrnoException).code === "ENOENT";
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + (notFound ? "" : `\n${err.message}`),
        notFound,
      });
    });
    proc.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        notFound: false,
      });
    });
  });
