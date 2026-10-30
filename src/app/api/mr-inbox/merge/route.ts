/**
 * POST /api/mr-inbox/merge —— 收件箱直接合并 MR
 *
 * body: { mrUrl: string; sha?: string }
 * sha = 用户看到「可合并」那次扫描时源分支的 HEAD 提交：带上则 GitLab 只在 HEAD 仍是它时才合并，
 * 作者之后又推了新提交就回 409、提示刷新（GAP3-02）；不带 = 沿用旧行为。
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
import { assertTrustedGitHost } from "@/lib/server/trusted-git-host";
import { isMergeShaMismatch } from "@/lib/mr-merge-error";

export const runtime = "nodejs";

export const POST = async (req: Request) => {
  let body: { mrUrl?: unknown; sha?: unknown };
  try {
    body = await req.json();
  } catch {
    return errorResponse("请求体不是合法 JSON");
  }
  const mrUrl = typeof body.mrUrl === "string" ? body.mrUrl.trim() : "";
  if (!mrUrl) return errorResponse("缺少 mrUrl");

  const parsed = parseGitlabMrUrl(mrUrl);
  if (!parsed) return errorResponse("MR URL 无法解析");

  // sha 可选；给了就必须像个提交哈希（别把任意字符串塞进 GitLab 请求体）
  let sha: string | undefined;
  if (body.sha !== undefined && body.sha !== null && body.sha !== "") {
    if (typeof body.sha !== "string" || !/^[0-9a-f]{7,64}$/i.test(body.sha.trim())) {
      return errorResponse("sha 必须是 7–64 位十六进制提交哈希");
    }
    sha = body.sha.trim();
  }

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
  // allowlist 来自仓库 origin（agent 可写）——再对照首次绑定的可信 host / config 白名单，
  // 不一致就拒绝、不带 PAT 出站（trusted-git-host.ts）
  try {
    assertTrustedGitHost(parsed.host);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : String(err), 400);
  }

  try {
    const result = await mergeMR({
      config: { host: parsed.host, token: gitToken },
      projectPath: parsed.projectPath,
      iid: parsed.iid,
      ...(sha ? { sha } : {}),
    });
    if (!result.ok) {
      // 带了 sha 而被拒、且错误指向「HEAD 不匹配」：作者在扫描之后又推了新提交——给人话、409，别当 502 网关错误
      if (sha && isMergeShaMismatch(result.error)) {
        return errorResponse(
          "该 MR 在你上次刷新之后有了新提交，为避免把没看过的改动一并合入，已拒绝合并。请刷新收件箱、确认后再合并",
          409,
        );
      }
      return errorResponse(result.error, 502);
    }
    // 合并成功：从待测 MR 组剔除；待回归 bug 行只清 MR 关联（bug 本身还在）
    removeMrFromInboxCache(parsed.canonicalUrl);
    markBugMrMergedInCache(parsed.canonicalUrl);
    return NextResponse.json({
      ok: true,
      mrUrl: parsed.canonicalUrl,
      // 双击 / 两个窗口 / 别人先合了：GitLab 回 405、补查发现已是 merged——目的已达成，按成功处理（缓存照样剔除），
      // 带上标记让前端换一句更准的话（Q10-05）
      ...(result.alreadyMerged ? { alreadyMerged: true } : {}),
    });
  } catch (err) {
    console.error("[POST /api/mr-inbox/merge] failed", err);
    return errorResponse(err instanceof Error ? err.message : String(err), 500);
  }
};
