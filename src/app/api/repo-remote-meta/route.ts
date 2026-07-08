/**
 * GET /api/repo-remote-meta?path=... 或 ?paths=a,b
 *
 * 从仓库 origin remote 推导 GitLab host / project path（设置页 GitLab 自动检测、推进 dialog 用）。
 */
import { NextResponse } from "next/server";

import { deriveHostFromRepo, deriveProjectPathFromRepo } from "@/lib/server/submit-mr-guard";
import { errorResponse } from "@/lib/server/route-helpers";

export const runtime = "nodejs";

export const GET = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const single = url.searchParams.get("path")?.trim();
  const multi = url.searchParams.get("paths")?.split(",").map((p) => p.trim()).filter(Boolean) ?? [];
  const paths = single ? [single, ...multi.filter((p) => p !== single)] : multi;
  if (paths.length === 0) {
    return errorResponse("缺少 path 或 paths 参数", 400);
  }

  const hosts: Record<string, string | null> = {};
  const projectPaths: Record<string, string | null> = {};
  let host: string | null = null;
  let projectPath: string | null = null;

  for (const repoPath of paths) {
    const [h, pp] = await Promise.all([
      deriveHostFromRepo(repoPath),
      deriveProjectPathFromRepo(repoPath),
    ]);
    hosts[repoPath] = h;
    projectPaths[repoPath] = pp;
    if (!host && h) host = h;
    if (!projectPath && pp) projectPath = pp;
  }

  return NextResponse.json({ host, projectPath, hosts, projectPaths });
};
