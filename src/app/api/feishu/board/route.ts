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

import { mergeBoardWindows, splitBoardWindows } from "@/lib/board-range";
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

/**
 * 看板每次请求都要 host 拼详情页链接：meegleAuthStatus 走进程级串行队列且无缓存，
 * 连点平移会让它排到前面一堆 CLI 调用后面。host 基本不变——只缓存「已登录且拿到 host」的结果 60s（D2a-04）。
 */
let authHostCache: { at: number; host: string | undefined } | null = null;
const AUTH_HOST_TTL_MS = 60_000;
const cachedAuthHost = async (): Promise<{ host: string | undefined }> => {
  if (authHostCache && Date.now() - authHostCache.at < AUTH_HOST_TTL_MS) {
    return { host: authHostCache.host };
  }
  const st = await meegleAuthStatus();
  if (st.authenticated && st.host) authHostCache = { at: Date.now(), host: st.host };
  return { host: st.host };
};

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

    // workhour 接口约束：单次跨度 ≤ 3 个月。半年预设 / 日历任意区间会超出——
    // 按 ≤90 天分段串行请求、合并去重（以前直接截断：后面的排期静默为空，界面却照画满列，D2a-02）。
    // 客户端换区间会 abort 旧请求：每段之前先看 signal，别把串行队列白白跑完（D2a-04）
    const { windows, truncated } = splitBoardWindows(from, to);
    const parts: Awaited<ReturnType<typeof fetchUserSchedule>>[] = [];
    for (const w of windows) {
      if (req.signal.aborted) {
        return NextResponse.json(
          { status: "error", message: "请求已取消" },
          { status: 499 },
        );
      }
      parts.push(await fetchUserSchedule(project, myKey, w.from, w.to));
    }
    const items = mergeBoardWindows(parts);
    const clampedTo = windows[windows.length - 1]?.to ?? to;

    // url 兜底（feishuStoryUrl 关联 + AI 拉需求入口）：simple_name 拼标准详情页路径
    const [{ host }, simpleNames] = await Promise.all([
      cachedAuthHost(),
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
    return NextResponse.json({
      status: "ok",
      projects,
      items: linked,
      // 区间超过单次最大分段数时只查了前面一部分：前端据此提示实际覆盖到哪天
      ...(truncated ? { coveredTo: clampedTo } : {}),
    });
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
