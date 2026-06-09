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
 * 检查内容（V0.6.1 范围、用户拍板删 plan 黑名单 grep 后简化）：
 *   - plan: artifact 文件存在 + 内容长度 >= 100
 *   - build: V0.6.3 用户拍板暂时撤掉（原 pnpm typecheck/lint/git status；写死 pnpm 对多技术栈
 *     如 Java 会误报失败、先撤掉、后面重做成技术栈自适应 / 独立 check）
 *   - review: artifact「总评」段声明的「基底 commit」跟实际 `git rev-parse HEAD` 一致（防 agent 拿错 / 编造基底）
 *   - ship（V0.6.1）：task.mrs 覆盖所有 repoPath（每仓 1 条 url 非空）、或 artifact 说明跳过原因
 *   - test/learn: V0.6.2+ stub、暂不实现
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
      // build：V0.6.3 用户拍板暂时撤掉 typecheck/lint/git 检查
      //   直接原因：写死 pnpm 对多技术栈（Java 等）会误报失败、先撤掉避免误伤、
      //   后面再加（可能把 check build 独立成单独的 check action / 模块、做技术栈自适应）
      // test / learn：V0.6.2+ 还没实现
      case "build":
      case "test":
      case "learn":
        return {
          passed: true,
          details: `${action.type} action 暂未实现 deterministic 检查、跳过`,
        };
      case "review":
        return await checkReview(task, action);
      case "ship":
        return await checkShip(task, action);
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

  // 必备段检查（V0.6.9 重校准）
  // 旧版用松散 grep 找「偏差/需求/未实现/额外」4 个词、容忍缺 1——但 review 骨架明确「无内容的差异段
  // 整段省略（不写空标题、不写「无」）」、一份干净 review（无范围偏离 / 无未完成 task / 无超范围）天然
  // 不含这些词、却被误判 ❌（V0.6.9 实测踩到、误判红条会直接打击用户对 review 的信任）。
  // 改为只验骨架里「无省略豁免」的两段：总评 + 跟飞书需求对照（review 的基本盘、任何 review 都该有）。
  // 条件段（范围偏离 / 实现偏差 / 未完成 task）无内容时按骨架省略、不参与本检查。
  const requiredSections: { name: string; re: RegExp }[] = [
    { name: "总评", re: /总评/ },
    { name: "跟飞书需求对照", re: /需求对照|飞书需求|需求项|story/i },
  ];
  const missing = requiredSections.filter((s) => !s.re.test(content));
  if (missing.length > 0) {
    return {
      passed: false,
      details: `review artifact 缺少必备段：${missing
        .map((s) => s.name)
        .join(" / ")}（总评 + 飞书需求对照是 review 基本盘、无省略豁免）`,
    };
  }

  // V0.6.9：阶段二「bug 复审」段必须存在——防 fresh agent 跳过 peer bug 复审、退回「只做差值」的鸡肋老路。
  // 锚点是 artifact 里的「## bug 复审」标题（骨架里恒带、找不到 bug 也写「未发现高置信 bug」）。
  if (!/bug\s*复审/i.test(content) && !/未发现.{0,12}bug/i.test(content)) {
    return {
      passed: false,
      details:
        "review artifact 缺少「bug 复审」段（V0.6.9 阶段二必做、没找到 bug 也要写「未发现高置信 bug」）",
    };
  }

  // 基底 commit 一致性检查（V0.6 门槛 2、P1-2 修复）
  const cwd = getEffectiveCwd(task.repoPaths);
  try {
    await fs.access(path.join(cwd, ".git"));
  } catch {
    return {
      passed: true,
      details: "review artifact 必备段 + bug 复审段齐全（非 git 仓、跳过基底 commit 检查）",
    };
  }

  // review 骨架「总评」段要求 agent 写「- **基底 commit**：`<git rev-parse HEAD 真值>`」、
  // runner 在此 re-run git rev-parse HEAD、跟 artifact 声明的基底比对（防 agent 拿错 checkout / 编造基底）。
  // ⚠️ 旧正则找的是「git rev-parse hash: <x>」这种字面、跟骨架「基底 commit：`<x>`」对不上 = 死代码、从不命中（P1-2）。
  // 注：review 不动工作树、不做 `git diff | sha256sum`（骨架无 diff hash 字段、强加 = prompt↔code 漂移）。
  const baseMatch = content.match(/基底\s*commit[^\n]*?([0-9a-f]{7,40})/i);
  if (!baseMatch) {
    return {
      passed: true,
      details:
        "review artifact 必备段 + bug 复审段齐全（artifact 未声明基底 commit、跳过一致性检查）",
    };
  }
  const declaredBase = baseMatch[1];
  const gs = await runShell("git", ["rev-parse", "HEAD"], cwd);
  if (gs.exitCode !== 0) {
    return {
      passed: true,
      details:
        "review 必备段 + bug 复审段齐全（git rev-parse HEAD 跑失败、跳过基底 commit 一致性）",
    };
  }
  const realBase = gs.stdout.trim();
  // 容忍短 hash：声明值是真值前缀、或反之（agent 可能写 7-12 位短 hash）
  if (!realBase.startsWith(declaredBase) && !declaredBase.startsWith(realBase)) {
    return {
      passed: false,
      details: `review artifact 声明的基底 commit ${declaredBase} 跟实际 HEAD ${realBase} 不一致（agent 可能拿错 checkout / 编造基底）`,
    };
  }

  return {
    passed: true,
    details: "review artifact 必备段 + bug 复审段齐全、基底 commit 跟 HEAD 一致",
  };
};

// ----------------- ship（V0.6.1）-----------------
//
// 检查目标：agent 没漏报 MR、没编造 URL、跳过的仓有原因
// 跳过场景（合法）：某仓 git diff 为空 / 用户指定单仓 ship 等、agent 在 artifact §X「跳过原因」段说明
//
// 检查算法：
//   1. 收集 action.sideEffects.mrs[] 里所有 repoPath
//   2. 跟 task.repoPaths[] 对比、缺失的仓必须在 artifact 里出现「跳过 / skip」关键词
//   3. 所有 MR 记录的 mrUrl 非空（防编造）
//   4. 任一 MR hasConflicts=true → ship 不算干净完成（V0.6.1.1、需用户解冲突后重跑）
const checkShip = async (
  task: Task,
  action: ActionRecord,
): Promise<ActionCheckResult> => {
  if (!action.artifactPath) {
    return { passed: false, details: "ship 没产出 artifact" };
  }
  const absPath = getActionArtifactPath(task.id, action.n, action.type);
  let content: string;
  try {
    content = await fs.readFile(absPath, "utf-8");
  } catch (err) {
    return {
      passed: false,
      details: `ship artifact 读取失败：${absPath}（${err instanceof Error ? err.message : String(err)}）`,
    };
  }

  const mrRecords = action.sideEffects?.mrs ?? [];
  const reportedRepoPaths = new Set(mrRecords.map((m) => m.repoPath));
  const targetRepoPaths = task.repoPaths;

  const sections: string[] = [];
  let allPassed = true;

  // 1) 每条 MR 记录必须 URL 非空
  const missingUrl = mrRecords.filter((m) => !m.mrUrl || m.mrUrl.trim().length === 0);
  if (missingUrl.length > 0) {
    allPassed = false;
    sections.push(
      `❌ ${missingUrl.length} 条 MR 记录 URL 为空（${missingUrl.map((m) => m.repoPath).join(", ")}）`,
    );
  } else if (mrRecords.length > 0) {
    sections.push(
      `✅ ${mrRecords.length} 条 MR 记录、URL 都非空：\n${mrRecords
        .map((m) => `   - ${m.repoPath}（v${m.mrVersion}）: ${m.mrUrl}`)
        .join("\n")}`,
    );
  }

  // 1.5) 有冲突的 MR → ship 不算干净完成（V0.6.1.1）
  // 冲突时 agent 应走 §3.5 ask_user、不该发飞书评论；用户解完冲突重跑 ship、冲突翻成无冲突才判干净
  const conflictMrs = mrRecords.filter((m) => m.hasConflicts === true);
  if (conflictMrs.length > 0) {
    allPassed = false;
    sections.push(
      `❌ ${conflictMrs.length} 条 MR 跟 test 有冲突、需用户手动解决后重跑 ship：\n${conflictMrs
        .map((m) => `   - ${m.repoPath}（v${m.mrVersion}）: ${m.mrUrl}`)
        .join("\n")}`,
    );
  }

  // 2) 没提测（没创建 MR）的仓必须有跳过说明
  const skippedRepos = targetRepoPaths.filter((p) => !reportedRepoPaths.has(p));
  if (skippedRepos.length > 0) {
    const skipMissingReason: string[] = [];
    // 跳过说明关键词：agent 在 artifact §3 备注列写的「跳过 / 无改动」等
    const SKIP_KEYWORDS = "跳过|skip|无改动|无需|未改";
    for (const repo of skippedRepos) {
      // 粗匹配兜底：repo 末段名（如 crm-web）与 skip 关键词在 200 字窗口内相邻即算「写了原因」
      // 双向都判（仓名在前 / 关键词在前都算）——agent 自然语序两种都可能、单向会漏检（V0.6.1 review 修）
      // 已知局限：同名末段多仓（/a/client + /b/client）仍可能互相借用说明、公司场景不出现、留 V0.6.4 严格化
      const repoTail = repo.split("/").filter(Boolean).pop() ?? repo;
      const tailEsc = repoTail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const forward = new RegExp(`${tailEsc}[\\s\\S]{0,200}(${SKIP_KEYWORDS})`, "i");
      const backward = new RegExp(`(${SKIP_KEYWORDS})[\\s\\S]{0,200}${tailEsc}`, "i");
      if (!forward.test(content) && !backward.test(content)) {
        skipMissingReason.push(repo);
      }
    }
    if (skipMissingReason.length > 0) {
      allPassed = false;
      sections.push(
        `❌ 以下仓没创建 MR、artifact 里也找不到跳过说明：${skipMissingReason.join(", ")}（agent 漏报）`,
      );
    } else {
      sections.push(
        `✅ ${skippedRepos.length} 个仓被跳过、artifact 里都写了原因：${skippedRepos.join(", ")}`,
      );
    }
  }

  // 3) 必须至少提 1 个 MR 或跳过所有仓——都没的话 ship 没产出
  if (mrRecords.length === 0 && skippedRepos.length === 0) {
    allPassed = false;
    sections.push(
      "❌ ship 没产出任何 MR、也没声明跳过所有仓（agent 可能空跑）",
    );
  }

  return {
    passed: allPassed,
    details: sections.length > 0 ? sections.join("\n\n") : "ship 检查通过",
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
