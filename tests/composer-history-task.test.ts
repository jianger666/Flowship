/**
 * 300 条窗口一致性 · ↑ 输入历史（第三轮 review D8-03）
 *
 * 事实：task 页「跟 AI 说」输入条的 ↑ 历史只取 `task.events` 里的 user_reply。事件窗口只有最近一段时，
 * 一轮长 run 之后重开页面，历史是空的；而推进时输入的指令住在 `task.actions`（meta 里完整保存、不受窗口影响），
 * 现成的 `buildActionInstructionHistory` 只接了推进弹窗，输入条没接。
 *
 * `buildTaskInputHistory` = 两个来源按时间合并：新→旧、去空、相邻相同去重；
 * 划除的 action、事件流里被藏起来的 user_reply（群里别人的提问）与既有两个函数同口径。
 */
import { describe, expect, it } from "vitest";

import {
  buildActionInstructionHistory,
  buildInputHistory,
  buildTaskInputHistory,
} from "../src/lib/composer-history";
import type { ActionRecord, TaskEvent } from "../src/lib/types";

let seq = 0;
const reply = (text: string, ts: number, meta?: TaskEvent["meta"]): TaskEvent => {
  seq += 1;
  return { id: `r${seq}`, kind: "user_reply", text, ts, ...(meta ? { meta } : {}) };
};
const filler = (n: number, ts0: number): TaskEvent[] =>
  Array.from({ length: n }, (_, i) => {
    seq += 1;
    return { id: `f${seq}`, kind: "tool_result", text: "", ts: ts0 + i } as TaskEvent;
  });
const action = (
  n: number,
  userInstruction: string,
  startedAt: number,
  extra: Partial<ActionRecord> = {},
): ActionRecord =>
  ({
    id: `a${n}`,
    n,
    type: "plan",
    status: "completed",
    userInstruction,
    artifactPath: null,
    startedAt,
    endedAt: startedAt + 1,
    ...extra,
  }) as ActionRecord;

describe("D8-03 复现", () => {
  it("只吃 events 的老口径：窗口里没有 user_reply 就是空；带上 actions 不受窗口影响", () => {
    const all = [reply("先出方案", 100), ...filler(400, 200)];
    const win = all.slice(-300);
    expect(buildInputHistory(all)).toEqual(["先出方案"]);
    expect(buildInputHistory(win)).toEqual([]); // 老行为：窗口外的话翻不到
    const actions = [action(1, "按方案实现", 150)];
    expect(buildTaskInputHistory(win, actions)).toEqual(["按方案实现"]);
  });
});

describe("buildTaskInputHistory", () => {
  it("user_reply 与 action 指令按时间合并，新→旧", () => {
    const events = [reply("先说一句", 100), reply("再补一句", 300)];
    const actions = [action(1, "出方案", 200), action(2, "开始做", 400)];
    expect(buildTaskInputHistory(events, actions)).toEqual([
      "开始做",
      "再补一句",
      "出方案",
      "先说一句",
    ]);
  });

  it("没有 actions 时与 buildInputHistory 完全一致；没有 user_reply 时与 buildActionInstructionHistory 一致", () => {
    const events = [reply("a", 1), reply("a", 2), reply("b", 3)];
    expect(buildTaskInputHistory(events, [])).toEqual(buildInputHistory(events));
    const actions = [action(1, "x", 1), action(2, "y", 2)];
    expect(buildTaskInputHistory([], actions)).toEqual(buildActionInstructionHistory(actions));
  });

  it("去空 + 相邻相同去重（含跨来源：同一句话既在 user_reply 又在 action 里不按两下）", () => {
    const events = [reply("   ", 100), reply("继续", 300)];
    const actions = [action(1, "继续", 290), action(2, "", 310)];
    expect(buildTaskInputHistory(events, actions)).toEqual(["继续"]);
  });

  it("划除的 action 不进历史；群里别人的提问（事件流里被藏起来的 user_reply）不进历史", () => {
    const events = [
      reply("我自己说的", 100),
      reply("[群消息·来自 张三]\n问个事", 200, {
        source: "feishu_group",
        restrictedRunTag: "rt1",
      }),
    ];
    const actions = [action(1, "被划除的指令", 150, { excluded: true }), action(2, "保留的指令", 160)];
    expect(buildTaskInputHistory(events, actions)).toEqual(["保留的指令", "我自己说的"]);
  });

  it("不改入参", () => {
    const events = [reply("b", 2), reply("a", 1)];
    const actions = [action(2, "y", 4), action(1, "x", 3)];
    const eSnap = JSON.stringify(events);
    const aSnap = JSON.stringify(actions);
    buildTaskInputHistory(events, actions);
    expect(JSON.stringify(events)).toBe(eSnap);
    expect(JSON.stringify(actions)).toBe(aSnap);
  });
});
