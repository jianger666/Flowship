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
  getTaskWithTailEvents,
  setTaskDisabledMcpServers,
  setTaskModel,
  setTaskPinned,
  setTaskRepoPaths,
  setTaskUiLayout,
  updateTaskFields,
} from "@/lib/server/task-fs";
import { MAX_EVENTS_TAIL } from "@/lib/server/task-fs-core";
import { abortRunningCheck, cancelTaskRun } from "@/lib/server/task-runner";
import {
  isTaskStarting,
  pendingStopRequests,
  revokeTaskOps,
  waitForTaskToStop,
} from "@/lib/server/task-stream";
import { cancelChatRun, waitForChatToStop } from "@/lib/server/chat-runner";
import { cleanupChatQueueState, clearChatQueue } from "@/lib/server/chat-queue";
import { clearChatContextUsage } from "@/lib/server/chat-context-usage";
import {
  beginChatLifecycle,
  cancelChatStart,
  clearChatGate,
  endChatLifecycle,
  isChatRewindInProgress,
} from "@/lib/server/chat-gate";
import { cleanupChatTaskState } from "@/lib/server/chat-pending";
import { cleanupCheckpointRefsForTask } from "@/lib/server/chat-checkpoint";
import type { ModelSelection } from "@/lib/types";

/** DELETE 等 rewind 退出的轮询间隔 / 上限（T2） */
const DELETE_REWIND_POLL_MS = 100;
const DELETE_REWIND_WAIT_MS = 30_000;
/** U1：等 Agent.create/send 飞行窗口退出（waitFor* 只等可见 record） */
const DELETE_STARTING_POLL_MS = 100;
const DELETE_STARTING_WAIT_MS = 8_000;

interface Ctx {
  params: Promise<{ id: string }>;
}

export const GET = async (req: Request, { params }: Ctx) => {
  try {
    const { id } = await params;
    // v1.0.x 事件懒加载：?tail=N 只带最近 N 条（尾部反向读、不整文件 parse）。
    // 切了片就置 eventsTruncated、客户端据此开「上拉加载更早」；更早的走 GET events?before= 分页。
    const tailRaw = new URL(req.url).searchParams.get("tail");
    const tailParsed = tailRaw ? Number.parseInt(tailRaw, 10) : NaN;
    if (Number.isFinite(tailParsed) && tailParsed > 0) {
      const tail = Math.min(tailParsed, MAX_EVENTS_TAIL);
      const task = await getTaskWithTailEvents(id, tail);
      if (!task) return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ task });
    }
    // 无 tail：真全量（诊断 / 旧客户端）
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

    // V0.6.6：编辑任务的建任务字段（title / feishuStoryUrl / repoFeatureBranches、可一次传多个）
    // V0.6.28：+ addRepoPaths 追加仓库（只增不删、新仓快照随行）
    const editKeys = [
      "title",
      "feishuStoryUrl",
      "repoFeatureBranches",
      "addRepoPaths",
    ] as const;
    if (editKeys.some((k) => k in body)) {
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
  const { id } = await params;

  // T1：任何 await 之前先占 deleting——收尾窗口内禁止新预约覆盖 cancelled lease。
  // 同 phase 重入（并发 DELETE）→ 409，勿 end 别人的 deleting。
  const beganDeleting = beginChatLifecycle(id, "deleting");
  if (!beganDeleting) {
    return NextResponse.json({ error: "任务正在删除" }, { status: 409 });
  }

  try {
    // V12：立刻 revoke——已入场的 advance/one-shot 在目录被删后不得继续 ensureWorkspace/create
    revokeTaskOps(id);
    // T2：等 rewind 事务退出后再 clearChatGate / 清 refs / 删目录，
    // 避免替仍在跑的 rewind「释放」门闩并与仓库恢复交叉。
    if (isChatRewindInProgress(id)) {
      const deadline = Date.now() + DELETE_REWIND_WAIT_MS;
      while (isChatRewindInProgress(id)) {
        if (Date.now() >= deadline) {
          // 出口 rewind 超时：释放 deleting，任务仍在
          endChatLifecycle(id, "deleting");
          return NextResponse.json(
            { error: "正在回退到检查点、请稍后再删" },
            { status: 409 },
          );
        }
        await new Promise<void>((r) => setTimeout(r, DELETE_REWIND_POLL_MS));
      }
    }

    // 先停 task agent + 清 pending、再删文件
    // 顺序很重要：删了文件 agent 还在跑会写不到 events.jsonl 报错
    // chat task 的 run 在 chat-runner 的 runningChats、cancelTaskRun 停不到、两个都试（同 stop route）
    if (!cancelTaskRun(id)) cancelChatRun(id);
    clearChatQueue(id);
    // S1：撤销启动 lease（标 cancelled），占位后、runChatSession 注册前的窗口里
    // DELETE 到达时 owner 能感知并中止（勿只 release——旧请求无从发现）。
    cancelChatStart(id);
    cleanupChatTaskState(id);
    // V0.8.18：连带杀掉可能还在后台跑的后置 check 子进程（删 task 后 check 跑完也无处落、防孤儿）
    abortRunningCheck(id);
    // cancel 只是发信号、run 的 finally 还会写 events.jsonl——不等它真退就 rm、
    // 迟到的写入会跟递归删除撞车（目录被删一半 + ENOTEMPTY）、表现为
    // 「第一次删失败、点进任务内容已被清空、再删一次才成功」。没活 run 时秒过。
    await waitForTaskToStop(id, 8000);
    await waitForChatToStop(id, 8000);
    // U1：waitFor* 只等可见 record；Agent.create 飞行中无 record 会秒过——
    // 再轮询等 startingTasks 退出，超时打 warn 继续（pendingStop 仍在、启动链会自裁）
    if (isTaskStarting(id)) {
      const deadline = Date.now() + DELETE_STARTING_WAIT_MS;
      while (isTaskStarting(id)) {
        if (Date.now() >= deadline) {
          console.warn(
            `[DELETE /api/tasks/[id]] startingTasks 等待超时 task=${id}、继续删（pendingStop 仍在、启动链会自裁）`,
          );
          break;
        }
        await new Promise<void>((r) => setTimeout(r, DELETE_STARTING_POLL_MS));
      }
    }
    // U1：无飞行消费者时才清 pending——飞行中的启动链需要标记自裁
    if (!isTaskStarting(id)) {
      pendingStopRequests.delete(id);
    }
    // 复审（11 轮）：queue generation / context usage 只增不删——删任务时一并清，
    // 防长跑进程 Map 积键（须在 waitForChatToStop 之后、活跃 drain 已退出）
    cleanupChatQueueState(id);
    clearChatContextUsage(id);
    // U2：deleting gate 必须持有到 deleteTask 成功之后——此前 clear 会开闸让
    // chat-reply 在 refs 清理 / 物理删除窗口内重新预约并起新 Agent。
    // 删任务数据目录前清各仓 checkpoint refs；否则被删任务的 tree/blob 会永久留在用户仓
    await cleanupCheckpointRefsForTask(id).catch((err) => {
      console.warn(
        `[DELETE /api/tasks/[id]] cleanupCheckpointRefs 失败 task=${id}:`,
        err instanceof Error ? err.message : err,
      );
    });
    const ok = await deleteTask(id);
    if (!ok) {
      // 出口 not_found：task 还在，只释放 deleting lifecycle（其余 gate 键保留）
      endChatLifecycle(id, "deleting");
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    // 出口 success：物理删完才清全部门闩（含 deleting / cancelled lease / rewind 键）
    clearChatGate(id);
    // W1：故意不 clear generation——保留 tombstone 防 ABA（无键默认 0 会让旧 snap 复活）；
    // task id 不复用，Map 留 string+number 可忽略
    return NextResponse.json({ ok: true });
  } catch (err) {
    // 出口异常：必须释放 deleting，否则任务永远卡在 deleting → 后续请求全 409
    endChatLifecycle(id, "deleting");
    console.error("[DELETE /api/tasks/[id]] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};
