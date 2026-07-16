/**
 * Action 后置 deterministic 检查（V0.6 门槛 2）
 *
 * 设计原则：
 *   - 每个 action 类型一组检查、runner 在 agent 调 submit_work(action_id) 切 awaiting_ack 前跑
 *   - 检查不依赖 agent 自称、走真实 shell / fs / git diff
 *   - 检查不通过：action 仍切 awaiting_ack（让用户看到结果）、但 postCheck.passed=false
 *     UI 上挂红条「后置检查未过」、用户可以选 revise 让 agent 改
 *   - 检查通过：postCheck.passed=true、UI 上挂绿条
 *
 * 检查范围（v0.9.13 拍板：只查「agent 交付诚实性」、不跑项目命令）：
 *   - plan: artifact 文件存在 + 内容长度 >= 100 + 必备段
 *   - build: artifact 落盘 + 必备段（全量校验；「修改记录」铁段已删）+ 兄弟仓越权检测
 *   - review: artifact「总评」段声明的「基底 commit」跟实际 `git rev-parse HEAD` 一致（防 agent 拿错 / 编造基底）
 *     + 工作区指纹未变（review 只读硬校验）
 *   - ship（V0.6.1）：task.mrs 覆盖所有 repoPath（每仓 1 条 url 非空）、或 artifact 说明跳过原因
 *   - 退役类型：历史记录仍可能出现在磁盘、runActionCheck 走 default 跳过
 *   - custom：artifact 落盘非空
 *   - chat 不走本机制（chat 是独立 mode、不复用 action 体系、详见 chat-runner.ts）
 *
 * 关于 CheckRun（跑 typecheck / lint 等项目命令）的历史决策（2026-07-03 用户拍板删）：
 *   V0.6.3 写死 pnpm 检查（多技术栈误报）→ 撤；V0.6.25 改「用户 per-repo 配命令」复活（含 ship gate
 *   override 留痕、污染检测、--fix 预判等一整套）→ v0.9.13 整套删除。根因是语义错配：全仓检查问的是
 *   「项目是不是绿的」、但存量项目基线本来就红（历史债）、agent 只改两个文件也永远红 → 红色失去信息量、
 *   还连带 ship 每次都要 override 填原因。方向通用化后（非研发用户）这套「研发流程假设」也不再成立。
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

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { ActionRecord, Task } from "@/lib/types";

import { getActionArtifactPath } from "./task-fs-core";
import {
  getTaskCwd,
  getTaskWorkRepoPaths,
  isTaskReadonlyRepo,
} from "./task-worktrees";

export interface ActionCheckResult {
  passed: boolean;
  details: string;
}

/**
 * 读 action artifact、对 ENOENT 做短退避重试（2026-07-16 用户实测竞态误报）：
 * agent 调 submit_work 交卷与 artifact 写盘可能只差一瞬——后置检查立即读会 ENOENT
 * 挂红条、但几百 ms 后文件就在（UI 侧 artifact 面板早有同款退避重试、这里补齐）。
 * 只重试 ENOENT（文件还没落盘）；其它错误（权限等）立即抛、按原逻辑报失败。
 */
const readArtifactWithRetry = async (absPath: string): Promise<string> => {
  const delays = [500, 1000, 2000, 4000];
  for (let i = 0; ; i++) {
    try {
      return await fs.readFile(absPath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" || i >= delays.length) throw err;
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
};

export type ReadonlyRepoBaseline = {
  porcelain: string;
  /** null = 无 upstream、跳过 ahead 比对 */
  ahead: string | null;
};

// 主入口：跑给定 action 的 deterministic 检查（v0.9.13 起全是轻量 fs / git 检查、同步 await 即可）
export const runActionCheck = async (
  task: Task,
  action: ActionRecord,
): Promise<ActionCheckResult> => {
  try {
    let typeResult: ActionCheckResult;
    switch (action.type) {
      case "plan":
        typeResult = await checkPlan(task, action);
        break;
      case "build":
        typeResult = await checkBuild(task, action);
        break;
      case "review":
        typeResult = await checkReview(task, action);
        break;
      case "ship":
        typeResult = await checkShip(task, action);
        break;
      case "dev":
        typeResult = await checkDev(task, action);
        break;
      case "custom":
        typeResult = await checkCustom(task, action);
        break;
      default: {
        const _: never = action.type;
        typeResult = {
          passed: true,
          details: `未知 action 类型：${String(_)}、跳过`,
        };
      }
    }
    // 只读仓后置检测：所有 action 类型通用；失败细节拼到 type 检查结果后
    const readonlyResult = await checkReadonlyRepos(task, action);
    if (!readonlyResult.passed) {
      return {
        passed: false,
        details: typeResult.passed
          ? readonlyResult.details
          : `${typeResult.details}；${readonlyResult.details}`,
      };
    }
    return typeResult;
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
    content = await readArtifactWithRetry(absPath);
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
    content = await readArtifactWithRetry(absPath);
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
  // V0.10：隔离 task 的 cwd = worktree（agent 实际干活的地方、HEAD 在这里才是对的）
  const cwd = getTaskCwd(task);
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
  // 只读仓不走指纹（允许 pull / 切提测分支会动工作树内容）——改由 checkReadonlyRepos 守。
  if (action.startBaseline) {
    const touched: string[] = [];
    // V0.10：隔离 task 的基线 key = worktree 路径（captureActionStartBaseline 同口径）
    const workPaths = getTaskWorkRepoPaths(task);
    for (let i = 0; i < workPaths.length; i++) {
      const repoPath = workPaths[i];
      if (isTaskReadonlyRepo(task, task.repoPaths[i])) continue;
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
    content = await readArtifactWithRetry(absPath);
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

// ----------------- dev（联调、V0.x）-----------------
//
// 联调两种推送方式（action.devPushMode）：
//   - direct（直推）：本地 merge dev + 推 origin/dev、无 MR。推送 / 流水线结果 ai-flow 不追、
//     信任 agent 在 artifact 自述——这里不做 MR 维度门禁、只校验有产出（artifactPath）。
//   - mr（提 PR）：建 feature→dev 的 MR、复用 ship 同款门禁（URL 非空 + 冲突拦），文案换成联调 / dev。
// 不做 ship 那套「每仓缺 MR 必须写跳过说明」的强校验——联调更轻、不强制覆盖所有仓、避免误拦。
const checkDev = async (
  task: Task,
  action: ActionRecord,
): Promise<ActionCheckResult> => {
  if (!action.artifactPath) {
    return { passed: false, details: "联调没产出 artifact" };
  }
  const mrRecords = action.sideEffects?.mrs ?? [];

  // 无 MR：直推模式（或提 PR 模式跳过了所有仓）——无 MR 维度可验、信任 artifact 自述、放行。
  if (mrRecords.length === 0) {
    return {
      passed: true,
      details:
        action.devPushMode === "mr"
          ? "联调（提 PR）：本次没记录到 MR、按 artifact 自述处理（可能所有仓都跳过了）"
          : "联调（直推）：无 MR、推送 / 流水线结果见 artifact",
    };
  }

  // 有 MR（提 PR 模式）：URL 非空 + 无冲突（同 ship 门禁、文案换成联调 / dev）。
  const sections: string[] = [];
  let allPassed = true;

  const missingUrl = mrRecords.filter(
    (m) => !m.mrUrl || m.mrUrl.trim().length === 0,
  );
  if (missingUrl.length > 0) {
    allPassed = false;
    sections.push(
      `❌ ${missingUrl.length} 条联调 MR 记录 URL 为空（${missingUrl
        .map((m) => m.repoPath)
        .join(", ")}）`,
    );
  } else {
    sections.push(
      `✅ ${mrRecords.length} 条联调 MR、URL 都非空：\n${mrRecords
        .map((m) => `   - ${m.repoPath}（v${m.mrVersion}）: ${m.mrUrl}`)
        .join("\n")}`,
    );
  }

  // 跟 dev 分支有冲突 → 联调不算干净完成（同 ship 冲突门禁）、用户解完重跑。
  const conflictMrs = mrRecords.filter((m) => m.hasConflicts === true);
  if (conflictMrs.length > 0) {
    allPassed = false;
    sections.push(
      `❌ ${conflictMrs.length} 条联调 MR 跟 dev 有冲突、需用户手动解决后重跑：\n${conflictMrs
        .map((m) => `   - ${m.repoPath}（v${m.mrVersion}）: ${m.mrUrl}`)
        .join("\n")}`,
    );
  }

  return {
    passed: allPassed,
    details: sections.join("\n\n"),
  };
};

// ----------------- custom（V0.9 自定义 action）-----------------
//
// 后置检查 = artifact 基本盘（产出非空）。
// 不强制 artifact 必备段（custom 的 playbook 由用户自定义、没有固定骨架）。
const checkCustom = async (
  task: Task,
  action: ActionRecord,
): Promise<ActionCheckResult> => {
  if (!action.artifactPath) {
    return { passed: false, details: "自定义 action 没产出 artifact" };
  }
  const absPath = getActionArtifactPath(task.id, action.n, action.type);
  let content: string;
  try {
    content = await readArtifactWithRetry(absPath);
  } catch (err) {
    return {
      passed: false,
      details: `自定义 action artifact 读取失败：${absPath}（${err instanceof Error ? err.message : String(err)}）`,
    };
  }
  if (content.trim().length === 0) {
    return { passed: false, details: "自定义 action artifact 为空" };
  }
  return { passed: true, details: "自定义 action artifact 已落盘" };
};

// ----------------- 内部 git 执行底座（fingerprint / status hash 用）-----------------
//
// V0.11.x 跨平台改造：原来用 `sh -c` 跑多行 POSIX 脚本拼指纹——Windows 没有 `sh`、
// `2>/dev/null` 也不是 cmd 语法、整套在 Windows 静默失效（fingerprint 恒返 null、
// review 只读硬校验 / 兄弟仓越权检测形同虚设）。改成纯 Node 逐条 execFile git：
// 平台无关、无 shell 注入面、也不再需要自拼 PATH（原 buildCheckEnv 的 unix bin
// 目录 + `:` 分隔符在 Windows 反而会把 PATH 首项写坏）。

const execFileAsync = promisify(execFile);

// 单段输出上限：tracked diff 可能巨大、20MB 兜底防打爆内存（超限 execFile 抛错 →
// 该段视为采不到、整个指纹返 null = 「无法比对、不拦」、fail-open 同旧行为）
const FINGERPRINT_PART_CAP = 20 * 1024 * 1024;

// 跑一条 git 命令、成功返 stdout、失败（非 git 仓 / 超时 / 输出超限）返 null
const gitCapture = async (
  repoPath: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoPath,
      timeout: timeoutMs,
      maxBuffer: FINGERPRINT_PART_CAP,
    });
    return stdout;
  } catch {
    return null;
  }
};

// `git hash-object --stdin-paths`：把 untracked 路径列表从 stdin 喂进去、拿逐文件内容 hash。
// 唯一需要写 stdin 的调用、单独用 spawn（execFile 不便喂 stdin）；出错 / 超时返空串（best-effort）
const gitHashObjectStdinPaths = (
  repoPath: string,
  pathsInput: string,
): Promise<string> =>
  new Promise((resolve) => {
    const proc = spawn("git", ["hash-object", "--stdin-paths"], {
      cwd: repoPath,
      windowsHide: true,
    });
    let out = "";
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    }, 30_000);
    proc.stdout?.on("data", (d) => {
      out += String(d);
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    proc.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
    // 路径里的文件被并发删掉时 git 会提前退出、stdin 写入报 EPIPE——吞掉、close 兜底 resolve
    proc.stdin?.on("error", () => {});
    proc.stdin?.end(pathsInput);
  });

// 该仓「工作区内容指纹」= sha256(headCommit + tracked diff + untracked 路径 + untracked 内容 hash)
// review 启动基线记录、结束后重算比对——不一致 = review 期间工作区被改（违反 review 只读铁律）。
// 覆盖：tracked 改 / staged / 删除 / 新增 untracked 文件 / untracked 内容变化——
// `git diff HEAD` 不含 untracked 文件内容、所以单独对 untracked 逐文件 hash-object；
// `--exclude-standard` 排除 gitignore（coverage/cache/node_modules 不算进指纹）。
// 非 git 仓 / 空仓无 HEAD / 异常 → null（视为「无法比对、不拦」）。
export const computeWorktreeFingerprint = async (
  repoPath: string,
): Promise<string | null> => {
  const head = await gitCapture(repoPath, ["rev-parse", "HEAD"]);
  if (head === null) return null; // 非 git 仓 / 无 HEAD（同旧 __NOGIT__ 分支）
  const diff = await gitCapture(repoPath, [
    "diff",
    "--no-ext-diff",
    "--binary",
    "HEAD",
    "--",
  ]);
  if (diff === null) return null; // diff 采不到（超限 / 异常）→ 指纹不可信、不拦
  const upaths =
    (await gitCapture(repoPath, ["ls-files", "--others", "--exclude-standard"])) ?? "";
  const uhashes =
    upaths.trim().length > 0
      ? await gitHashObjectStdinPaths(repoPath, upaths)
      : "";
  return createHash("sha256")
    .update(head)
    .update("__DIFF__")
    .update(diff)
    .update("__UPATHS__")
    .update(upaths)
    .update("__UHASHES__")
    .update(uhashes)
    .digest("hex");
};

// ----------------- build -----------------
//
// v0.9.13 起不再跑项目命令（CheckRun 删除、见文件头历史决策）——
// 只查 agent 交付诚实性：artifact 落盘 + 必备段 + 兄弟仓越权检测。
const checkBuild = async (
  task: Task,
  action: ActionRecord,
): Promise<ActionCheckResult> => {
  const sections: string[] = [];
  let artifactLintPassed = true;

  // V0.6.27 artifact 小节 lint：「全量校验」是 build 骨架铁段。
  // 「修改记录」检查已删（2026-07-13 用户拍板）：骨架本来就允许初稿省略该段、
  // 检查却当铁段必查 → 一次过的正常 build 全被误判「缺必备段」、v1.1.8 红条
  // 实装后线上冤枉同事初稿——该段有没有交给人审、不值得机器闸。
  if (action.artifactPath) {
    try {
      const artifactContent = await readArtifactWithRetry(
        getActionArtifactPath(task.id, action.n, action.type),
      );
      const requiredSections: { name: string; re: RegExp }[] = [
        { name: "全量校验", re: /全量校验/ },
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

  if (artifactLintPassed && sections.length === 0) {
    sections.push("build artifact 已落盘、必备段齐全");
  }

  return {
    passed: artifactLintPassed,
    details: sections.join("\n\n"),
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
  const out = await gitCapture(
    repoPath,
    ["status", "--porcelain", "--untracked-files=all"],
    15_000,
  );
  if (out === null) return null;
  return createHash("sha256").update(out).digest("hex");
};

// 发现 effective cwd 下「非本 task 的兄弟 git 仓」（多仓 cwd = 公共父目录时才有）
// V0.10：隔离 task 的 cwd = worktrees/<taskId>/（或多 git 容器）、下面只挂本 task 的仓、天然无兄弟仓（返空）
// 混合隔离后 getTaskCwd 只聚合 git worktree：单 git(+非 git) cwd=worktree 自身 → 早退返空；
// 多 git(+非 git) cwd=容器 → 只扫容器、非 git 原路径不在容器下、不会误当兄弟。
const discoverSiblingRepos = async (task: Task): Promise<string[]> => {
  const cwd = getTaskCwd(task);
  const taskRepoSet = new Set(
    getTaskWorkRepoPaths(task).map((p) => path.resolve(p)),
  );
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
 * - review：task 各仓的 worktreeFingerprint（跳过只读仓——允许 pull / 切提测、改由 readonlyBaseline 守）
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
      // V0.10：隔离 task 指纹按 worktree 路径采（agent 实际工作区、key 跟 checkReview 对齐）
      const workPaths = getTaskWorkRepoPaths(task);
      const entries = await Promise.all(
        workPaths.map(async (p, i) => {
          // 只读仓不采指纹（pull / 切提测会误报）
          if (isTaskReadonlyRepo(task, task.repoPaths[i])) return null;
          const fp = await computeWorktreeFingerprint(p);
          return fp !== null ? ([p, fp] as const) : null;
        }),
      );
      const map = Object.fromEntries(
        entries.filter((e): e is [string, string] => e !== null),
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

/**
 * 采单个仓的只读检测快照：porcelain + ahead-of-upstream。
 * 无 upstream 时 ahead=null（检查端跳过该项、避免误报）。
 */
const captureReadonlyRepoState = async (
  workDir: string,
): Promise<ReadonlyRepoBaseline | null> => {
  const status = await runShell("git", ["status", "--porcelain"], workDir, 30_000);
  if (status.notFound || status.exitCode !== 0) return null;
  // @{u} 在没设 upstream 时会非 0——记 null 跳过 ahead 比对（允许切到无跟踪的提测分支）
  const aheadRes = await runShell(
    "git",
    ["log", "@{u}..HEAD", "--oneline"],
    workDir,
    30_000,
  );
  const ahead = aheadRes.exitCode === 0 ? aheadRes.stdout.trim() : null;
  return { porcelain: status.stdout.trimEnd(), ahead };
};

/**
 * 纯函数：比对只读仓基线 vs 当前状态，返失败说明列表（空 = 通过）。
 * - porcelain 相对基线变脏 / 变了 → fail（列当前脏文件）
 * - ahead 相对基线多出 commit → fail（列多出的 commit）
 * - 不比 HEAD 本身（pull / 切提测分支会动 HEAD、不能误报）
 */
export const diffReadonlyRepoState = (
  baseline: ReadonlyRepoBaseline,
  current: ReadonlyRepoBaseline,
): string[] => {
  const fails: string[] = [];
  if (
    current.porcelain !== baseline.porcelain &&
    current.porcelain.trim().length > 0
  ) {
    const files = current.porcelain
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 20);
    fails.push(`工作区被改脏：${files.join("、") || "（有未提交改动）"}`);
  }
  if (
    current.ahead !== null &&
    baseline.ahead !== null &&
    current.ahead !== baseline.ahead &&
    current.ahead.trim().length > 0
  ) {
    const baseSet = new Set(
      baseline.ahead
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
    const extra = current.ahead
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !baseSet.has(l))
      .slice(0, 20);
    if (extra.length > 0) {
      fails.push(`本地多出 upstream 没有的 commit：${extra.join("、")}`);
    } else if (current.ahead.trim().length > 0) {
      fails.push(
        `本地相对 upstream 的 commit 集合相对启动时有变化：${current.ahead
          .split("\n")
          .filter(Boolean)
          .slice(0, 10)
          .join("、")}`,
      );
    }
  } else if (
    current.ahead !== null &&
    baseline.ahead === null &&
    current.ahead.trim().length > 0
  ) {
    fails.push(
      `本地多出 upstream 没有的 commit：${current.ahead
        .split("\n")
        .filter(Boolean)
        .slice(0, 20)
        .join("、")}`,
    );
  }
  return fails;
};

/**
 * 任务含只读仓时、action 启动前采每个只读仓基线（存 ActionRecord.readonlyBaseline）。
 * 无只读仓 / 全失败 → undefined。
 */
export const captureReadonlyRepoBaselines = async (
  task: Task,
): Promise<Record<string, ReadonlyRepoBaseline> | undefined> => {
  try {
    const readonlyPaths = task.readonlyRepoPaths ?? [];
    if (readonlyPaths.length === 0) return undefined;
    const workPaths = getTaskWorkRepoPaths(task);
    const map: Record<string, ReadonlyRepoBaseline> = {};
    for (let i = 0; i < task.repoPaths.length; i++) {
      const original = task.repoPaths[i];
      if (!readonlyPaths.includes(original)) continue;
      const state = await captureReadonlyRepoState(workPaths[i]);
      if (state) map[original] = state;
    }
    return Object.keys(map).length > 0 ? map : undefined;
  } catch (err) {
    console.warn(
      `[action-check] captureReadonlyRepoBaselines 异常（跳过）task=${task.id}：`,
      err,
    );
    return undefined;
  }
};

/** 交卷后置：比对只读仓是否被改动（所有 action 类型） */
const checkReadonlyRepos = async (
  task: Task,
  action: ActionRecord,
): Promise<ActionCheckResult> => {
  const readonlyPaths = task.readonlyRepoPaths ?? [];
  if (readonlyPaths.length === 0) {
    return { passed: true, details: "" };
  }
  const baseline = action.readonlyBaseline;
  // 启动时没采到基线 → fail-open（别因采集失败挡交卷）
  if (!baseline || Object.keys(baseline).length === 0) {
    return { passed: true, details: "" };
  }
  const workPaths = getTaskWorkRepoPaths(task);
  const failParts: string[] = [];
  for (let i = 0; i < task.repoPaths.length; i++) {
    const original = task.repoPaths[i];
    const base = baseline[original];
    if (!base) continue;
    const current = await captureReadonlyRepoState(workPaths[i]);
    if (!current) continue;
    const diffs = diffReadonlyRepoState(base, current);
    if (diffs.length > 0) {
      const tail = original.split("/").filter(Boolean).pop() ?? original;
      failParts.push(`${tail}（${diffs.join("；")}）`);
    }
  }
  if (failParts.length === 0) {
    return { passed: true, details: "" };
  }
  return {
    passed: false,
    details: `只读仓被改动：${failParts.join("；")}`,
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
    // windowsHide：Windows 上从无控制台的 GUI 进程（Electron 壳）起 console 子进程
    // 会闪黑框、CREATE_NO_WINDOW 压掉（mac/linux 无此概念、传了无副作用）
    const proc = spawn(cmd, args, { cwd, shell: false, windowsHide: true });
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
