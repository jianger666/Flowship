/**
 * GET /api/feishu/board?project=<projectKey>&from=<ms>&to=<ms>
 * GET /api/feishu/board（不带 project：只返回空间列表、前端选完再查）
 *
 * 首页排期甘特数据源（V0.14.1 重写、同事实测踩坑后换数据源）：
 *
 * 为什么不用 mywork todo（V0.14.0 的老路）：它只覆盖「当前节点等我操作」的
 * 工作项——同事是子任务负责人、不是节点 owner、mywork 拉不到他的需求；
 * 空间下拉从 mywork 数据聚合也因此缺空间。
 *
 * 现在走 workhour list-schedule（飞书「人员排期」视图的底层接口）：
 * 按 空间 + 我 + 时间区间 查我参与的全部排期——需求条 + 我的子任务一次拿全、
 * 语义与飞书人员排期完全一致（用户拍板对齐的就是那个视图）。
 *
 * 四态返回：ok / not_installed / not_authed / error——前端按态渲染降级引导。
 * 瞬态失败（超时 / 网络不可达）必须走 error（「重试」），不得走 not_authed
 *（v1.1.x 与 feishu-cli mergeAuthPreserve 同哲学：瞬态 ≠ 未登录）。
 */

import { NextResponse } from "next/server";

import { extractFeishuStoryId } from "@/lib/branch-template";
import {
  fetchMyUserKey,
  fetchProjects,
  fetchProjectSimpleNames,
  fetchUserSchedule,
  meegleAuthStatus,
  MeegleError,
} from "@/lib/server/meegle-cli";
import {
  assertTaskReadable,
  filterCommittedReads,
  listTasks,
} from "@/lib/server/task-fs";
import { failpoint } from "@/lib/server/failpoints";

export const runtime = "nodejs";

const DAY_MS = 24 * 60 * 60 * 1000;

export const GET = async (req: Request) => {
  const url = new URL(req.url);
  const project = url.searchParams.get("project")?.trim() || "";
  const from = Number(url.searchParams.get("from")) || Date.now() - 30 * DAY_MS;
  const to = Number(url.searchParams.get("to")) || Date.now() + 60 * DAY_MS;

  try {
    // 空间列表（下拉数据源、来自 project search 全量——不再从数据聚合）
    const projects = await fetchProjects();
    if (!project) {
      return NextResponse.json({ status: "ok", projects, items: [] });
    }

    const myKey = await fetchMyUserKey();
    // fetchMyUserKey：确定性未登录 → null；超时 / 网络抖 → 抛 MeegleError(error)
    // （旧路径把瞬态也吞成 null → 看板误弹「去授权」、VPN 卡同事踩过）
    if (!myKey) {
      return NextResponse.json({
        status: "not_authed",
        message: "meegle 未登录、请先在设置页授权",
      });
    }

    // workhour 接口约束：单次跨度 ≤ 3 个月——超出的按 90 天截断（甘特窗口不会这么大）
    const clampedTo = Math.min(to, from + 90 * DAY_MS);
    const items = await fetchUserSchedule(project, myKey, from, clampedTo);

    // url 兜底（feishuStoryUrl 关联 + AI 拉需求入口）：simple_name 拼标准详情页路径
    const [{ host }, simpleNames] = await Promise.all([
      meegleAuthStatus(),
      fetchProjectSimpleNames(),
    ]);
    const simple = simpleNames.get(project);
    for (const it of items) {
      if (!it.url && host && simple) {
        it.url = `https://${host}/${simple}/story/detail/${it.id}`;
      }
    }

    // join 本地任务：feishuStoryUrl 抠出的 story id 精确等于工作项 id → 已有任务
    const tasks = await listTasks();
    // list helper 与 Response 之间可插入删除——提交前再 filter
    await failpoint("httpRead.afterHelper");
    const readableTasks = filterCommittedReads(tasks);
    const linked = items.map((it) => {
      const t = readableTasks.find(
        (task) =>
          task.mode !== "chat" &&
          extractFeishuStoryId(task.feishuStoryUrl) === it.id,
      );
      return {
        ...it,
        raw: undefined,
        task:
          t && assertTaskReadable(t.id)
            ? {
                id: t.id,
                repoStatus: t.repoStatus,
                runStatus: t.runStatus,
                lastActionType: t.lastActionType,
                lastActionStatus: t.lastActionStatus,
              }
            : null,
      };
    });
    console.log(
      `[feishu-board] project=${project} 区间 ${new Date(from).toISOString().slice(0, 10)}~${new Date(clampedTo).toISOString().slice(0, 10)}：${linked.length} 项、关联任务 ${linked.filter((i) => i.task).length} 项`,
    );
    return NextResponse.json({ status: "ok", projects, items: linked });
  } catch (err) {
    if (err instanceof MeegleError) {
      return NextResponse.json({ status: err.kind, message: err.message });
    }
    console.error("[GET /api/feishu/board] failed", err);
    return NextResponse.json(
      { status: "error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
};
