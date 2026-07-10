/**
 * GET /api/feishu/board?action=todo|done|overdue|this_week
 *
 * 首页飞书看板数据源（V0.14）：调 meegle CLI 拉「我的工作项」+ join 本地任务映射。
 * 三态返回：ok（items）/ not_installed / not_authed——前端按态渲染降级引导。
 *
 * join 逻辑：task.feishuStoryUrl 里含工作项 ID（URL 尾段）→ 该工作项已有 AI 任务、
 * 带上 taskId + 任务状态（看板双状态徽标 + 点击直进任务页）。
 */

import { NextResponse } from "next/server";

import { extractFeishuStoryId } from "@/lib/branch-template";
import {
  fetchMyWorkitems,
  fetchProjectSimpleNames,
  meegleAuthStatus,
  MeegleError,
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

  try {
    // 首页只拉前两页（100 条）——个人待办超过 100 条的先看前面的
    const page1 = await fetchMyWorkitems(action, 1);
    const items = [...page1];
    if (page1.length === 50) {
      const page2 = await fetchMyWorkitems(action, 2).catch((err) => {
        console.warn("[feishu-board] 第 2 页拉取失败（只展示前 50 条）", err);
        return [];
      });
      items.push(...page2);
    }

    // url 兜底：mywork 响应不带详情页 URL（实测确认）——按飞书项目标准路径拼
    // `https://<host>/<simple_name>/<type_key>/detail/<id>`。simple_name（空间短名）
    // 从 project search 映射（project_key 是哈希、不能直接进 URL）
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
    //（不用 includes——短 id 是长 id 子串时会误 join、审计 P1）
    const tasks = await listTasks();
    const linked = items.map((it) => {
      const t = tasks.find(
        (task) =>
          task.mode !== "chat" &&
          extractFeishuStoryId(task.feishuStoryUrl) === it.id,
      );
      return {
        ...it,
        // raw 不下发（体积大、前端用不到）；预览页要原始字段时单独调 workitem 接口
        raw: undefined,
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
