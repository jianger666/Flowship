/**
 * 属主主 run 与旁路群答疑 run 的运行态拆分（第三轮 review D6-02 / R3-05）
 *
 * 〔第四轮 Q5-01：task 页的 isRunning 不再并入旁路在飞——旁路过程事件整条被 isHiddenFromEventStream 藏进
 * 「群问答」tab，主流里没有旁路工具块要画；并入只剩副作用（组尾「处理中…」转圈）。下面是第三轮的原始背景。〕
 * 当时 task 页 `isRunning = runActive || restrictedRunActive`，同一个 isRunning 还被两件「只该看主任务」的事共用：
 *   - D6-02：错误卡「当轮失败」资格 = `!runActive && 最新错误`——主任务因鉴权 / 额度失败后，群里来个提问、
 *     旁路 run 起来，错误卡整张翻篇（「去设置 / 重新推进」消失、样式变灰），旁路结束又弹回来；
 *   - R3-05：状态行槽位 `reserveTaskStatusSlot = !isChat && isRunning`——空闲任务为旁路撑开一个 28px 空槽并动画伸缩。
 *
 * 拆法：EventStream 新增 `mainRunActive`（缺省 = isRunning，chat 没有旁路、两者同值）；
 * 页面传 `mainRunActive={runActive}`；错误卡资格 / 状态行 / 状态槽读它，工具渲染仍读 isRunning。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isCurrentErrorCard, resolveErrorRecovery } from "../src/lib/chat-turns";
import { deriveRunFlags } from "../src/lib/owner-run-signal";
import type { TaskEvent } from "../src/lib/types";

let seq = 0;
const ev = (p: Partial<TaskEvent> & Pick<TaskEvent, "kind">): TaskEvent => {
  seq += 1;
  return { id: p.id ?? `e${seq}`, text: "", ts: seq, ...p };
};

describe("deriveRunFlags（第四轮 Q5-01：旁路不再并入 isRunning）", () => {
  it("isRunning 与 mainRunActive 同值，只看属主主 run", () => {
    expect(deriveRunFlags({ runActive: false })).toEqual({
      isRunning: false,
      mainRunActive: false,
    });
    expect(deriveRunFlags({ runActive: true })).toEqual({
      isRunning: true,
      mainRunActive: true,
    });
  });

  it("旧口径的反例：仅旁路在飞（属主空闲）时，组尾 / 占位 / 输入条看到的都是「没在跑」", () => {
    // restrictedRunActive 已不是入参；即使有人硬传，也不得影响结果
    const flags = deriveRunFlags({
      runActive: false,
      runStatus: "idle",
      restrictedRunActive: true,
    } as unknown as Parameters<typeof deriveRunFlags>[0]);
    expect(flags).toEqual({ isRunning: false, mainRunActive: false });
  });
});


describe("D6-02：主任务失败后旁路群答疑在飞，错误卡不翻篇", () => {
  // 主任务：action_start → 鉴权失败的 error（头部「失败」、runActive 已放）
  const events = [
    ev({ id: "as", kind: "action_start", text: "开始 build" }),
    ev({ id: "err", kind: "error", text: "Agent 运行失败：401 unauthorized" }),
  ];

  it("旁路在飞 ≡ 属主空闲：isRunning / mainRunActive 都不被旁路带偏，错误卡仍是当轮失败（第四轮 Q5-01 起 isRunning 也同口径）", () => {
    const flags = deriveRunFlags({ runActive: false });
    expect(isCurrentErrorCard(events, "err", flags.isRunning)).toBe(true);
  });

  it("新口径（mainRunActive）：旁路在飞时错误卡仍是当轮失败，恢复入口还在", () => {
    const flags = deriveRunFlags({ runActive: false });
    expect(isCurrentErrorCard(events, "err", flags.mainRunActive)).toBe(true);
    // 恢复入口（task 形态：重新推进）也还在——页面上就是「去设置 / 重新推进」按钮
    expect(resolveErrorRecovery(events, "err", { mode: "task" }).kind).toBe("readvance");
  });

  it("主 run 真在跑：错误卡翻篇（已有新一轮，旧错误不再给入口）", () => {
    const flags = deriveRunFlags({ runActive: true });
    expect(isCurrentErrorCard(events, "err", flags.mainRunActive)).toBe(false);
  });

  it("不是最新错误（之后又有新事件）永远不是当轮失败，与旁路无关", () => {
    const later = [...events, ev({ kind: "user_reply", text: "继续" })];
    expect(isCurrentErrorCard(later, "err", false)).toBe(false);
  });
});

// ---------- 接线契约（组件进不了 vitest 的 node 环境：只钉最小的接线点，行为由上面的纯函数测试守） ----------

const read = (rel: string) => readFileSync(path.join(__dirname, "..", rel), "utf8");
const eventStream = read("src/components/tasks/event-stream.tsx");
const page = read("src/app/tasks/[id]/page.tsx");
const errorCard = read("src/components/tasks/event-stream/error-card.tsx");

describe("接线（R3-05 / D6-02）", () => {
  it("页面：两个运行态都来自 deriveRunFlags，分别传给 isRunning / mainRunActive", () => {
    expect(page).toContain("deriveRunFlags({ runActive, runStatus: task.runStatus })");
    expect(page).toContain("isRunning={runFlags.isRunning}");
    expect(page).toContain("mainRunActive={runFlags.mainRunActive}");
  });

  it("EventStream：状态行 / 状态槽 / 错误卡行读 mainRunActive，缺省 = isRunning", () => {
    expect(eventStream).toContain("mainRunActive = isRunning");
    expect(eventStream).toMatch(/const activeStatus = useMemo\(\(\) => \{[\s\S]{0,200}if \(!mainRunActive\) return null;/);
    expect(eventStream).toContain("const reserveTaskStatusSlot = !isChat && mainRunActive;");
    expect(eventStream).toContain("runActive={mainRunActive}");
  });

  it("错误卡的当轮资格走 isCurrentErrorCard（单点判定）", () => {
    expect(errorCard).toContain("isCurrentErrorCard(events, ev.id, !!runActive)");
  });
});
