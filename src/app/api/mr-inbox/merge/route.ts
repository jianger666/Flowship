/**
 * POST /api/mr-inbox/merge —— 收件箱直接合并 MR
 *
 * body: { mrUrl: string }
 * host / projectPath / iid 全部从 MR URL 解析（不依赖任务仓库推导）；
 * token 用 settings.gitToken。成功后把该 MR 从收件箱缓存剔除（UI 立即一致）。
 *
 * 安全：MR host 必须落在 settings.repos 各仓 remote 推导的 allowlist 内，
 * 否则 4xx、绝不带 PAT 出站（防评论植入 evil host SSRF / 凭证外泄）。
 */

import { NextResponse } from "next/server";

import { parseGitlabMrUrl, shouldAttachGitlabToken } from "@/lib/mr-inbox";
import { mergeMR } from "@/lib/server/gitlab-client";
import {
  collectGitlabHostAllowlist,
  markBugMrMergedInCache,
  removeMrFromInboxCache,
} from "@/lib/server/mr-inbox-scanner";
import { errorResponse } from "@/lib/server/route-helpers";
import { readSettingsFile } from "@/lib/server/settings-fs";

export const runtime = "nodejs";

export const POST = async (req: Request) => {
  let body: { mrUrl?: unknown };
  try {
    body = await req.json();
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }
  const mrUrl = typeof body.mrUrl === "string" ? body.mrUrl.trim() : "";
  if (!mrUrl) return errorResponse("缺少 mrUrl");

  const parsed = parseGitlabMrUrl(mrUrl);
  if (!parsed) return errorResponse("MR URL 无法解析");

  const settingsResult = await readSettingsFile();
  const settings =
    settingsResult.status === "ok" ? settingsResult.settings : null;
  const gitToken =
    settings && typeof settings.gitToken === "string"
      ? settings.gitToken.trim()
      : "";
  if (!gitToken) {
    return errorResponse("未配置 GitLab Token、请先到设置页配置", 400);
  }

  const allowedHosts = await collectGitlabHostAllowlist(settings);
  if (!shouldAttachGitlabToken(parsed.host, allowedHosts)) {
    return errorResponse(
      "MR 所属 GitLab 不在已配置仓库允许列表、拒绝合并",
      400,
    );
  }

  try {
    const result = await mergeMR({
      config: { host: parsed.host, token: gitToken },
      projectPath: parsed.projectPath,
      iid: parsed.iid,
    });
    if (!result.ok) {
      return errorResponse(result.error, 502);
    }
    // 合并成功：从待测 MR 组剔除；待回归 bug 行只清 MR 关联（bug 本身还在）
    removeMrFromInboxCache(parsed.canonicalUrl);
    markBugMrMergedInCache(parsed.canonicalUrl);
    return NextResponse.json({ ok: true, mrUrl: parsed.canonicalUrl });
  } catch (err) {
    console.error("[POST /api/mr-inbox/merge] failed", err);
    return errorResponse(err instanceof Error ? err.message : String(err), 500);
  }
};
