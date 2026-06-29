/**
 * submit_mr server 端范围校验（P0-2 harness、V0.6.27 从 task-runner 拆出）
 *
 * 背景：submit_mr 的 repo_path / project_path / source / target 都由 agent 传入、
 *   早期 handler 直接拿去 createMR()。agent 幻觉 / prompt 被污染 / remote 解析出错时、
 *   可能用 server 端 PAT 给任意有权限的 GitLab project 创建 MR。
 * 解法：server 端按 task 权威数据 + 该仓真实 git remote 校验 agent 上报、越权直接拒。
 *
 * 拆出理由：这是安全关键纯逻辑（除 git remote 读取外零 IO）、单测要直接 import 它、
 *   不能把 2400 行的 task-runner 拖进测试运行时（它 import SDK / MCP / SSE 一大串）。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ChatTaskAction } from "./chat-mcp";
import type { Task } from "../types";

const execFileAsync = promisify(execFile);

// 从仓库本地 git remote 反解 GitLab project path（如 wkid/crm-web）、跟 agent 上报对账。
// 解析规则跟 action-ship.md 里 agent 用的 sed 对齐（git@host:group/proj.git / https://host/group/proj.git）。
// 拿不到（非 git 仓 / 无 origin / 命令失败）返 null、调用方对 null 放行（best-effort、不因临时读不到挡 ship）。
export const deriveProjectPathFromRepo = async (
  repoPath: string,
): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["config", "--get", "remote.origin.url"],
      { cwd: repoPath, timeout: 10_000 },
    );
    const url = stdout.trim();
    if (!url) return null;
    return parseProjectPathFromRemoteUrl(url);
  } catch {
    return null;
  }
};

// remote URL → project path 纯函数（拆出便于单测：git@ / https:// / 边角输入）
export const parseProjectPathFromRemoteUrl = (url: string): string | null => {
  const projectPath = url
    .replace(/^[^@]+@[^:]+:/, "") // git@host:
    .replace(/^https?:\/\/[^/]+\//, "") // https://host/
    .replace(/\.git$/, "")
    .trim();
  return projectPath.length > 0 ? projectPath : null;
};

// 校验 agent 上报的 submit_mr 参数是否在本 task 的授权范围内。
// 不通过 = 越权 / agent 上报错、handler 直接拒、不调 GitLab。
export const validateSubmitMr = async (
  task: Task,
  a: Extract<ChatTaskAction, { kind: "submit_mr" }>,
): Promise<{ ok: true } | { ok: false; error: string }> => {
  // 1) repo_path 必须属于本 task（核心：agent 不能对 task 范围外的仓提 MR）
  if (!task.repoPaths.includes(a.repoPath)) {
    return {
      ok: false,
      error: `repo_path ${a.repoPath} 不属于本 task（合法仓：${task.repoPaths.join(", ") || "无"}）`,
    };
  }
  // 2) action_id 必须是本 task 的 ship / dev / custom action（防把 MR 挂到错 action / 非提交阶段）
  //    ship = 提测（→测试分支）、dev = 联调提 PR（→dev 分支）、custom = 任意自定义 action（→该仓 base 分支）、
  //    三者共用 submit_mr 同一通道（custom 是 V0.9.2「受控放开」加的、对所有自定义 action 一视同仁、详见下方 target 校验）
  const action = task.actions.find((x) => x.id === a.actionId);
  if (
    !action ||
    (action.type !== "ship" &&
      action.type !== "dev" &&
      action.type !== "custom")
  ) {
    return {
      ok: false,
      error: `action_id ${a.actionId} 不是本 task 的 ship / dev / custom action`,
    };
  }
  // 3) target_branch 按 action 类型校验（受控放开、每种只放行「该仓对应那一个分支」、仍挡死任意分支）：
  //    - 提测（ship）→ 该仓测试分支（默认 test）
  //    - 联调（dev）→ 该仓 dev 分支（必须显式配）
  //    - 自定义（custom、任意自定义 action）→ 该仓 base 分支（线上/基线、必须显式配）
  //      ⚠️ 这是唯一能提到线上分支的口子：仅对 custom 类型放行、且只放行「该仓 base 分支」这一个值，
  //         ship/dev 仍一律禁止提 master（原安全语义不变）。custom 仍受闸 1/4/5 约束（仓范围 / source 必须 feature / project 对账）。
  const expectedTarget =
    action.type === "dev"
      ? task.repoDevBranches?.[a.repoPath]?.trim()
      : action.type === "custom"
        ? task.repoBaseBranches?.[a.repoPath]?.trim()
        : task.repoTestBranches?.[a.repoPath]?.trim() || "test";
  if (!expectedTarget) {
    const branchKind = action.type === "custom" ? "base（线上/基线）" : "dev";
    return {
      ok: false,
      error: `该仓没配 ${branchKind} 分支、无法提 MR（请去设置页给该仓配 ${branchKind} 分支）：${a.repoPath}`,
    };
  }
  if (a.targetBranch !== expectedTarget) {
    const branchKind =
      action.type === "dev"
        ? " dev 分支"
        : action.type === "custom"
          ? " base（线上/基线）分支"
          : "测试分支";
    return {
      ok: false,
      error: `target_branch 必须是该仓${branchKind}「${expectedTarget}」、收到「${a.targetBranch}」（不许提到其它分支）`,
    };
  }
  // 4) source_branch 必须是该仓 feature 分支、或一次性 <feature>__conflict 解冲突分支
  const known = task.gitBranches?.find((b) => b.repoPath === a.repoPath)?.name;
  if (known) {
    if (a.sourceBranch !== known && a.sourceBranch !== `${known}__conflict`) {
      return {
        ok: false,
        error: `source_branch 必须是「${known}」或「${known}__conflict」、收到「${a.sourceBranch}」`,
      };
    }
  } else if (!a.sourceBranch.trim() || a.sourceBranch === expectedTarget) {
    // gitBranches 没记这仓（如没 feishuStoryUrl 没建 branch）→ 退化兜底：至少非空且不等于目标分支
    return {
      ok: false,
      error: `source_branch 非法（空 / 等于目标分支）：「${a.sourceBranch}」`,
    };
  }
  // 5) project_path 必须 == server 从该仓真实 git remote 反解出的（防越权提到任意 project）
  const derived = await deriveProjectPathFromRepo(a.repoPath);
  if (derived && a.projectPath !== derived) {
    return {
      ok: false,
      error: `project_path「${a.projectPath}」跟该仓真实 remote 反解「${derived}」不一致、拒绝（防越权提到其它 GitLab project）`,
    };
  }
  return { ok: true };
};
