/**
 * 旁路合 test MR（服务端执行、test 分支专用）。
 *
 * 背景：群里开发可能直接甩一个 test MR 让机器人合。旁路 agent 手里没有 GitLab
 * 写凭证（P0-2：config.json 含 gitToken，绝不同步给旁路），所以合并动作不在
 * agent 侧做（shell 里 curl 更不允许），而是由这个工具在服务端执行：
 * token 只活在服务端内存里，绝不进 prompt / 上下文 / 事件流。
 *
 * 三道闸（按顺序，缺一不可）：
 * 1. MR host 必须落在 settings.repos 各仓 remote 推导的 allowlist 内
 *   （与 mr-inbox 合并同口径，防评论植入 evil host 骗 token 出站）；
 * 2. 拉 MR 详情看目标分支：只合测试分支（各仓 testBranch、默认 test）；
 * 3. 线上分支（各仓 onlineBranch、默认 main/master/production）一律拒绝，
 *    非测试非线上的一律拒绝——默认拒绝，找属主。
 *
 * 返回永远是人话文本（成功或失败原因），模型负责转述 + 失败时指引找属主。
 */

import { Object as TBObject, String as TBString } from "typebox/type";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { parseGitlabMrUrl, shouldAttachGitlabToken } from "@/lib/mr-inbox";

import { getMR, mergeMR } from "./gitlab-client";
import { collectGitlabHostAllowlist } from "./mr-inbox-scanner";
import { readSettingsFile } from "./settings-fs";

/** 没配测试分支的仓回退到这个（与 ship / submit_mr 口径一致） */
export const BYPASS_DEFAULT_TEST_BRANCH = "test";
/** 没配线上分支的仓按这三个认（大小写不敏感比） */
const COMMON_PROD_BRANCHES = ["main", "master", "production"];

/** settings.repos[] 里抠分支配置（字段缺/坏就跳过，不抛） */
export const collectBypassBranchSets = (
  settings: Record<string, unknown> | null,
): { testBranches: string[]; prodBranches: string[] } => {
  const test = new Set<string>([BYPASS_DEFAULT_TEST_BRANCH]);
  const prod = new Set<string>(COMMON_PROD_BRANCHES);
  const repos = settings && Array.isArray(settings.repos) ? settings.repos : [];
  for (const repo of repos) {
    if (!repo || typeof repo !== "object") continue;
    const o = repo as { testBranch?: unknown; onlineBranch?: unknown };
    if (typeof o.testBranch === "string" && o.testBranch.trim()) {
      test.add(o.testBranch.trim());
    }
    if (typeof o.onlineBranch === "string" && o.onlineBranch.trim()) {
      prod.add(o.onlineBranch.trim());
    }
  }
  return { testBranches: [...test], prodBranches: [...prod] };
};

/**
 * 目标分支守卫（纯函数、可单测）。
 * 线上优先拒绝（配了也算、顺带大小写不敏感）；测试分支放行；其余默认拒绝。
 */
export const checkMergeTestTarget = (
  targetBranch: string,
  sets: { testBranches: string[]; prodBranches: string[] },
): { ok: boolean; reason?: string } => {
  const target = targetBranch.trim();
  if (!target) return { ok: false, reason: "MR 目标分支为空，合并不了。" };
  const lower = target.toLowerCase();
  if (sets.prodBranches.some((b) => b.toLowerCase() === lower)) {
    return {
      ok: false,
      reason: `不能合：目标分支 ${target} 是线上分支，合并 MR 需要任务所有者确认。`,
    };
  }
  if (sets.testBranches.some((b) => b === target || b.toLowerCase() === lower)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `不能合：只合目标为测试分支（${sets.testBranches.join(" / ")}）的 MR，${target} 不在里面，需要合请找任务所有者。`,
  };
};

/** 服务端合 test MR 全流程（token 不出服务端）：ok=合上了，text=给模型转述的人话 */
export const mergeTestMrForBypass = async (
  mrUrl: string,
): Promise<{ ok: boolean; text: string }> => {
  const parsed = parseGitlabMrUrl(mrUrl.trim());
  if (!parsed) {
    return {
      ok: false,
      text: "合 test MR 失败：MR URL 无法解析（要完整的 /-/merge_requests/<id> 链接）。",
    };
  }
  const settingsResult = await readSettingsFile();
  const settings =
    settingsResult.status === "ok"
      ? (settingsResult.settings as unknown as Record<string, unknown>)
      : null;
  const gitToken =
    settings && typeof settings.gitToken === "string"
      ? settings.gitToken.trim()
      : "";
  if (!gitToken) {
    return {
      ok: false,
      text: "合 test MR 失败：Flowship 未配置 GitLab Token，请找任务所有者确认。",
    };
  }
  const allowedHosts = await collectGitlabHostAllowlist(settings);
  if (!shouldAttachGitlabToken(parsed.host, allowedHosts)) {
    return {
      ok: false,
      text: "合 test MR 失败：MR 所属 GitLab 不在已配置仓库允许列表，拒绝合并。",
    };
  }
  const config = { host: parsed.host, token: gitToken };
  const detail = await getMR({
    config,
    projectPath: parsed.projectPath,
    iid: parsed.iid,
  });
  if (!detail.ok) {
    return {
      ok: false,
      text: `合 test MR 失败：MR 详情拉取失败（${detail.error}），请找任务所有者确认。`,
    };
  }
  if (detail.state !== "opened") {
    return { ok: false, text: `不用合：该 MR 当前状态是 ${detail.state}。` };
  }
  const guard = checkMergeTestTarget(
    detail.targetBranch,
    collectBypassBranchSets(settings),
  );
  if (!guard.ok) {
    return { ok: false, text: `合 test MR 失败：${guard.reason ?? "目标分支不允许"}` };
  }
  const merged = await mergeMR({
    config,
    projectPath: parsed.projectPath,
    iid: parsed.iid,
  });
  if (!merged.ok) {
    return {
      ok: false,
      text: `合 test MR 失败：${merged.error}（可能是冲突或流水线没过），请找任务所有者确认。`,
    };
  }
  return {
    ok: true,
    text: `test MR 已合并：!${merged.iid}（${detail.sourceBranch} → ${detail.targetBranch}）${merged.url}`,
  };
};

/** 旁路 customTools：merge_test_mr（只读轮次白名单的一员，见 pi-coding-tools） */
export const buildMergeTestMrTool = (): ToolDefinition =>
  ({
    name: "merge_test_mr",
    label: "合 test MR",
    description:
      "合目标为测试分支的 MR（服务端执行：只合 test 这类测试分支，线上分支 main/master/production 一律拒绝）。入参 mrUrl=群里给的完整 MR 链接。返回成功或失败原因（已关闭/有冲突/流水线没过等），失败就让对方找任务所有者。",
    parameters: TBObject({ mrUrl: TBString() }),
    execute: async (_toolCallId: string, params: unknown) => {
      const p = params as { mrUrl?: unknown };
      const mrUrl = typeof p.mrUrl === "string" ? p.mrUrl.trim() : "";
      if (!mrUrl) {
        return {
          content: [{ type: "text", text: "合 test MR 失败：缺少 mrUrl（要完整的 MR 链接）。" }],
          details: undefined,
        };
      }
      const r = await mergeTestMrForBypass(mrUrl);
      return {
        content: [{ type: "text", text: r.text }],
        details: { ok: r.ok },
      };
    },
  }) as unknown as ToolDefinition;
