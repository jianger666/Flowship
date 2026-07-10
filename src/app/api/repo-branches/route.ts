/**
 * /api/repo-branches?path=<绝对路径>
 *
 *   GET → 列该目录的 git 分支候选（本地 + 远端合并去重）、返 RepoBranchList
 *
 * v0.9.11 设置页仓库分支字段 / 任务 dialog「已有工作分支」的下拉数据源。
 *
 * 跟 /api/tasks/[id]/branches 的差异：那边做 checkout（写操作）、路径必须走 task 权威数据防越权；
 * 这边纯只读列 refs（for-each-ref 不改任何状态）、且设置页配仓库时 task 还不存在、
 * 必须按前端传的路径查——本机单用户桌面 app、只读操作接受任意绝对路径可接受。
 */

import { NextResponse } from "next/server";

import { listRepoBranches } from "@/lib/server/git-branches";
import { isWindowsAbsPath } from "@/lib/path-utils";

export const runtime = "nodejs";

export const GET = async (req: Request) => {
  const path = new URL(req.url).searchParams.get("path")?.trim() ?? "";
  // 绝对路径校验必须兼容 Windows 盘符（`D:\...`）——V0.14.x 踩过：只认 `/` 开头、
  // Windows 仓库全部 400、前端把 400 归一成「非 git 仓库」、git 探测压根没执行
  if (!path.startsWith("/") && !isWindowsAbsPath(path)) {
    return NextResponse.json(
      { error: "path 必须是绝对路径" },
      { status: 400 },
    );
  }
  const result = await listRepoBranches(path);
  return NextResponse.json(result);
};
