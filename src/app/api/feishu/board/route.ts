/**
 * GET /api/feishu/board?action=todo|done|overdue|this_week
 *
 * 首页排期甘特数据源（V0.14）：meegle mywork 拉「我的工作项」+ 节点排期聚合 + 本地任务 join。
 *
 * V0.14.4 节点排期聚合（用户拍板「默认收起看需求整条、展开看每个节点排期」）：
 * - mywork 每条只带**当前节点**的排期 → 需求条只画当前节点区间、且同一需求可能出现多条
 *  （不同节点各一条）——都不是用户要的
 * - 改：按 work_item_id 去重后、并发拉 `workflow get-node _all`（10 分钟缓存）、
 *   需求级跨度 = 所有节点排期 min(start)~max(end)（一个节点排期都没有时回退 mywork 的）、
 *   nodes 一并下发（甘特展开细节用）
 *
 * 三态返回：ok / not_installed / not_authed——前端按态渲染降级引导。
 */

import { NextResponse } from "next/server";

import { extractFeishuStoryId } from "@/lib/branch-template";
import {
  fetchMyWorkitems,
  fetchNodesForItems,
  fetchProjectSimpleNames,
  meegleAuthStatus,
  MeegleError,
  type BoardWorkitem,
  type MyworkAction,
} from "@/lib/server/meegle-cli";
import { listTasks } from "@/lib/server/task-fs";

export const runtime = "nodejs";

const VALID_ACTIONS = new Set<MyworkAction>(["todo", "done", "overdue", "this_week"]);

export const GET = async (req: Request) => {
  const url = new URL(req.url);
  const actionRaw = url.searchParams.get("action") ?? "todo";
  const action = (VALID_ACTIONS.has(actionRaw as MyworkAction)
    ? actionRaw
    : "todo") as MyworkAction;
  // 手动刷新时跳过节点排期缓存（?fresh=1）
  const fresh = url.searchParams.get("fresh") === "1";

  try {
    // 拉前两页（100 条）——个人待办超过 100 条的先看前面的
    const page1 = await fetchMyWorkitems(action, 1);
    const rawItems = [...page1];
    if (page1.length === 50) {
      const page2 = await fetchMyWorkitems(action, 2).catch((err) => {
        console.warn("[feishu-board] 第 2 页拉取失败（只展示前 50 条）", err);
        return [];
      });
      rawItems.push(...page2);
    }

    // 按 work_item_id 去重（mywork 同一需求可能按节点出多条）：保留首条、
    // 排期区间取并集兜底（聚合后通常被节点跨度覆盖）
    const byId = new Map<string, BoardWorkitem>();
    for (const it of rawItems) {
      const cur = byId.get(it.id);
      if (!cur) {
        byId.set(it.id, it);
        continue;
      }
      if (it.scheduleStart && (!cur.scheduleStart || it.scheduleStart < cur.scheduleStart)) {
        cur.scheduleStart = it.scheduleStart;
      }
      if (it.scheduleEnd && (!cur.scheduleEnd || it.scheduleEnd > cur.scheduleEnd)) {
        cur.scheduleEnd = it.scheduleEnd;
      }
    }
    const items = [...byId.values()];

    // 节点排期聚合：需求级跨度 = 节点排期 min~max、nodes 下发给甘特展开
    const nodesMap = await fetchNodesForItems(
      items.map((it) => ({ id: it.id, projectKey: it.projectKey })),
      { skipCache: fresh },
    );
    for (const it of items) {
      const nodes = nodesMap.get(it.id) ?? [];
      const starts = nodes.map((n) => n.start).filter((v): v is number => !!v);
      const ends = nodes.map((n) => n.end).filter((v): v is number => !!v);
      if (starts.length > 0) it.scheduleStart = Math.min(...starts);
      if (ends.length > 0) it.scheduleEnd = Math.max(...ends);
    }

    // url 兜底：mywork 响应不带详情页 URL（实测确认）——按飞书项目标准路径拼
    // `https://<host>/<simple_name>/<type_key>/detail/<id>`
    const [{ host }, simpleNames] = await Promise.all([
      meegleAuthStatus(),
      fetchProjectSimpleNames(),
    ]);
    for (const it of items) {
      const simple = it.projectKey ? simpleNames.get(it.projectKey) : undefined;
      if (!it.url && host && simple) {
        it.url = `https://${host}/${simple}/${it.typeLabel ?? "story"}/detail/${it.id}`;
      }
    }

    // join 本地任务：feishuStoryUrl 抠出的 story id 精确等于工作项 id → 已有任务
    const tasks = await listTasks();
    const linked = items.map((it) => {
      const t = tasks.find(
        (task) =>
          task.mode !== "chat" &&
          extractFeishuStoryId(task.feishuStoryUrl) === it.id,
      );
      return {
        ...it,
        raw: undefined,
        nodes: nodesMap.get(it.id) ?? [],
        task: t
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
    return NextResponse.json({ status: "ok", action, items: linked });
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
