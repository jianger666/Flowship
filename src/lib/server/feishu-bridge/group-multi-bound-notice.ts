/**
 * 「这个群同时绑了多个任务」→ 在受理这条群消息的任务事件流里留一条 info（第四轮 B4-4 / Q12b-02）
 *
 * 群消息只会进其中一个任务（挑选规则见 group-task-binding 的 pickRouteTask）。属主没有任何渠道知道
 * 「我的群消息其实是被另一个任务占着」——这里让受理方的事件流里看得见一次。
 *
 * 刻意只写事件、不往群里回话：
 *  - 群里已经有一条「本机没有关联此需求的任务」的节流回执，再加一类系统回执会让群里的机器人互相回灌；
 *  - 提示的对象是属主（能去取消关联 / 换绑的人），不是群里提问的同事。
 *
 * 节流：同一个群 + 同一个受理任务 + 同一组同伴，30 分钟只留一条（群里连问十句不刷十条）；同伴变了就是新情况、重新提示。
 * 永不抛：它跑在入向链上，不能因为提示写不进去打断群问答。
 */

import { writeOwnedEventAndPublish } from "@/lib/server/task-stream";

import type { CoBoundTask } from "./group-task-binding";

const LOG = "[feishu-bridge/group-multi-bound-notice]";

/** 同一组合 30 分钟只提示一次 */
export const MULTI_BOUND_NOTICE_WINDOW_MS = 30 * 60_000;
/** 提示里最多列几个同伴的标题 */
export const MULTI_BOUND_TITLES_SHOWN = 4;
/** 单个标题最多显示多少个字（按码点，不切开 emoji） */
export const MULTI_BOUND_TITLE_CLIP = 20;
/** 节流表的条目上限（只记「群×任务×同伴」组合，正常几条；防异常数据撑大） */
const MARKS_MAX = 200;

const STATE_KEY = "__flowshipGroupMultiBoundNoticeV1__";

const getMarks = (): Map<string, number> => {
  const g = globalThis as unknown as Record<string, Map<string, number> | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = new Map();
  return g[STATE_KEY]!;
};

/** 测试用：清节流表 */
export const __resetGroupMultiBoundNoticeForTest = (): void => {
  getMarks().clear();
};

const clipTitle = (s: string): string => {
  const chars = Array.from(s);
  return chars.length > MULTI_BOUND_TITLE_CLIP
    ? `${chars.slice(0, MULTI_BOUND_TITLE_CLIP).join("")}…`
    : s;
};

/** 事件正文（单测按字面断言） */
export const describeMultiBound = (
  chosenTaskId: string,
  coBound: readonly CoBoundTask[],
): string => {
  const others = coBound.filter((t) => t.id !== chosenTaskId);
  const shown = others
    .slice(0, MULTI_BOUND_TITLES_SHOWN)
    .map((t) => `「${clipTitle(t.title || t.id)}」`)
    .join("");
  const rest =
    others.length > MULTI_BOUND_TITLES_SHOWN
      ? `等另外 ${others.length - MULTI_BOUND_TITLES_SHOWN} 个`
      : "";
  return (
    `这个群同时绑定了 ${coBound.length} 个任务（本任务和${shown}${rest}），群里的 @ 只会进其中一个——这条进了本任务` +
    "（优先选正在运行 / 等你回答的，同档选最近更新的）。想让群只对应一个任务，请到其它任务的「需求群」弹窗取消关联或换绑"
  );
};

/** 这一组合现在该不该提示（该就同时记下时间）。顺带清掉过期条目 */
const claim = (key: string, now: number): boolean => {
  const marks = getMarks();
  const last = marks.get(key);
  if (last !== undefined && now - last < MULTI_BOUND_NOTICE_WINDOW_MS) return false;
  if (marks.size >= MARKS_MAX) {
    for (const [k, at] of marks) {
      if (now - at >= MULTI_BOUND_NOTICE_WINDOW_MS) marks.delete(k);
    }
    if (marks.size >= MARKS_MAX) marks.clear();
  }
  marks.set(key, now);
  return true;
};

/**
 * 记一条「这个群同时绑定了 N 个任务」。
 * @param taskId  受理这条群消息的任务（事件写在它的事件流里）
 * @param coBound 同一个群上绑定的全部任务（含 taskId 自己）；不足 2 个直接返回
 */
export const noteGroupMultiBound = async (
  taskId: string,
  chatId: string,
  coBound: readonly CoBoundTask[],
  now: number = Date.now(),
): Promise<void> => {
  try {
    if (!taskId || coBound.length < 2) return;
    const members = coBound
      .map((t) => t.id)
      .sort()
      .join(",");
    if (!claim(`${chatId}|${taskId}|${members}`, now)) return;
    await writeOwnedEventAndPublish(taskId, () => true, {
      kind: "info",
      text: describeMultiBound(taskId, coBound),
    });
  } catch (err) {
    console.warn(
      `${LOG} 记录同群多任务提示时出错 chat=${chatId} task=${taskId}:`,
      err instanceof Error ? err.message : err,
    );
  }
};
