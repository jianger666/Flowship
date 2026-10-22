/**
 * 300 条窗口一致性 · 群问答 tab / 「待你决定」只统计已加载（第三轮 review D8-01）
 *
 * 事实：群问答轮次 / 「待你决定」都是从 task.events 聚合的，事件只有最近一段窗口时，
 * 窗口外的群问答不在统计里——全量日志 1 轮需属主确认，窗口内 0 轮、tab 都不出现，用户没有任何线索。
 *
 * 修法：窗口被截过（还有更早事件没加载）时
 *   - 有轮次：标题带「+」（至少这么多），面板顶部说明「仅统计已加载」并给「加载更早」入口；
 *   - 窗口内 0 轮但任务绑了飞书群：tab 照常出现（否则「没有」和「不知道」长得一样），面板说明窗口外可能还有；
 *   - 没绑群、也没轮次：不出 tab（长任务不该都多一个空 tab）；
 *   - 窗口完整（没有更早事件）：口径不变，无提示。
 */
import { describe, expect, it } from "vitest";

import {
  buildGroupQaSummaryEvent,
  collectGroupQaRounds,
  pickRoundsNeedingOwner,
} from "../src/lib/group-qa";
import { deriveGroupQaScope } from "../src/lib/group-qa-scope";
import type { TaskEvent } from "../src/lib/types";

const NOW = 2_000_000_000_000;
let seq = 0;
const ev = (p: Partial<TaskEvent> & Pick<TaskEvent, "kind">): TaskEvent => {
  seq += 1;
  return { id: `e${seq}`, text: "", ts: NOW - 60_000 + seq, ...p };
};

const needOwnerSummary = (): TaskEvent => {
  const b = buildGroupQaSummaryEvent({
    runTag: "rt-1",
    askerOpenId: "ou_x",
    askerName: "张三",
    answer: "建议先灰度",
    ok: true,
    needsOwner: "要不要今晚全量发布",
  });
  return ev({ kind: b.kind, text: b.text, meta: b.meta });
};

/** 全量：1 轮需属主确认的群问答 + 400 条后续事件 */
const fullLog = (): TaskEvent[] => {
  const out: TaskEvent[] = [needOwnerSummary()];
  for (let i = 0; i < 400; i++) out.push(ev({ kind: "assistant_message", text: `m${i}` }));
  return out;
};

describe("D8-01 复现：窗口内统计与全量不一致", () => {
  it("全量 1 轮 / 待你决定 1；最近 300 条窗口 0 轮 / 0（口径本身不变，靠提示补）", () => {
    const all = fullLog();
    const win = all.slice(-300);
    const full = collectGroupQaRounds(all, NOW);
    const part = collectGroupQaRounds(win, NOW);
    expect(full).toHaveLength(1);
    expect(pickRoundsNeedingOwner(full, { now: NOW })).toHaveLength(1);
    expect(part).toHaveLength(0);
    expect(pickRoundsNeedingOwner(part, { now: NOW })).toHaveLength(0);
  });
});

describe("deriveGroupQaScope", () => {
  it("窗口完整（没有更早事件）：有轮次出 tab、无提示、计数不带 +", () => {
    expect(
      deriveGroupQaScope({ roundCount: 2, hasMoreEarlier: false, hasGroup: true, isChat: false }),
    ).toEqual({ showTab: true, countText: "2", notice: null });
  });

  it("窗口完整、0 轮：不出 tab（含绑了群的任务——此时「没有」是真的没有）", () => {
    expect(
      deriveGroupQaScope({ roundCount: 0, hasMoreEarlier: false, hasGroup: true, isChat: false }),
    ).toEqual({ showTab: false, countText: "", notice: null });
  });

  it("窗口被截过、有轮次：计数带 +，面板说明仅统计已加载", () => {
    const s = deriveGroupQaScope({ roundCount: 3, hasMoreEarlier: true, hasGroup: true, isChat: false });
    expect(s.showTab).toBe(true);
    expect(s.countText).toBe("3+");
    expect(s.notice).toMatch(/仅统计已加载/);
    // 提示里同时点明「待你决定」也只覆盖已加载部分
    expect(s.notice).toMatch(/待你决定/);
  });

  it("窗口被截过、0 轮、绑了群：tab 照常出现并说明窗口外可能还有（D8-01 的漏报场景）", () => {
    const s = deriveGroupQaScope({ roundCount: 0, hasMoreEarlier: true, hasGroup: true, isChat: false });
    expect(s.showTab).toBe(true);
    expect(s.countText).toBe("");
    expect(s.notice).toMatch(/更早/);
  });

  it("窗口被截过、0 轮、没绑群：不出 tab（长任务不该都多一个空 tab）", () => {
    expect(
      deriveGroupQaScope({ roundCount: 0, hasMoreEarlier: true, hasGroup: false, isChat: false }),
    ).toEqual({ showTab: false, countText: "", notice: null });
  });

  it("chat 形态没有群桥接：任何输入都不出 tab", () => {
    for (const roundCount of [0, 5]) {
      for (const hasMoreEarlier of [true, false]) {
        expect(
          deriveGroupQaScope({ roundCount, hasMoreEarlier, hasGroup: true, isChat: true }).showTab,
        ).toBe(false);
      }
    }
  });

  it("提示文案是业务话：不含协议词 / 内部字段名", () => {
    const texts = [
      deriveGroupQaScope({ roundCount: 3, hasMoreEarlier: true, hasGroup: true, isChat: false }).notice,
      deriveGroupQaScope({ roundCount: 0, hasMoreEarlier: true, hasGroup: true, isChat: false }).notice,
    ];
    for (const t of texts) {
      expect(t).toBeTruthy();
      expect(t).not.toMatch(/eventsTruncated|tail|SSE|groupRun|meta/i);
    }
  });
});
