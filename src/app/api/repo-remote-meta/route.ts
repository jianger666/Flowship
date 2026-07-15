/**
 * GET /api/repo-remote-meta?path=... 或 ?paths=a,b
 *
 * 从仓库 origin remote 推导 GitLab host / project path（推进 dialog 用）。
 * 多仓 host 不一致时返回 error（与 resolveEffectiveGitHost fail-fast 同口径）。
 */
import { NextResponse } from "next/server";

import {
  MULTI_GITLAB_HOST_ERROR,
  pickUnifiedGitHost,
} from "@/lib/server/gitlab-host";
import {
  deriveHostFromRepo,
  deriveProjectPathFromRepo,
} from "@/lib/server/submit-mr-guard";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

export const GET = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const single = url.searchParams.get("path")?.trim();
  const multi =
    url.searchParams
      .get("paths")
      ?.split(",")
      .map((p) => p.trim())
      .filter(Boolean) ?? [];
  const paths = single
    ? [single, ...multi.filter((p) => p !== single)]
    : multi;
  if (paths.length === 0) {
    return errorResponse("缺少 path 或 paths 参数", 400);
  }

  const hosts: Record<string, string | null> = {};
  const projectPaths: Record<string, string | null> = {};
  let projectPath: string | null = null;

  for (const repoPath of paths) {
    const [h, pp] = await Promise.all([
      deriveHostFromRepo(repoPath),
      deriveProjectPathFromRepo(repoPath),
    ]);
    hosts[repoPath] = h;
    projectPaths[repoPath] = pp;
    if (!projectPath && pp) projectPath = pp;
  }

  let host: string | null = null;
  let error: string | undefined;
  try {
    host = pickUnifiedGitHost(Object.values(hosts));
  } catch (err) {
    // 多实例不一致：host 置空 + 文案给 UI（推进弹窗灰 ship 卡）
    host = null;
    error =
      err instanceof Error && err.message === MULTI_GITLAB_HOST_ERROR
        ? MULTI_GITLAB_HOST_ERROR
        : err instanceof Error
          ? err.message
          : MULTI_GITLAB_HOST_ERROR;
  }

  return NextResponse.json({ host, projectPath, hosts, projectPaths, error });
};
