/**
 * 群问答「并进事件流」：做完的旁路答疑轮次（轮次汇总事件）内联成一张卡，出现在主事件流里。
 *
 * 口径（2026-11-04 用户拍板「全部都在事件流里」；2026-11-05 去掉「群问答」页签、事件流是唯一去处。
 * 无活会话时的只读旁路答疑通道仍在，它的结果就是这张内联卡）：
 * - 单一隐藏闸：旁路问题事件（restrictedRunTag）仍藏；**轮次汇总事件不再藏**
 * - 汇总 → 轮次 的配对复用 collectGroupQaRounds 的结果（卡里带问题原文），脏数据 / 没配上 = null（落回 info 细线）
 * - 进行中的轮次靠开跑时落的一条 info 提示；被打断（没有汇总）的轮次不留卡
 * - 过程事件（meta.groupRun）仍藏
 * - 并入同会话的非属主一轮（groupNonOwnerTurn）不产生汇总、不进这里
 *
 * 没有 jsdom / 浏览器：真实像素与滚动行为不在这里验证。SSR 渲染 + 源码接线契约。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GroupQaInlineRow } from "@/components/tasks/group-qa-inline-row";
import { isHiddenFromEventStream } from "@/lib/event-stream-hidden";
import {
  buildGroupQaSummaryEvent,
  collectGroupQaRounds,
  groupQaRoundOfSummaryEvent,
} from "@/lib/group-qa";
import type { TaskEvent } from "@/lib/types";

const ROOT = path.resolve(import.meta.dirname, "..");
const readSrc = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");

let n = 0;
const ev = (
  kind: TaskEvent["kind"],
  over: Partial<TaskEvent> & { meta?: Record<string, unknown> } = {},
): TaskEvent =>
  ({
    id: `e${++n}`,
    seq: n,
    ts: 1_700_000_000_000 + n * 1000,
    kind,
    text: "",
    ...over,
  }) as TaskEvent;

const question = (runTag: string, text = "[群消息·来自 小明（非任务所有者）]\n登录接口返回啥？") =>
  ev("user_reply", {
    text,
    meta: {
      source: "feishu_group",
      restrictedRunTag: runTag,
      groupSender: "小明",
      groupSenderOpenId: "ou_xm",
      feishuMessageId: `om_${runTag}`,
    },
  });
const summary = (runTag: string, extra: Record<string, unknown> = {}) => {
  const built = buildGroupQaSummaryEvent({
    runTag,
    askerOpenId: "ou_xm",
    askerName: "小明",
    answer: "返回用户信息 JSON。",
    ok: true,
    ...extra,
  });
  return ev("info", { text: built.text, meta: built.meta as Record<string, unknown> });
};

const byKey = (events: TaskEvent[]) =>
  new Map(collectGroupQaRounds(events).map((r) => [r.key, r] as const));

describe("单一隐藏闸：问题藏、汇总不藏", () => {
  it("旁路问题事件（restrictedRunTag）仍藏", () => {
    expect(isHiddenFromEventStream(question("t1"))).toBe(true);
  });

  it("轮次汇总事件不再藏（内联卡的数据源）", () => {
    expect(isHiddenFromEventStream(summary("t1"))).toBe(false);
  });

  it("旁路 run 的过程事件（meta.groupRun）仍藏，不论 kind", () => {
    for (const kind of ["thinking", "tool_call", "assistant_message", "error"] as const) {
      expect(isHiddenFromEventStream(ev(kind, { meta: { groupRun: "t1" } }))).toBe(true);
    }
  });

  it("属主群消息（无 runTag）照旧可见", () => {
    expect(isHiddenFromEventStream(ev("user_reply", { meta: { source: "feishu_group" } }))).toBe(false);
  });
});

describe("groupQaRoundOfSummaryEvent：汇总 → 轮次", () => {
  it("配上问题：返回的轮次带问题原文（去噪后）与回答", () => {
    const q = question("t1");
    const s = summary("t1");
    const round = groupQaRoundOfSummaryEvent(s, byKey([q, s]));
    expect(round).toMatchObject({
      key: "t1",
      askerName: "小明",
      questionText: "登录接口返回啥？",
      answerText: "返回用户信息 JSON。",
      legacy: false,
    });
  });

  it("问题被分页裁掉、只剩汇总：仍有轮次（问题显示「未知问题」），不会丢卡", () => {
    const s = summary("t2");
    const round = groupQaRoundOfSummaryEvent(s, byKey([s]));
    expect(round).toMatchObject({ key: "t2", questionText: "（未知问题）" });
  });

  it("noReply / needsOwner 透传（卡上的淡化 / 「待你决定」依赖它）", () => {
    const s = summary("t3", { noReply: true, needsOwner: "要不要放开权限？" });
    const round = groupQaRoundOfSummaryEvent(s, byKey([question("t3"), s]));
    expect(round).toMatchObject({ noReply: true, needsOwner: "要不要放开权限？" });
  });

  it("不是汇总事件 / 汇总缺 runTag（脏数据）→ null（调用方落回 info 细线）", () => {
    const map = byKey([]);
    expect(groupQaRoundOfSummaryEvent(ev("info", { text: "x" }), map)).toBeNull();
    const dirty = ev("info", {
      text: "x",
      meta: { groupQaSummary: { askerName: "x", answer: "y", ok: true } },
    });
    expect(groupQaRoundOfSummaryEvent(dirty, map)).toBeNull();
  });

  it("轮次表里没有这个 runTag → null", () => {
    expect(groupQaRoundOfSummaryEvent(summary("zzz"), new Map())).toBeNull();
  });

  it("没有汇总的轮次（进行中 / 被打断）：流里没有对应汇总事件，只在 tab 的轮次表里", () => {
    const q = question("t4");
    const rounds = collectGroupQaRounds([q], q.ts + 1000);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.answering).toBe(true);
    // 问题被藏、没有汇总 = 事件流里整轮不可见（蓝点提示去 tab 看）
    expect([q].filter((e) => !isHiddenFromEventStream(e))).toHaveLength(0);
  });
});

describe("GroupQaInlineRow：SSR 冒烟", () => {
  const render = (events: TaskEvent[], s: TaskEvent) =>
    renderToStaticMarkup(
      createElement(GroupQaInlineRow, { ev: s, roundsByKey: byKey(events), events }),
    );

  it("收起态：「群问答」标签 + 提问人 + 一行回答；问题原文 / 全文在展开后才有", () => {
    const q = question("t1");
    const s = summary("t1");
    const html = render([q, s], s);
    expect(html).toContain("群问答");
    expect(html).toContain("小明");
    expect(html).toContain("返回用户信息 JSON。");
    expect(html).toContain('aria-expanded="false"');
    // 问题原文只在展开态渲染
    expect(html).not.toContain("登录接口返回啥？");
  });

  it("机器人提问人带徽标；noReply 轮淡化成「已读、无需回复」", () => {
    const q = question("t5");
    const s = summary("t5", { askerIsBot: true, noReply: true, answer: "NO_REPLY" });
    const html = render([q, s], s);
    expect(html).toContain("机器人");
    expect(html).toContain("已读、无需回复");
    expect(html).not.toContain("NO_REPLY");
  });

  it("待你决定的轮次行上有醒目标", () => {
    const q = question("t6");
    const s = summary("t6", { needsOwner: "要不要放开权限？" });
    expect(render([q, s], s)).toContain("待你决定");
  });

  it("配不上轮次（脏数据）：渲染为空，不抛（虚拟列表里不能炸）", () => {
    const dirty = ev("info", { text: "x", meta: { groupQaSummary: {} } });
    expect(render([dirty], dirty)).toBe("");
  });
});

describe("事件流接线契约", () => {
  const stream = readSrc("src/components/tasks/event-stream.tsx");

  it("汇总事件有轮次时走 GroupQaInlineRow，且排在通用 EventRow 之前", () => {
    // 同一条三元链：重连行 → 群问答内联卡 → 压缩行 → 通用 EventRow（兜底）
    expect(stream).toMatch(
      /isGroupQaSummaryEvent\(item\) &&\s*groupQaRoundOfSummaryEvent\(item, groupQaRoundsByKey\)\s*\? \([\s\S]*?<GroupQaInlineRow[\s\S]*?\) : isCompactionInfo\(item\) \? \([\s\S]*?<CompactionRow[\s\S]*?\) : \(\s*<EventRow/,
    );
  });

  it("轮次表由 collectGroupQaRounds 的结果按 key 建（不另算一份）", () => {
    expect(stream).toMatch(
      /groupQaRoundsByKey = useMemo\(\s*\(\) => new Map\(groupQaRounds\.map/,
    );
  });

  it("没有单独的「群问答」页签：事件流是群里提问的唯一去处（2026-11-05 去掉页签）", () => {
    expect(stream).not.toContain("GroupQaPanel");
    expect(stream).not.toContain("showGroupQa");
    expect(stream).not.toContain("onGroupQaVisibleChange");
    expect(stream).not.toMatch(/群问答[（(]/);
    expect(existsSync(path.resolve(import.meta.dirname, "..", "src/components/tasks/group-qa-panel.tsx"))).toBe(false);
    expect(existsSync(path.resolve(import.meta.dirname, "..", "src/lib/group-qa-scope.ts"))).toBe(false);
  });

  it("任务页不再因页签隐藏底部输入条", () => {
    const page = readSrc("src/app/tasks/[id]/page.tsx");
    expect(page).not.toContain("groupQaVisible");
    expect(page).not.toContain("onGroupQaVisibleChange");
  });

  it("隐藏闸里不再有汇总事件分支（只认问题事件），且不再 import isGroupQaSummaryEvent", () => {
    const hidden = readSrc("src/lib/event-stream-hidden.ts");
    expect(hidden).toContain("if (isGroupQaQuestionEvent(ev)) return true;");
    expect(hidden).not.toMatch(/isGroupQaSummaryEvent/);
  });
});
