/**
 * /api/tasks/[id]
 *
 *   GET    → 单任务详情（含 events + 各 action artifact）
 *   PATCH  → 元数据修改（pinned / disabledMcpServers / uiLayout / V0.6.6 建任务字段）
 *   DELETE → 删除任务（连带 data/tasks/<id>/ 整个文件夹）
 *
 * V0.6 改造：cancelChat → cancelTaskRun（task-runner）
 *
 * Next.js 15 的 dynamic route params 是 Promise、要 await
 */

import { NextResponse } from "next/server";
import {
  deleteTask,
  getTask,
  setTaskDisabledMcpServers,
  setTaskModel,
  setTaskPinned,
  setTaskRepoPaths,
  setTaskUiLayout,
  updateTaskFields,
} from "@/lib/server/task-fs";
import { abortRunningCheck, cancelTaskRun } from "@/lib/server/task-runner";
import { waitForTaskToStop } from "@/lib/server/task-stream";
import { cancelChatRun, waitForChatToStop } from "@/lib/server/chat-runner";
import { cleanupChatTaskState } from "@/lib/server/chat-pending";
import { isTaskRole, TASK_ROLES } from "@/lib/types";
import type { ModelSelection, TaskRole } from "@/lib/types";

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = async (_req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    const task = await getTask(id);
    if (!task) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ task });
  } catch (err) {
    console.error("[GET /api/tasks/[id]] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};

export const PATCH = async (req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    const body = (await req.json()) as {
      pinned?: boolean;
      disabledMcpServers?: string[] | null;
      uiLayout?: { artifactPanelSize?: number } | null;
      // V0.6.24：chat 模式切模型（持久化 task.model、下一个 run 生效）
      model?: ModelSelection;
      // V0.8：chat 模式选工作目录（替换 task.repoPaths、下一个 run 生效）
      repoPaths?: string[];
      // V0.6.6：编辑任务字段（详情页编辑弹窗、可一次传多个）
      title?: string;
      role?: TaskRole;
      feishuStoryUrl?: string | null;
      repoFeatureBranches?: Record<string, string> | null;
      // V0.6.28：中途追加仓库（只增不删）+ 新仓的 per-repo 快照（前端从 settings 取好传来）
      addRepoPaths?: string[];
      addRepoBaseBranches?: Record<string, string>;
      addRepoTestBranches?: Record<string, string>;
      addRepoDevBranches?: Record<string, string>;
      addRepoBranchTemplates?: Record<string, string>;
    };

    if (typeof body.pinned === "boolean") {
      const task = await setTaskPinned(id, body.pinned);
      if (!task)
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ task });
    }

    if ("disabledMcpServers" in body) {
      const value = body.disabledMcpServers;
      if (
        value !== null &&
        !(Array.isArray(value) && value.every((s) => typeof s === "string"))
      ) {
        return NextResponse.json(
          { error: "disabledMcpServers 必须是字符串数组或 null" },
          { status: 400 },
        );
      }
      const task = await setTaskDisabledMcpServers(
        id,
        value === null ? undefined : value,
      );
      if (!task)
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ task });
    }

    if ("uiLayout" in body) {
      const value = body.uiLayout;
      if (value === null) {
        await setTaskUiLayout(id, undefined);
        return NextResponse.json({ ok: true });
      }
      if (
        typeof value !== "object" ||
        (value.artifactPanelSize !== undefined &&
          typeof value.artifactPanelSize !== "number")
      ) {
        return NextResponse.json(
          { error: "uiLayout.artifactPanelSize 必须是数字或 undefined" },
          { status: 400 },
        );
      }
      await setTaskUiLayout(id, value);
      // 不返完整 task：高频拖动期间 round-trip 全量没必要、前端 state 已经是源头
      return NextResponse.json({ ok: true });
    }

    // V0.6.24：chat 切模型——只认 { id: 非空字符串 }、params 可选
    if ("model" in body) {
      const m = body.model;
      if (
        !m ||
        typeof m !== "object" ||
        typeof m.id !== "string" ||
        !m.id.trim()
      ) {
        return NextResponse.json(
          { error: "model 必须是 { id: 非空字符串 }" },
          { status: 400 },
        );
      }
      const task = await setTaskModel(id, m);
      if (!task)
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ task });
    }

    // V0.8：chat 模式选工作目录——替换 repoPaths（必须字符串数组、空数组 = 不绑工作目录）
    if ("repoPaths" in body) {
      const value = body.repoPaths;
      if (!Array.isArray(value) || !value.every((p) => typeof p === "string")) {
        return NextResponse.json(
          { error: "repoPaths 必须是字符串数组" },
          { status: 400 },
        );
      }
      const task = await setTaskRepoPaths(id, value);
      if (!task)
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ task });
    }

    // V0.6.6：编辑任务的建任务字段（title / role / feishuStoryUrl / repoFeatureBranches、可一次传多个）
    // V0.6.28：+ addRepoPaths 追加仓库（只增不删、新仓快照随行）
    const editKeys = [
      "title",
      "role",
      "feishuStoryUrl",
      "repoFeatureBranches",
      "addRepoPaths",
    ] as const;
    if (editKeys.some((k) => k in body)) {
      // 共享 guard（CR-07）：原手写白名单漏了 adaptive、自适应任务连改标题都 400
      if ("role" in body && !isTaskRole(body.role)) {
        return NextResponse.json(
          { error: `role 必须是 ${TASK_ROLES.join(" / ")}` },
          { status: 400 },
        );
      }
      if ("title" in body && typeof body.title !== "string") {
        return NextResponse.json(
          { error: "title 必须是字符串" },
          { status: 400 },
        );
      }
      if (
        "addRepoPaths" in body &&
        !(
          Array.isArray(body.addRepoPaths) &&
          body.addRepoPaths.every((p) => typeof p === "string" && p.trim())
        )
      ) {
        return NextResponse.json(
          { error: "addRepoPaths 必须是非空字符串数组" },
          { status: 400 },
        );
      }
      const task = await updateTaskFields(id, {
        title: body.title,
        role: body.role,
        feishuStoryUrl: body.feishuStoryUrl,
        repoFeatureBranches: body.repoFeatureBranches,
        addRepoPaths: body.addRepoPaths,
        addRepoBaseBranches: body.addRepoBaseBranches,
        addRepoTestBranches: body.addRepoTestBranches,
        addRepoDevBranches: body.addRepoDevBranches,
        addRepoBranchTemplates: body.addRepoBranchTemplates,
      });
      if (!task)
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ task });
    }

    return NextResponse.json(
      {
        error: "需要 pinned / disabledMcpServers / uiLayout / 编辑字段 之一",
      },
      { status: 400 },
    );
  } catch (err) {
    console.error("[PATCH /api/tasks/[id]] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};

export const DELETE = async (_req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    // 先停 task agent + 清 pending、再删文件
    // 顺序很关键：删了文件 agent 还在跑会写不到 events.jsonl 报错
    // chat task 的 run 在 chat-runner 的 runningChats、cancelTaskRun 停不到、两个都试（同 stop route）
    if (!cancelTaskRun(id)) cancelChatRun(id);
    cleanupChatTaskState(id);
    // V0.8.18：连带杀掉可能还在后台跑的后置 check 子进程（删 task 后 check 跑完也无处落、防孤儿）
    abortRunningCheck(id);
    // cancel 只是发信号、run 的 finally 还会写 events.jsonl——不等它真退就 rm、
    // 迟到的写入会跟递归删除撞车（目录被删一半 + ENOTEMPTY）、表现为
    // 「第一次删失败、点进任务内容已被清空、再删一次才成功」。没活 run 时秒过。
    await waitForTaskToStop(id, 8000);
    await waitForChatToStop(id, 8000);
    const ok = await deleteTask(id);
    if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[DELETE /api/tasks/[id]] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};
