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
 *   - build（V0.6.25 CheckRun 复活）：per-repo 跑用户配的 checkCommands（typecheck/lint/test/...）、
 *     执行前后比对 tracked 工作区检测「命令偷改源码」、并记录每仓工作区指纹给 ship gate 比对。
 *     历史：V0.6.3 曾撤掉写死的 pnpm（多技术栈如 Java 误报）、V0.6.25 改「用户 per-repo 配命令、
 *     没配的仓按是否被本次 build 改过分 not_configured/skipped」复活、详见 checkBuild / runRepoChecks
 *   - review: artifact「总评」段声明的「基底 commit」跟实际 `git rev-parse HEAD` 一致（防 agent 拿错 / 编造基底）
 *   - ship（V0.6.1）：task.mrs 覆盖所有 repoPath（每仓 1 条 url 非空）、或 artifact 说明跳过原因
 *   - learn（V0.6.29）：必备段（提炼条目 / 本次无可沉淀）+ 证据路径真实 + 落地记录闭环
 *   - test: stub、暂不实现
 *   - chat 不走本机制（chat 是独立 mode、不复用 action 体系、详见 chat-runner.ts）
 *
 * 关于 plan「黑名单 grep」的历史决策（2026-05-28 用户拍板删）：
 *   V0.5.6.5 加过一组 13 个不确定字眼黑名单（或 / 约 / TBD / 可能 / 示例 / 节选 ...）、
 *   substring grep artifact 命中即 ❌。意图是防 agent 把含糊词带进 plan、保 build 阶段 ground truth。
 *   但 substring 不分语境、对「示例」（表格列名）、「或」（业务规则明确 or）等高频业务词
 *   误伤率高（V0.6.0.1 实测两条都是误报）。用户拍板「方案太简单粗暴、不是有效约束、先彻底删、
 *   后面再考虑长远的（语义 diff / agent 自检 etc.）」、本文件不再 ship 这套 grep。
 *
 * 检查脚本本身的依赖：node:child_process / node:crypto / node:fs / node:path
 * 失败时（如仓库不是 git 仓 / 找不到 pnpm）兜底返「passed=true、details=「检查不可用、自动跳过」」、
 * 避免环境问题挡用户主流程（这是软兜底、最终质量靠用户人眼把关）。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ActionRecord,
  CheckCommand,
  CheckCommandResult,
  CheckRepoResult,
  CheckRunSummary,
  Task,
} from "@/lib/types";
import { CHECK_KIND_DEFAULT_TIMEOUT_MS } from "@/lib/types";

import { getActionArtifactPath, getCheckLogPaths } from "./task-fs";
import { isMutatingScript } from "./repo-check-detect";
import { getEffectiveCwd } from "@/lib/path-utils";

export interface ActionCheckResult {
  passed: boolean;
  details: string;
  /**
   * V0.6.25 CheckRun：build action 专属——结构化校验摘要（per-repo per-command）
   * runner 把它落到 ActionRecord.checkRun（passed/details 仍落 postCheck、复用现成红绿条 UI）。
   */
  checkRun?: CheckRunSummary;
}

// 主入口：跑给定 action 的 deterministic 检查
// signal（V0.8.18）：仅 build 用——后置 CheckRun 后台异步跑、停止 / 推进新 action 时 abort 杀子进程
export const runActionCheck = async (
  task: Task,
  action: ActionRecord,
  signal?: AbortSignal,
): Promise<ActionCheckResult> => {
  try {
    switch (action.type) {
      case "plan":
        return await checkPlan(task, action);
      // build（V0.6.25 CheckRun）：per-repo 跑用户配的 checkCommands、不再写死 pnpm
      //   （绕开 V0.6.3 撤掉的「写死 pnpm 搞死多栈」：没配命令的仓记 not_configured、不误报）
      case "build":
        return await checkBuild(task, action, signal);
      // test：还没实现
      case "test":
        return {
          passed: true,
          details: "test action 暂未实现 deterministic 检查、跳过",
        };
      case "learn":
        return await checkLearn(task, action);
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

  // V0.6.27 小节 lint：只验骨架里无省略豁免的两个核心段（需求理解 + Task 拆分）。
  // 跟被拍板删掉的「内容黑名单 grep」不同：标题匹配误伤面小、且缺这两段的 plan 确实没法 ack。
  const requiredSections: { name: string; re: RegExp }[] = [
    { name: "需求理解", re: /需求理解/ },
    { name: "Task 拆分", re: /task\s*拆分/i },
  ];
  const missing = requiredSections.filter((s) => !s.re.test(content));
  if (missing.length > 0) {
    return {
      passed: false,
      details: `plan artifact 缺少必备段：${missing
        .map((s) => s.name)
        .join(" / ")}（骨架核心段、无省略豁免）`,
    };
  }

  return { passed: true, details: "plan artifact 已落盘、长度 + 必备段通过" };
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

  // V0.6.27：review 只读硬校验——action 启动时记录的工作区指纹、此刻重算比对。
  // 不一致 = agent 在 review 期间改了代码（review 禁改代码原来纯 prompt 约束、漂了没人知道）。
  // startBaseline 缺失（老 action / 启动时记录失败）→ 跳过比对、fail-open。
  if (action.startBaseline) {
    const touched: string[] = [];
    for (const repoPath of task.repoPaths) {
      const baseline = action.startBaseline[repoPath];
      if (!baseline) continue;
      const current = await computeWorktreeFingerprint(repoPath);
      if (current !== null && current !== baseline) {
        touched.push(repoPath);
      }
    }
    if (touched.length > 0) {
      return {
        passed: false,
        details: `review 期间工作区被改动：${touched.join(", ")}（review 是只读 action、agent 不许改代码——指纹比对失败、改动可能来自 agent 越权或外部干扰、请检查 git status）`,
      };
    }
  }

  return {
    passed: true,
    details:
      "review artifact 必备段 + bug 复审段齐全、基底 commit 跟 HEAD 一致、工作区未被改动",
  };
};

// ----------------- learn（V0.6.29）-----------------
//
// 检查目标：防 agent 凭印象编造沉淀 / 跳过 HITL 闭环
//   1. artifact 落盘 + 内容 ≥ 100 字
//   2. 「提炼条目」段存在、或明确写「本次无可沉淀」（0 条是合格结果、但要写明）
//   3. 证据路径真实：artifact 引用的所有 actions/N-<type>.md 必须存在于本 task（防编造）
//   4. 提炼条目非空时「落地记录」段必须存在（证明 ask_user 筛选闭环走完、全否决也要记）
const checkLearn = async (
  task: Task,
  action: ActionRecord,
): Promise<ActionCheckResult> => {
  if (!action.artifactPath) {
    return { passed: false, details: "learn 没产出 artifact" };
  }
  const absPath = getActionArtifactPath(task.id, action.n, action.type);
  let content: string;
  try {
    content = await fs.readFile(absPath, "utf-8");
  } catch (err) {
    return {
      passed: false,
      details: `learn artifact 读取失败：${absPath}（${err instanceof Error ? err.message : String(err)}）`,
    };
  }
  if (content.trim().length < 100) {
    return {
      passed: false,
      details: `artifact 内容过短（${content.trim().length} chars）、不像完整 learn 复盘`,
    };
  }

  const hasEntries = /提炼条目/.test(content);
  const declaredNone = /本次无可沉淀/.test(content);
  if (!hasEntries && !declaredNone) {
    return {
      passed: false,
      details:
        "learn artifact 缺「提炼条目」段、也没写「本次无可沉淀条目」——0 条是合格结果、但必须明示 + 理由",
    };
  }

  // 证据路径真实性：扫所有 actions/N-<type>.md 引用、逐个验证存在
  // （路径拼接复用 getActionArtifactPath、跟 artifact 实际落盘规则同源）
  const refs = [...content.matchAll(/actions\/(\d+)-([a-z]+)\.md/g)];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const m of refs) {
    const ref = m[0]!;
    if (seen.has(ref)) continue;
    seen.add(ref);
    // 本 action 自己的 artifact 不算证据引用、跳过
    if (Number(m[1]) === action.n) continue;
    try {
      await fs.access(
        getActionArtifactPath(task.id, Number(m[1]), m[2] as ActionRecord["type"]),
      );
    } catch {
      missing.push(ref);
    }
  }
  if (missing.length > 0) {
    return {
      passed: false,
      details: `learn artifact 引用了不存在的证据路径：${missing.join(", ")}（疑似凭印象编造、证据必须指向真实 artifact）`,
    };
  }

  // 闭环检查：有提炼条目（且不是声明 0 条）→ 必须有落地记录段
  if (hasEntries && !declaredNone && !/落地记录/.test(content)) {
    return {
      passed: false,
      details:
        "learn artifact 有「提炼条目」但缺「落地记录」段——ask_user 筛选闭环没走完（全否决也要记「用户全部否决」）",
    };
  }

  return {
    passed: true,
    details: `learn artifact 完整：提炼条目 / 证据路径（${seen.size} 处引用全部真实）/ 落地记录闭环通过`,
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

// ----------------- build（V0.6.25 CheckRun）-----------------
//
// 设计见 types.ts CheckCommand 注释。核心：
//   - 遍历 task.repoPaths、按 task.repoCheckCommands?.[repoPath] 跑 per-repo 校验命令
//   - 命令走 `sh -c`（支持 && / cd / 管道）、PATH 继承 runner 环境 + 补常见 bin（兜 nvm/volta/mvn）
//   - 每条命令跑前后比对 git tracked 状态——命令偷改源码（如手滑 --fix）判 mutated = failed（结果不可信）
//   - 完整输出落 actions/.checks/<actionId>/<slug>.log、摘要（per-command logTail）进 ActionRecord.checkRun
//   - build 改动停在工作区（未 commit）、check 校验的正是这批工作区改动（符合 build「不碰 .git」铁律）
//
// 聚合：任一 required 命令 failed/timed_out/mutated → repo failed；全 repo not_configured → 整体 not_configured
// postCheck.passed = checkRun.status !== "failed"（not_configured 不算失败、UI 灰条、但 ship gate 仍会拦）

// check 命令执行环境：继承 runner（next dev）PATH + 补常见 bin 目录
// 局限：nvm 按版本的 node 路径不固定、第一版只兜静态常见路径；找不到工具时命令 exit 127、记 failed
const buildCheckEnv = (): NodeJS.ProcessEnv => {
  const home = process.env.HOME ?? "";
  const extraBins = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    home ? `${home}/.volta/bin` : "",
    home ? `${home}/.local/bin` : "",
  ].filter(Boolean);
  const basePath = process.env.PATH ?? "";
  return {
    ...process.env,
    PATH: [...extraBins, basePath].filter(Boolean).join(":"),
  };
};

interface CheckShellResult {
  exitCode: number;
  // stdout + stderr 合并（check 日志不区分两路、按时间穿插即可）
  output: string;
  timedOut: boolean;
}

// 超时强杀：优先按进程组杀（-pid、连 sh 起的 pnpm/jest 等子进程一起杀、防孤儿泄漏）、退回单进程杀
// 背景：`sh -c "pnpm test"` 超时只 kill sh 时、真正干活的子进程会脱离成孤儿继续占资源（V0.6.25 蓝军）
const killProcessTree = (proc: ReturnType<typeof spawn>) => {
  try {
    if (proc.pid) {
      process.kill(-proc.pid, "SIGKILL");
      return;
    }
  } catch {
    // 进程组不存在 / 平台不支持 negative pid → 退回单杀
  }
  try {
    proc.kill("SIGKILL");
  } catch {
    /* 已退出、noop */
  }
};

// 跑一条 shell 命令（sh -c、支持组合命令）、带超时强杀
// 单命令 output 累积上限——超了截断、防巨大测试输出打爆 Next server 内存（V0.6.25 review）
const CHECK_OUTPUT_CAP = 512 * 1024;

const runCheckShell = (
  cmd: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes = CHECK_OUTPUT_CAP,
  // V0.8.18：外部取消信号（停止 / 推进新 action 时 abort、杀掉慢命令子进程树、不让 typecheck 空跑几分钟）
  signal?: AbortSignal,
): Promise<CheckShellResult> =>
  new Promise((resolve) => {
    // 已被取消 → 不起子进程、直接返回（结果由调用方按 aborted 丢弃）
    if (signal?.aborted) {
      resolve({ exitCode: -1, output: "[aborted]", timedOut: false });
      return;
    }
    let output = "";
    // 已达上限、之后输出直接丢弃（进程仍跑、只是不再收集、防内存爆）
    let truncated = false;
    let timedOut = false;
    // detached：子进程独立成新进程组、超时时按 -pid 杀整组（见 killProcessTree）；
    // 不 unref（仍要等 close 事件收尾）、stdio 默认 pipe 不受影响
    const proc = spawn("sh", ["-c", cmd], {
      cwd,
      env: buildCheckEnv(),
      detached: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(proc);
    }, timeoutMs);
    // 外部 abort（停止 / 推进）→ 杀整棵进程树、由 close 事件兜底 resolve
    const onAbort = () => killProcessTree(proc);
    signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    // 累积 output、到上限就截断并打明显标记（否则用户看尾部以为命令自然结束）
    const append = (d: unknown) => {
      if (truncated) return;
      output += String(d);
      if (output.length > maxOutputBytes) {
        output =
          output.slice(0, maxOutputBytes) +
          `\n[output truncated at ${Math.round(maxOutputBytes / 1024)}KB]`;
        truncated = true;
      }
    };
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);
    proc.on("error", (err) => {
      cleanup();
      resolve({
        exitCode: -1,
        output: output + `\n[spawn error] ${err.message}`,
        timedOut,
      });
    });
    proc.on("close", (code) => {
      cleanup();
      resolve({ exitCode: code ?? -1, output, timedOut });
    });
  });

// 取该仓 tracked 文件改动状态（污染检测基线）
// untracked 不算（coverage / .turbo / 报告目录是临时产物、通常 gitignored）；非 git 仓 / git 失败 → null（不判 mutated）
const trackedWorktreeStatus = async (cwd: string): Promise<string | null> => {
  const r = await runCheckShell(
    "git status --porcelain --untracked-files=no",
    cwd,
    15_000,
  );
  return r.exitCode === 0 ? r.output.trim() : null;
};

// 取末尾 maxLines 行（logTail 摘要、完整在日志文件）
const tailLines = (text: string, maxLines = 15): string => {
  const trimmed = text.replace(/\s+$/, "");
  const lines = trimmed.split("\n");
  return lines.length <= maxLines ? trimmed : lines.slice(-maxLines).join("\n");
};

// repo 末段名（日志 slug + UI 展示用）
const repoTailName = (repoPath: string): string =>
  repoPath.split("/").filter(Boolean).pop() ?? repoPath;

// 跑单仓所有 check 命令、返结构化结果 + 把完整日志写文件
// 工作区指纹脚本（V0.6.25 review）——覆盖：tracked 改 / staged / 删除 / 新增 untracked 文件 / untracked 内容变化
// 关键：`git diff HEAD` 不含 untracked 文件内容、`git status` 只含路径不含内容、所以单独对 untracked 逐文件 hash。
// 用 `git hash-object --stdin-paths`（git 原生、空输入安全不 hang、不依赖 bash `read -d` 跨 mac/linux dash 都行）。
// `--exclude-standard` 排除 gitignore（coverage/cache/node_modules 不算进指纹）。
const FINGERPRINT_SCRIPT = [
  "git rev-parse HEAD 2>/dev/null || echo __NOGIT__",
  "echo __DIFF__",
  "git diff --no-ext-diff --binary HEAD -- 2>/dev/null",
  "echo __UPATHS__",
  "git ls-files --others --exclude-standard 2>/dev/null",
  "echo __UHASHES__",
  "git ls-files --others --exclude-standard 2>/dev/null | git hash-object --stdin-paths 2>/dev/null",
].join("\n");

// 该仓「工作区内容指纹」= sha256(headCommit + tracked diff + untracked 路径 + untracked 内容 hash)
// check 结束记录、ship gate 前重算比对——不一致 = check 后工作区又被改、旧 checkRun 不代表当前要 ship 的内容。
// 给 20MB cap（指纹要完整 diff、不能被默认 512KB 截断）；非 git 仓 / 异常 → null（gate 端视为「无法比对、不拦」）。
// ⚠ 边界：tracked diff 全文 + untracked hash 列表累积 >20MB 会被截断、理论上漏掉 20MB 之后的 tracked 改动
//   （实际罕见、20MB 纯文本 diff 极大）。要严格无上限、可把 tracked 部分也改成逐文件 hash-object（untracked 已是）。
export const computeWorktreeFingerprint = async (
  repoPath: string,
): Promise<string | null> => {
  const r = await runCheckShell(
    FINGERPRINT_SCRIPT,
    repoPath,
    30_000,
    20 * 1024 * 1024,
  );
  if (r.exitCode !== 0) return null;
  if (r.output.split("\n", 1)[0]?.trim() === "__NOGIT__") return null;
  return createHash("sha256").update(r.output).digest("hex");
};

// 本仓是否被改动过——tracked 改 + staged + 删除 + 新增 untracked（--untracked-files=all）全算。
// 决定「没配 check 命令的仓」是 not_configured（改了没检查、要关注）还是 skipped（没碰、不影响整体）。
// 跟 trackedWorktreeStatus 的区别：那个 untracked=no（污染检测、untracked 是命令产物不算）；这个要含新增文件。
const isRepoDirty = async (repoPath: string): Promise<boolean> => {
  const r = await runCheckShell(
    "git status --porcelain --untracked-files=all",
    repoPath,
    15_000,
  );
  return r.exitCode === 0 && r.output.trim().length > 0;
};

// 命令会不会「自动改写工作区源码」（跑前预判、避免在用户工作区跑 --fix 类命令）（V0.8.20）
// 两条识别路径：
//   1) cmd 字符串本身含修复 flag（用户在设置页手配的裸命令、如 `eslint --fix src`）
//   2) cmd 是 `<pm> run <script>`、解析 repo package.json 里该 script 体含修复 flag
//      ——识破 `ng lint --fix=true` 这种藏在 script 内部、cmd 字面看不出来的；
//        且覆盖「存量 task 已把 `yarn run lint` 固化进 repoCheckCommands」的场景
//        （探测层 isMutatingScript 过滤只对新建 task 生效、老 task 数据里命令已落库）。
// 读不到 package.json / 非标准命令格式 → 返 false（无法判定、fail-open、交给事后 mutated 检测兜底）。
const willCommandMutateWorktree = async (
  cmd: string,
  repoPath: string,
): Promise<boolean> => {
  if (isMutatingScript(cmd)) return true;
  const m = cmd.trim().match(/^(?:pnpm|yarn|npm|bun)\s+run\s+([\w:.-]+)/);
  if (!m) return false;
  const scriptName = m[1]!;
  try {
    const pkgRaw = await fs.readFile(
      path.join(repoPath, "package.json"),
      "utf-8",
    );
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, unknown> };
    const body = pkg.scripts?.[scriptName];
    return typeof body === "string" && isMutatingScript(body);
  } catch {
    return false;
  }
};

const runRepoChecks = async (
  taskId: string,
  actionId: string,
  repoPath: string,
  slug: string,
  commands: CheckCommand[],
  // V0.8.18：透传给慢命令（lint/typecheck）的取消信号、停止/推进时杀子进程
  signal?: AbortSignal,
): Promise<CheckRepoResult> => {
  // 该仓基底 commit
  const headRes = await runCheckShell("git rev-parse HEAD", repoPath, 15_000);
  const headCommit =
    headRes.exitCode === 0 ? headRes.output.trim() || null : null;
  // 工作区指纹：check 这一刻的工作区内容快照（ship gate 重算比对、防 check 后又被改）
  const worktreeFingerprint = await computeWorktreeFingerprint(repoPath);

  // 没配 check 命令——按本仓是否被本次 build 改过区分：
  //   dirty（改了没检查）→ not_configured（拉低整体、ship 要 override）；clean（没碰）→ skipped（不影响 passed）
  if (commands.length === 0) {
    const dirty = await isRepoDirty(repoPath);
    return {
      repoPath,
      status: dirty ? "not_configured" : "skipped",
      headCommit,
      worktreeFingerprint,
      logPath: null,
      commands: [],
    };
  }

  const results: CheckCommandResult[] = [];
  const logBlocks: string[] = [];

  for (const c of commands) {
    // V0.8.20：跑前预判命令会不会自动改写工作区（--fix/--write 类）。会的话直接跳过不跑——
    // 避免 ① 污染工作区被事后判 failed（误红）；② 用户本地 dev server 被连环触发热重载、
    // 终端「一直重启」（线上 cp-admin 的 `ng lint --fix=true` 跑满 120s、期间 dev 每 3s 重编译、踩过）。
    // 修复型命令本就不是只读门禁、跳过记 skipped + 原因、不计入 failed（下方聚合排除 skipped）。
    if (await willCommandMutateWorktree(c.cmd, repoPath)) {
      const skipNote =
        "跳过：该命令会自动改写源码（检测到 --fix/--write 类修复 flag）、不当只读门禁跑。如需 lint 门禁，请在设置页把命令改成只读形式（去掉 --fix）。";
      results.push({
        name: c.name,
        cmd: c.cmd,
        kind: c.kind,
        required: c.required,
        status: "skipped",
        exitCode: 0,
        durationMs: 0,
        mutatedWorktree: false,
        logTail: skipNote,
      });
      logBlocks.push(
        `=== ${c.name}（${c.cmd}）[跳过：会改写工作区] ===\n${skipNote}`,
      );
      continue;
    }

    const timeoutMs =
      c.timeoutMs && c.timeoutMs > 0
        ? c.timeoutMs
        : CHECK_KIND_DEFAULT_TIMEOUT_MS[c.kind];
    // 跑前后各取一次 tracked 状态、变了 = 命令偷改了源码
    const before = await trackedWorktreeStatus(repoPath);
    const started = Date.now();
    const r = await runCheckShell(c.cmd, repoPath, timeoutMs, undefined, signal);
    const durationMs = Date.now() - started;
    const after = await trackedWorktreeStatus(repoPath);
    const mutatedWorktree =
      before !== null && after !== null && before !== after;

    let status: CheckCommandResult["status"];
    if (r.timedOut) status = "timed_out";
    else if (r.exitCode !== 0) status = "failed";
    else if (mutatedWorktree) status = "failed";
    else status = "passed";

    results.push({
      name: c.name,
      cmd: c.cmd,
      kind: c.kind,
      required: c.required,
      status,
      exitCode: r.exitCode,
      durationMs,
      mutatedWorktree,
      logTail: tailLines(r.output),
    });
    logBlocks.push(
      `=== ${c.name}（${c.cmd}）exit=${r.exitCode}${
        r.timedOut ? " [超时]" : ""
      }${mutatedWorktree ? " [工作区被改]" : ""} ${durationMs}ms ===\n${r.output}`,
    );
  }

  // 写完整日志（best-effort、写失败不影响判定、logPath 退回 null）
  let logPath: string | null = null;
  try {
    const { absPath, relPath } = getCheckLogPaths(taskId, actionId, slug);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, logBlocks.join("\n\n"), "utf-8");
    logPath = relPath;
  } catch (err) {
    console.warn(
      `[action-check] checkBuild 写日志失败 task=${taskId} repo=${repoPath}：`,
      err,
    );
  }

  // repo 聚合（V0.6.25 review + V0.8.20 skipped 处理）：
  //   - mutated（任一命令偷改工作区）→ failed：污染是独立安全语义、无视 required
  //     （兜底「没被跑前预判拦住的 --fix」；正常情况已在 willCommandMutateWorktree 拦截、走 skipped）
  //   - required 命令非 passed → failed；但 skipped（会改写、跑前主动跳过）不算失败、排除在外
  //   - 配了命令却「全被跳过」（没有任何真正执行的只读门禁）→ 退回 commands.length===0 语义：
  //     本仓被本次 build 改过（dirty）记 not_configured（ship 要确认）、没碰记 skipped
  const executed = results.filter((x) => x.status !== "skipped");
  const mutated = results.some((x) => x.mutatedWorktree);
  const requiredFailed = executed.some(
    (x) => x.required && x.status !== "passed",
  );
  let repoStatus: CheckRepoResult["status"];
  if (mutated || requiredFailed) {
    repoStatus = "failed";
  } else if (executed.length === 0) {
    repoStatus = (await isRepoDirty(repoPath)) ? "not_configured" : "skipped";
  } else {
    repoStatus = "passed";
  }
  return {
    repoPath,
    status: repoStatus,
    headCommit,
    worktreeFingerprint,
    logPath,
    commands: results,
  };
};

const checkBuild = async (
  task: Task,
  action: ActionRecord,
  signal?: AbortSignal,
): Promise<ActionCheckResult> => {
  const startedAt = Date.now();
  const repoResults: CheckRepoResult[] = [];

  // 遍历所有 repo——配了命令的跑、没配的按是否被本次 build 改过记 not_configured（改了）/ skipped（没改）
  // slug 用 idx 前缀防多仓末段同名（/a/client + /b/client）日志互相覆盖
  for (let i = 0; i < task.repoPaths.length; i++) {
    const repoPath = task.repoPaths[i]!;
    const commands = task.repoCheckCommands?.[repoPath] ?? [];
    const slug = `${i}-${repoTailName(repoPath)}`;
    repoResults.push(
      await runRepoChecks(task.id, action.id, repoPath, slug, commands, signal),
    );
  }

  // 整体聚合：任一 repo failed → failed；全 not_configured → not_configured；否则 passed
  const anyFailed = repoResults.some((r) => r.status === "failed");
  const anyNotConfigured = repoResults.some(
    (r) => r.status === "not_configured",
  );
  const status: CheckRunSummary["status"] = anyFailed
    ? "failed"
    : anyNotConfigured
      ? "not_configured"
      : "passed";

  const checkRun: CheckRunSummary = {
    id: `cr_${action.id}_${startedAt}`,
    status,
    startedAt,
    endedAt: Date.now(),
    repos: repoResults,
  };

  // postCheck 文本摘要（复用 action 红绿条 UI）
  const detailLines = repoResults.map((r) => {
    const tail = repoTailName(r.repoPath);
    if (r.status === "not_configured")
      return `  - ${tail}：有改动但没配检查命令（ship 需确认）`;
    if (r.status === "skipped") return `  - ${tail}：本次没改动、跳过`;
    const cmdSummary = r.commands.map((c) => `${c.name}=${c.status}`).join(" / ");
    return `  - ${tail}：${r.status}（${cmdSummary}）`;
  });
  const sections: string[] = [
    `build CheckRun ${status}：\n${detailLines.join("\n")}`,
  ];
  let artifactLintPassed = true;

  // V0.6.27 artifact 小节 lint：「全量校验」「修改记录」是 build 骨架铁段
  // （有无 plan / 分不分批都必须有、_shared.md「修改记录」段是跨 action 强制规范）
  if (action.artifactPath) {
    try {
      const artifactContent = await fs.readFile(
        getActionArtifactPath(task.id, action.n, action.type),
        "utf-8",
      );
      const requiredSections: { name: string; re: RegExp }[] = [
        { name: "全量校验", re: /全量校验/ },
        { name: "修改记录", re: /修改记录/ },
      ];
      const missing = requiredSections.filter(
        (s) => !s.re.test(artifactContent),
      );
      if (missing.length > 0) {
        artifactLintPassed = false;
        sections.push(
          `❌ build artifact 缺少必备段：${missing.map((s) => s.name).join(" / ")}（骨架铁段、无省略豁免）`,
        );
      }
    } catch {
      artifactLintPassed = false;
      sections.push("❌ build artifact 读取失败（agent 声明了路径但文件不在）");
    }
  } else {
    artifactLintPassed = false;
    sections.push("❌ build 没产出 artifact（artifactPath 为空）");
  }

  // V0.6.27 兄弟仓越权检测：startBaseline 里 task 仓之外的 key = 启动时记录的兄弟仓状态 hash、
  // 此刻重算比对。变了 = build 期间有人动了兄弟仓（多半是 agent 写错仓）。
  // 只 warning 不拉 failed：无法 100% 排除外部干扰（用户编辑器自动保存等）、误杀比放过代价大。
  if (action.startBaseline) {
    const taskRepoSet = new Set(task.repoPaths);
    const touchedSiblings: string[] = [];
    for (const [p, baseline] of Object.entries(action.startBaseline)) {
      if (taskRepoSet.has(p)) continue;
      const current = await computeRepoStatusHash(p);
      if (current !== null && current !== baseline) touchedSiblings.push(p);
    }
    if (touchedSiblings.length > 0) {
      sections.push(
        `⚠️ build 期间检测到「非本 task 的兄弟仓库」工作区有变化：${touchedSiblings.join(", ")}——agent 可能把改动写错了仓库、请人工确认（git status）`,
      );
    }
  }

  return {
    passed: status !== "failed" && artifactLintPassed,
    details: sections.join("\n\n"),
    checkRun,
  };
};

// ----------------- action 启动基线（V0.6.27）-----------------

// 该仓 git status hash（轻量基线、兄弟仓越权检测用）
// 跟 worktreeFingerprint 的取舍：status 只含「路径 + 状态码」不含内容、快（<1s）但检测不到
// 「同一批脏文件内容又变了」——兄弟仓场景基本是「从 clean 变脏」、status hash 足够；
// review 场景 build 改动本来就停在工作区（路径集不变、内容会变）、必须用内容指纹。
const computeRepoStatusHash = async (
  repoPath: string,
): Promise<string | null> => {
  const r = await runCheckShell(
    "git status --porcelain --untracked-files=all",
    repoPath,
    15_000,
  );
  if (r.exitCode !== 0) return null;
  return createHash("sha256").update(r.output).digest("hex");
};

// 发现 effective cwd 下「非本 task 的兄弟 git 仓」（多仓 cwd = 公共父目录时才有）
const discoverSiblingRepos = async (task: Task): Promise<string[]> => {
  const cwd = getEffectiveCwd(task.repoPaths);
  const taskRepoSet = new Set(task.repoPaths.map((p) => path.resolve(p)));
  // 单仓：cwd = 仓本身、没有兄弟仓概念
  if (taskRepoSet.has(path.resolve(cwd))) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(cwd, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const abs = path.join(cwd, e.name);
    if (taskRepoSet.has(path.resolve(abs))) continue;
    try {
      await fs.access(path.join(abs, ".git"));
      out.push(abs);
    } catch {
      // 非 git 仓、跳过
    }
  }
  return out;
};

/**
 * action 启动时采集工作区基线（task-runner 在 appendAction 后调、存 ActionRecord.startBaseline）
 *
 * - review：task 各仓的 worktreeFingerprint（内容指纹）——checkReview 比对、review 只读硬校验
 * - build：cwd 下兄弟 git 仓的 status hash——checkBuild 比对、越权写错仓检测
 * - 其他 action 类型：undefined（不采集）
 *
 * 失败 fail-open：单仓采集失败就跳过该仓（不进 map）、整体异常返 undefined、绝不挡 action 启动。
 */
export const captureActionStartBaseline = async (
  task: Task,
  actionType: ActionRecord["type"],
): Promise<Record<string, string> | undefined> => {
  try {
    if (actionType === "review") {
      const entries = await Promise.all(
        task.repoPaths.map(async (p) => {
          const fp = await computeWorktreeFingerprint(p);
          return [p, fp] as const;
        }),
      );
      const map = Object.fromEntries(
        entries.filter((e): e is [string, string] => e[1] !== null),
      );
      return Object.keys(map).length > 0 ? map : undefined;
    }
    if (actionType === "build") {
      const siblings = await discoverSiblingRepos(task);
      if (siblings.length === 0) return undefined;
      const entries = await Promise.all(
        siblings.map(async (p) => {
          const h = await computeRepoStatusHash(p);
          return [p, h] as const;
        }),
      );
      const map = Object.fromEntries(
        entries.filter((e): e is [string, string] => e[1] !== null),
      );
      return Object.keys(map).length > 0 ? map : undefined;
    }
    return undefined;
  } catch (err) {
    console.warn(
      `[action-check] captureActionStartBaseline 异常（跳过基线）task=${task.id}：`,
      err,
    );
    return undefined;
  }
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
