/**
 * GET /api/repo-files?taskId=&q=&root=
 *
 * composer `@` 文件模糊搜索数据源：
 * - taskId 必填，root 必须是该 task.repoPaths 之一（防路径穿越扫任意盘）
 * - root 省略 = 扫 task 全部 repoPaths（多仓）
 * - q 文件名 / 路径模糊，上限 50 条；首次扫描按 root 缓存 60s
 */

import { NextResponse } from "next/server";

import { isAbsolutePathLike } from "@/lib/path-utils";
import { errorResponse } from "@/lib/server/route-helpers";
import {
  normalizeRepoRoot,
  REPO_FILES_Q_MAX_LEN,
  searchTaskRepoFiles,
} from "@/lib/server/repo-files";
import { getTask } from "@/lib/server/task-fs";

export const runtime = "nodejs";

const isSafeId = (id: string): boolean => /^[a-zA-Z0-9_-]+$/.test(id);

export const GET = async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const taskId = sp.get("taskId")?.trim() ?? "";
  const q = sp.get("q")?.trim() ?? "";
  const rootRaw = sp.get("root")?.trim() ?? "";

  if (!taskId) {
    return errorResponse("taskId 必填");
  }
  // 与 tool-output 路由一致：非法 id 直接 400，避免 sanitizeId 抛错变 500
  if (!isSafeId(taskId)) {
    return errorResponse("非法 taskId");
  }
  if (q.length > REPO_FILES_Q_MAX_LEN) {
    return errorResponse(`q 最长 ${REPO_FILES_Q_MAX_LEN} 字符`);
  }

  const task = await getTask(taskId);
  if (!task) {
    return errorResponse("任务不存在", 404);
  }
  if (task.repoPaths.length === 0) {
    return NextResponse.json({ files: [] });
  }

  const allowed = new Set(task.repoPaths.map(normalizeRepoRoot));
  let root: string | undefined;
  if (rootRaw) {
    if (!isAbsolutePathLike(rootRaw)) {
      return errorResponse("root 必须是绝对路径");
    }
    root = normalizeRepoRoot(rootRaw);
    if (!allowed.has(root)) {
      return errorResponse("root 不属于本任务的工作目录");
    }
  }

  const files = await searchTaskRepoFiles(task.repoPaths, q, { root });
  return NextResponse.json({ files });
};
