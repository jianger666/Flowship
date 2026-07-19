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

import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import {
  commitDeletionJournal,
  commitReadableTaskResponse,
  deleteTask,
  getTask,
  getTaskWithTailEvents,
  hasDurableDeleteDescriptor,
  probeDeleteTombstone,
  readDeletionJournal,
  recoverDeletedTaskArtifacts,
  removeDeletionJournal,
  rollbackDeletionJournalIfTaskDirRemains,
  setTaskDisabledMcpServers,
  setTaskModel,
  setTaskPinned,
  setTaskRepoPaths,
  setTaskUiLayout,
  updateTaskFields,
  writeDeleteTombstone,
  writeDeletionJournal,
} from "@/lib/server/task-fs";
import { MAX_EVENTS_TAIL, readMetaV06, taskDir } from "@/lib/server/task-fs-core";
import { failpoint } from "@/lib/server/failpoints";
import { abortRunningCheck, cancelTaskRun } from "@/lib/server/task-runner";
import {
  hasResourceJobs,
  isTaskStarting,
  joinResourceJobs,
  markWorkspaceQuarantined,
  pendingStopRequests,
  publishTaskStreamEvent,
  revokeResourceJobs,
  revokeTaskOps,
  waitForTaskToStop,
} from "@/lib/server/task-stream";
import { cancelChatRun, waitForChatToStop } from "@/lib/server/chat-runner";
import { cleanupChatQueueState, failQueuedItems } from "@/lib/server/chat-queue";
import { clearChatContextUsage } from "@/lib/server/chat-context-usage";
import {
  beginChatLifecycle,
  cancelChatStart,
  clearChatGate,
  endChatLifecycle,
  isChatRewindInProgress,
} from "@/lib/server/chat-gate";
import { cleanupChatTaskState } from "@/lib/server/chat-pending";
import { clearActionSideEffects } from "@/lib/server/action-side-effects";
import {
  cleanupCheckpointRefsFromManifest,
  resolveCheckpointRefManifestForDelete,
  type CheckpointRefManifest,
} from "@/lib/server/chat-checkpoint";
import type { ModelSelection } from "@/lib/types";

/** DELETE 等 rewind 退出的轮询间隔 / 上限（T2） */
const DELETE_REWIND_POLL_MS = 100;
const DELETE_REWIND_WAIT_MS = 30_000;
/** U1：等 Agent.create/send 飞行窗口退出（waitFor* 只等可见 record） */
const DELETE_STARTING_POLL_MS = 100;
const DELETE_STARTING_WAIT_MS = 8_000;

/**
 * R32-6 / R33-6：仅物理目录已消失且 refs 无 pending 时才删 journal。
 * EBUSY 降级 / refs 失败 → 留 journal 给 boot 重试。
 */
const removeDeletionJournalIfFullyDone = async (
  taskId: string,
  refsAllSucceeded: boolean,
): Promise<void> => {
  if (!refsAllSucceeded) return;
  // R34-7 / R35-4：manifest 未确认 / journal 读未知 → 绝不删 journal
  const journal = await readDeletionJournal(taskId);
  if (journal.kind === "unknown") {
    console.error(
      `[DELETE /api/tasks/[id]] R35-4 removeJournal: 读未知、保留 task=${taskId}`,
      journal.error,
    );
    return;
  }
  if (journal.kind === "present" && journal.value.manifestPending) return;
  try {
    await fs.access(taskDir(taskId));
    // 目录仍在（典型：Windows EBUSY 降级 tombstone）→ 保留 journal
  } catch {
    await removeDeletionJournal(taskId);
  }
};

/** R34-1：已提交删除事务 → 202 recoveryPending（鼓励前滚、禁止 4xx 诱使重试破坏） */
const recoveryPendingResponse = () =>
  NextResponse.json(
    { ok: true, recoveryPending: true },
    { status: 202 },
  );

/**
 * R34-7 / R35-3：解析删除用 manifest。
 * 可信任务快照（入场读到的 meta.repoPaths）在 commit 前写入 journal——durable descriptor 核心。
 */
const prepareDeleteManifest = async (
  taskId: string,
): Promise<CheckpointRefManifest> => {
  // R35-3：DELETE 入场尽早读可信快照，供 manifestPending 时持久化
  const meta = await readMetaV06(taskId).catch(() => null);
  const snapshotRepoPaths = (meta?.repoPaths ?? []).filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  // 不传 fallback——有 meta 时先 rewind 构建；fallback 仅留给 journal 恢复（taskDir 已 rm）
  const resolved = await resolveCheckpointRefManifestForDelete(taskId);
  if (resolved.ok) {
    const repoPaths =
      resolved.manifest.repoPaths && resolved.manifest.repoPaths.length > 0
        ? resolved.manifest.repoPaths
        : snapshotRepoPaths;
    return {
      ...resolved.manifest,
      phase: "prepared",
      repoPaths,
      ...(resolved.manifest.confirmedEmpty || repoPaths.length === 0
        ? { confirmedEmpty: true }
        : {}),
    };
  }
  console.warn(
    `[DELETE /api/tasks/[id]] R34-7 manifest 未确认 task=${taskId}: ${resolved.error}`,
  );
  return {
    deletedAt: Date.now(),
    checkpointRefs: [],
    phase: "prepared",
    manifestPending: true,
    // R35-3：快照拿得到就写入；拿不到 = unknown（空），禁止随后 rm 最后恢复源
    repoPaths: snapshotRepoPaths,
  };
};

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
      // R34-3：helper 与 Response 之间可插入删除——failpoint + 提交点同步复查
      await failpoint("httpRead.afterHelper");
      if (!task) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      return commitReadableTaskResponse(id, () => ({ task }));
    }
    // 无 tail：真全量（诊断 / 旧客户端）
    const task = await getTask(id);
    await failpoint("httpRead.afterHelper");
    if (!task) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return commitReadableTaskResponse(id, () => ({ task }));
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
    // R33-1：删任务清队也走唯一终态 sink——已 202 的排队消息发 queue_failed（deleted）、
    // 前端按 itemId 清占位（原裸 clearChatQueue 会留幽灵 pending）
    failQueuedItems(id, { reason: "deleted" });
    // S1：撤销启动 lease（标 cancelled），占位后、runChatSession 注册前的窗口里
    // DELETE 到达时 owner 能感知并中止（勿只 release——旧请求无从发现）。
    cancelChatStart(id);
    cleanupChatTaskState(id);
    // R29-C：清 action 屏障 Map——防 DELETE 后工具 wait 永久挂死泄漏
    clearActionSideEffects(id);
    // V0.8.18：连带杀掉可能还在后台跑的后置 check 子进程（删 task 后 check 跑完也无处落、防孤儿）
    abortRunningCheck(id);
    // cancel 只是发信号、run 的 finally 还会写 events.jsonl——不等它真退就 rm、
    // 迟到的写入会跟递归删除撞车（目录被删一半 + ENOTEMPTY）、表现为
    // 「第一次删失败、点进任务内容已被清空、再删一次才成功」。没活 run 时秒过。
    await waitForTaskToStop(id, 8000);
    await waitForChatToStop(id, 8000);
    // U1 / R29-2 / R30-2：waitFor* 只等可见 record；Agent.create 飞行中无 record 会秒过——
    // 先 revokeResourceJobs，再 join starting + resourceJobs。
    // R30-2：resourceJobs 超时 → quarantine，目录删除延迟到 job 归零（不再开闸硬删）。
    let resourceJoinTimedOut = false;
    if (isTaskStarting(id) || hasResourceJobs(id)) {
      revokeResourceJobs(id);
      const startingDeadline = Date.now() + DELETE_STARTING_WAIT_MS;
      while (isTaskStarting(id) && Date.now() < startingDeadline) {
        await new Promise<void>((r) => setTimeout(r, DELETE_STARTING_POLL_MS));
      }
      if (isTaskStarting(id)) {
        console.warn(
          `[DELETE /api/tasks/[id]] starting 等待超时 task=${id}、继续（resource 另判）`,
        );
      }
      if (hasResourceJobs(id)) {
        // 省略 timeoutMs → 与 finalize/stop 共用 getResourceJoinTimeoutMs / 测试 override
        const join = await joinResourceJobs(id, {
          pollMs: DELETE_STARTING_POLL_MS,
        });
        resourceJoinTimedOut = join === "timeout";
        if (resourceJoinTimedOut) {
          console.error(
            `[DELETE /api/tasks/[id]] R30-2：resourceJobs join 超时 task=${id}、已 quarantine；目录删除延迟到 job 归零`,
          );
        }
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

    // R35-4：进入写 journal / tombstone 前探针——已提交或证据读未知 → 只前滚、禁止重写 prepared
    const priorJournal = await readDeletionJournal(id);
    const priorTomb = await probeDeleteTombstone(id);
    if (priorJournal.kind === "unknown" || priorTomb.kind === "unknown") {
      publishTaskStreamEvent(id, { kind: "task_deleted", taskId: id });
      clearChatGate(id);
      console.error(
        `[DELETE /api/tasks/[id]] R35-4 入场证据读未知、recoveryPending task=${id}`,
        priorJournal.kind === "unknown"
          ? priorJournal.error
          : priorTomb.kind === "unknown"
            ? priorTomb.error
            : undefined,
      );
      return recoveryPendingResponse();
    }
    if (
      (priorJournal.kind === "present" &&
        priorJournal.value.phase === "committed") ||
      priorTomb.kind === "present"
    ) {
      publishTaskStreamEvent(id, { kind: "task_deleted", taskId: id });
      clearChatGate(id);
      void recoverDeletedTaskArtifacts(id).catch((e) =>
        console.error(
          `[DELETE /api/tasks/[id]] R35-4 已提交重入 recovery 失败 task=${id}`,
          e,
        ),
      );
      return recoveryPendingResponse();
    }

    // R30-2 / R31-3 / R32-6 / R33-5：quarantine 场景——先 prepared→tombstone→committed，再 HTTP 200；
    // deleting lifecycle 保持到后台物理删完；job 归零后再清 refs + deleteTask（refs 失败留 journal）。
    if (resourceJoinTimedOut || hasResourceJobs(id)) {
      if (!resourceJoinTimedOut) {
        // 防御：starting 超时窗口外 resource 又冒出来
        markWorkspaceQuarantined(id);
      }
      // R31-3 / R32-6 / R33-5：返回 200 之前必须先形成 durable committed logical delete
      await writeDeleteTombstone(id);
      // R33-4：逻辑删除已提交 → 通知既有 watcher 关流（非删除发起 tab 也停）
      publishTaskStreamEvent(id, { kind: "task_deleted", taskId: id });
      void (async () => {
        try {
          while (hasResourceJobs(id)) {
            await new Promise<void>((r) => setTimeout(r, 200));
          }
          // R33-6：recover 内按 journal 清 refs；失败写回 refsPending、不假成功删 journal
          await recoverDeletedTaskArtifacts(id);
          clearChatGate(id);
        } catch (err) {
          endChatLifecycle(id, "deleting");
          console.error(
            `[DELETE /api/tasks/[id]] R30-2：延迟删除异常 task=${id}`,
            err,
          );
        }
      })();
      return NextResponse.json({ ok: true });
    }

    // U2：deleting gate 必须持有到 deleteTask 成功之后——此前 clear 会开闸让
    // chat-reply 在 refs 清理 / 物理删除窗口内重新预约并起新 Agent。
    // R33-5 / R34-1：快速路径 prepared → committed（不可逆前）→ refs → rm；
    // committed 之后任何失败只前滚，不再回滚 journal。
    // R35-3：durable descriptor（repoPaths / confirmedEmpty）须在 commit 前写入 journal
    const fastManifest = await prepareDeleteManifest(id);
    await writeDeletionJournal(id, { ...fastManifest, phase: "prepared" });
    // R33-5：进入不可逆 refs/rm 前原子推进 committed
    await commitDeletionJournal(id);
    const committedRead = await readDeletionJournal(id);
    // R35-4：committed 后读未知 → 保持 recoveryPending，不 rm、不释放可见
    if (committedRead.kind === "unknown") {
      console.error(
        `[DELETE /api/tasks/[id]] R35-4 committed 后 journal 读未知 task=${id}`,
        committedRead.error,
      );
      publishTaskStreamEvent(id, { kind: "task_deleted", taskId: id });
      clearChatGate(id);
      return recoveryPendingResponse();
    }
    const committedJournal =
      committedRead.kind === "present" ? committedRead.value : null;
    let refsAllSucceeded = true;
    // R34-7 / R35-3：manifestPending → 不按零 ref 清扫；无完整描述则不 rm taskDir
    if (committedJournal?.manifestPending) {
      refsAllSucceeded = false;
      console.warn(
        `[DELETE /api/tasks/[id]] R34-7 manifestPending、跳过零 ref 清扫 task=${id}`,
      );
      if (!hasDurableDeleteDescriptor(committedJournal)) {
        // R35-3：恢复描述不完整——保留 meta/rewind 作恢复源，journal 停 committed+manifestPending
        console.error(
          `[DELETE /api/tasks/[id]] R35-3 manifestPending 无完整 repoPaths、不 rm taskDir task=${id}`,
        );
        publishTaskStreamEvent(id, { kind: "task_deleted", taskId: id });
        clearChatGate(id);
        return recoveryPendingResponse();
      }
    } else if (committedJournal) {
      const refResult = await cleanupCheckpointRefsFromManifest(
        id,
        committedJournal,
      );
      refsAllSucceeded = refResult.allSucceeded;
      if (!refResult.allSucceeded) {
        // R33-6：失败项写回 journal，taskDir 仍可删
        await writeDeletionJournal(id, {
          ...committedJournal,
          phase: "committed",
          refsPending: refResult.pending,
        });
        console.warn(
          `[DELETE /api/tasks/[id]] R33-6 cleanupCheckpointRefs 部分失败 task=${id} pending=${refResult.pending.length}`,
        );
      }
    }
    const ok = await deleteTask(id);
    if (!ok) {
      // R34-1 / R35-4：已 committed → 任务逻辑已隐藏，目录缺失也走前滚而非 404 回滚
      const still = await readDeletionJournal(id);
      if (still.kind === "unknown") {
        publishTaskStreamEvent(id, { kind: "task_deleted", taskId: id });
        clearChatGate(id);
        return recoveryPendingResponse();
      }
      if (still.kind === "present" && still.value.phase === "committed") {
        publishTaskStreamEvent(id, { kind: "task_deleted", taskId: id });
        clearChatGate(id);
        void recoverDeletedTaskArtifacts(id).catch((e) =>
          console.error(
            `[DELETE /api/tasks/[id]] R34-1 recovery 后台失败 task=${id}`,
            e,
          ),
        );
        return recoveryPendingResponse();
      }
      await rollbackDeletionJournalIfTaskDirRemains(id);
      endChatLifecycle(id, "deleting");
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    await removeDeletionJournalIfFullyDone(id, refsAllSucceeded);
    // R33-4：物理删成功 → 通知既有 watcher
    publishTaskStreamEvent(id, { kind: "task_deleted", taskId: id });
    // 出口 success：物理删完才清全部门闩（含 deleting / cancelled lease / rewind 键）
    clearChatGate(id);
    // W1：故意不 clear generation——保留 tombstone 防 ABA（无键默认 0 会让旧 snap 复活）；
    // task id 不复用，Map 留 string+number 可忽略
    // R34-7 / R35-4：manifest / refs 未收尾 → 对外 accepted + recoveryPending
    const afterRead = await readDeletionJournal(id);
    if (afterRead.kind === "unknown") {
      return recoveryPendingResponse();
    }
    if (
      !refsAllSucceeded ||
      (afterRead.kind === "present" && afterRead.value.manifestPending)
    ) {
      return recoveryPendingResponse();
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    // R34-1 / R34-2 / R35-4：committed / tombstone / 读未知 → 只前滚，返 recoveryPending
    // 禁止 unknown 走「未提交」分支返 400 释放 gate
    const journal = await readDeletionJournal(id);
    const tomb = await probeDeleteTombstone(id);
    if (journal.kind === "unknown" || tomb.kind === "unknown") {
      endChatLifecycle(id, "deleting");
      publishTaskStreamEvent(id, { kind: "task_deleted", taskId: id });
      clearChatGate(id);
      console.error(
        "[DELETE /api/tasks/[id]] R35-4 证据读未知、保持 recoveryPending",
        err,
        journal.kind === "unknown"
          ? journal.error
          : tomb.kind === "unknown"
            ? tomb.error
            : undefined,
      );
      return recoveryPendingResponse();
    }
    if (
      (journal.kind === "present" && journal.value.phase === "committed") ||
      tomb.kind === "present"
    ) {
      endChatLifecycle(id, "deleting");
      publishTaskStreamEvent(id, { kind: "task_deleted", taskId: id });
      clearChatGate(id);
      void recoverDeletedTaskArtifacts(id).catch((e) =>
        console.error(
          `[DELETE /api/tasks/[id]] R34-1 catch 后 recovery 失败 task=${id}`,
          e,
        ),
      );
      console.error(
        "[DELETE /api/tasks/[id]] committed 后异常、前滚 recoveryPending",
        err,
      );
      return recoveryPendingResponse();
    }
    // 仅 prepared / 无证据：回滚未向用户确认的删除意图
    await rollbackDeletionJournalIfTaskDirRemains(id);
    // 出口异常：必须释放 deleting，否则任务永远卡在 deleting → 后续请求全 409
    endChatLifecycle(id, "deleting");
    console.error("[DELETE /api/tasks/[id]] failed", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
};
