/**
 * /api/tasks
 *
 *   GET  → 任务列表
 *   POST → 创建任务（body: NewTaskInput）
 *
 * V0.6.0.1 改造：
 *   - 重新引入 mode（"task" | "chat"、对齐 V0.5 概念）
 *   - mode="task"：正经 feature task、title / repoPaths / feishuStoryUrl 三必填
 *   - mode="chat"：自由对话、title / repoPaths / feishuStoryUrl 全选填（title 缺省自动补「未命名对话 MM-DD HH:mm」）
 *
 * 路由只做 IO + 校验、状态推进 / 业务规则归 task-fs.ts。
 */

import { NextResponse } from "next/server";
import { createTask, listTasks } from "@/lib/server/task-fs";
import type {
  CheckCommand,
  NewTaskInput,
  TaskMode,
  TaskRole,
} from "@/lib/types";

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const sanitizeRepoPaths = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  return v
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => p.trim());
};

const sanitizeRole = (v: unknown): TaskRole | undefined => {
  if (v === "fe" || v === "be" || v === "adaptive") return v;
  return undefined;
};

const sanitizeMode = (v: unknown): TaskMode => {
  return v === "chat" ? "chat" : "task";
};

// V0.6.3：per-repo 分支映射清洗（线上分支 / 已有工作分支共用）。只收 plain object + string value、去空
const sanitizeRepoBranchMap = (
  v: unknown,
): Record<string, string> | undefined => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string" && val.trim()) out[k] = val.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

// V0.6.25：per-repo check 命令 map 粗清洗（只收 plain object + value 是含 name/cmd 的对象数组）
// 细清洗（trim / 限定 repoPaths / required 缺省）交给 task-fs.createTask
const sanitizeRepoCheckCommands = (
  v: unknown,
): Record<string, CheckCommand[]> | undefined => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, CheckCommand[]> = {};
  for (const [repo, cmds] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(cmds)) continue;
    const cleaned = cmds.filter(
      (c): c is CheckCommand =>
        !!c &&
        typeof c === "object" &&
        typeof (c as CheckCommand).name === "string" &&
        typeof (c as CheckCommand).cmd === "string",
    );
    if (cleaned.length > 0) out[repo] = cleaned;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

export const GET = async () => {
  try {
    const tasks = await listTasks();
    return NextResponse.json({ tasks });
  } catch (err) {
    console.error("[GET /api/tasks] failed", err);
    return NextResponse.json({ error: "list_failed" }, { status: 500 });
  }
};

export const POST = async (req: Request) => {
  try {
    const body = (await req.json()) as Partial<NewTaskInput>;

    const mode = sanitizeMode(body.mode);
    const isChat = mode === "chat";

    // chat 模式三选填、其他模式三必填
    if (!isChat) {
      if (!isNonEmptyString(body.title)) {
        return NextResponse.json({ error: "title 必填" }, { status: 400 });
      }
      if (!isNonEmptyString(body.feishuStoryUrl)) {
        return NextResponse.json(
          { error: "feishuStoryUrl 必填" },
          { status: 400 },
        );
      }
    }

    const repoPaths = sanitizeRepoPaths(body.repoPaths);
    if (!isChat && repoPaths.length === 0) {
      return NextResponse.json(
        { error: "repoPaths 至少 1 个仓库" },
        { status: 400 },
      );
    }

    // chat 模式未填 title 时自动生成「对话 · MM-DD HH:mm」（侧栏窄、标题尽量短）
    const title = isNonEmptyString(body.title)
      ? body.title.trim()
      : isChat
        ? `对话 · ${new Date().toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`
        : "";

    const task = await createTask({
      title,
      repoPaths,
      role: sanitizeRole(body.role),
      mode,
      repoBaseBranches: sanitizeRepoBranchMap(body.repoBaseBranches),
      repoFeatureBranches: sanitizeRepoBranchMap(body.repoFeatureBranches),
      // V0.6.25 修 pre-existing bug：V0.6.7 的 test/dev/模板 三个 per-repo 快照之前在 route 层漏接、
      // new-task-dialog 快照了但没落库（ship 提测目标分支一直回退 default test）、一并补上
      repoTestBranches: sanitizeRepoBranchMap(body.repoTestBranches),
      repoDevBranches: sanitizeRepoBranchMap(body.repoDevBranches),
      repoBranchTemplates: sanitizeRepoBranchMap(body.repoBranchTemplates),
      // V0.6.25 CheckRun：per-repo 校验命令快照
      repoCheckCommands: sanitizeRepoCheckCommands(body.repoCheckCommands),
      feishuStoryUrl: isNonEmptyString(body.feishuStoryUrl)
        ? body.feishuStoryUrl.trim()
        : undefined,
      disabledMcpServers:
        Array.isArray(body.disabledMcpServers) &&
        body.disabledMcpServers.every((s) => typeof s === "string")
          ? body.disabledMcpServers
          : undefined,
      model: body.model,
    });
    return NextResponse.json({ task }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/tasks] failed", err);
    return NextResponse.json({ error: "create_failed" }, { status: 500 });
  }
};
