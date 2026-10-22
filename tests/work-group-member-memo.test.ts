/**
 * D5-01：工作过程组的成员行 memo。
 *
 * 展开的运行中尾组每来一个事件，`task`（每个事件都换新对象）与 `liveToolOutputs`（每个增量都换新对象）都变，
 * 而原先成员行把它们整个透传下去 → 854 个成员每事件整组重渲（约 60ms）。
 * 成员行现在 `memo` + 自定义比较：工具 / verb 成员只认 member / taskId / variant / 自己那一条直播输出；
 * 事件类成员（thinking / 启动链 info）额外认「它真会读的那几个 task 字段」，不认 task 整体引用、也不认 task.events。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  EVENT_MEMBER_TASK_FIELDS,
  workGroupMemberPropsEqual,
  type WorkGroupMemberCmpProps,
} from "../src/lib/work-group-member";
import type { ToolBlock, ToolVerbGroup } from "../src/lib/tool-display";
import type { Task, TaskEvent } from "../src/lib/types";

const block = (callId = "c1"): ToolBlock => ({
  kind: "__tool_block__",
  id: `call_${callId}`,
  callId,
  name: "shell",
  status: "running",
  text: "调用 shell",
  ts: 1,
});
const verb = (): ToolVerbGroup => ({
  kind: "__tool_verb_group__",
  id: "verb_1",
  members: [block("r1"), block("r2")],
  ts: 1,
});
const thinking = (): TaskEvent =>
  ({ id: "t1", ts: 1, kind: "thinking", text: "想一想" }) as unknown as TaskEvent;

const mkTask = (extra: Record<string, unknown> = {}): Task =>
  ({
    id: "t",
    actions: [],
    repoPaths: ["/r"],
    workCwd: "/w",
    events: [],
    ...extra,
  }) as unknown as Task;

const props = (
  member: WorkGroupMemberCmpProps["member"],
  task: Task,
  extra: Partial<WorkGroupMemberCmpProps> = {},
): WorkGroupMemberCmpProps => ({
  member,
  taskId: "t",
  task,
  variant: "chat",
  ...extra,
});

describe("工具 / verb 成员：不读 task，task 与 liveToolOutputs 整体变化不重渲", () => {
  it("task 换了新对象（events 追加）→ 相等（不重渲）", () => {
    const b = block();
    const t1 = mkTask();
    const t2 = { ...t1, events: [thinking()] } as Task;
    expect(workGroupMemberPropsEqual(props(b, t1), props(b, t2))).toBe(true);
    const v = verb();
    expect(workGroupMemberPropsEqual(props(v, t1), props(v, t2))).toBe(true);
  });

  it("自己那条直播输出变了 → 不相等（要重渲）；没变 → 相等", () => {
    const b = block();
    const t = mkTask();
    expect(workGroupMemberPropsEqual(props(b, t, { liveOutput: "a" }), props(b, t, { liveOutput: "ab" }))).toBe(false);
    expect(workGroupMemberPropsEqual(props(b, t, { liveOutput: "a" }), props(b, t, { liveOutput: "a" }))).toBe(true);
  });

  it("member 引用变 / taskId 变 / variant 变 → 不相等", () => {
    const t = mkTask();
    const b = block();
    expect(workGroupMemberPropsEqual(props(b, t), props({ ...b }, t))).toBe(false);
    expect(workGroupMemberPropsEqual(props(b, t), props(b, t, { taskId: "other" }))).toBe(false);
    expect(workGroupMemberPropsEqual(props(b, t), props(b, t, { variant: "log" }))).toBe(false);
  });
});

describe("事件类成员（thinking / 启动链 info）：只认它真会读的 task 字段", () => {
  const th = thinking();

  it("task.events 追加（task 新对象）→ 相等：这是每个事件都发生的变化，必须命中", () => {
    const t1 = mkTask();
    const t2 = { ...t1, events: [th] } as Task;
    expect(workGroupMemberPropsEqual(props(th, t1), props(th, t2))).toBe(true);
  });

  for (const field of EVENT_MEMBER_TASK_FIELDS) {
    it(`task.${field} 变了 → 不相等（该行读它：路径基准目录 / 归属标 / 日常任务判定…）`, () => {
      const t1 = mkTask({ feishuStoryUrl: "https://x/1" });
      const next: Record<string, unknown> = {
        actions: [{ id: "a1" }],
        repoPaths: ["/r2"],
        workCwd: "/w2",
        eventsTruncated: true,
        feishuStoryUrl: "",
      };
      const t2 = { ...t1, [field]: next[field] } as Task;
      expect(workGroupMemberPropsEqual(props(th, t1), props(th, t2))).toBe(false);
    });
  }

  it("同一个 task 引用 → 相等（快路径）", () => {
    const t = mkTask();
    expect(workGroupMemberPropsEqual(props(th, t), props(th, t))).toBe(true);
  });
});

describe("契约：事件行读的 task 字段都在比较范围内（防以后给 EventRow 加了 task.xxx 却忘了更新比较）", () => {
  const rows = readFileSync(
    resolve(__dirname, "../src/components/tasks/event-stream/rows.tsx"),
    "utf8",
  );
  // EventRowImpl 的函数体（到 EventRow 导出为止）：AskUserRequestRow 另有自己的 task 用法、不是工作组成员
  const start = rows.indexOf("const EventRowImpl = (");
  const end = rows.indexOf("export const EventRow = memo(EventRowImpl)");
  const body = rows.slice(start, end);

  it("EventRowImpl 里读到的 task.<字段> ⊆ 比较字段 ∪ {events（仅 ask 回执 / 错误卡读，不是组成员）}", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const used = new Set([...body.matchAll(/\btask\.(\w+)/g)].map((m) => m[1]!));
    const allowed = new Set<string>([...EVENT_MEMBER_TASK_FIELDS, "events"]);
    const extra = [...used].filter((f) => !allowed.has(f));
    expect(extra, `EventRow 读了比较范围外的 task 字段：${extra.join(", ")}`).toEqual([]);
    // isLightweightDailyTask(task) 读的是 feishuStoryUrl：整个 task 传给别人的地方要么是它、要么不存在
    const passes = [...body.matchAll(/\(task\)|=\{task\}|, task[,)]/g)].map((m) => m[0]);
    expect(passes.every((p) => p === "(task)")).toBe(true);
    expect(body).toMatch(/isLightweightDailyTask\(task\)/);
  });

  it("成员行接线：WorkGroupMember 是 memo + 自定义比较；tool 成员只收自己那条直播输出", () => {
    const wg = readFileSync(
      resolve(__dirname, "../src/components/tasks/event-stream/work-group.tsx"),
      "utf8",
    );
    expect(wg).toMatch(/const WorkGroupMember = memo\(\s*WorkGroupMemberImpl,\s*workGroupMemberPropsEqual,?\s*\)/);
    // 不再把整个 liveToolOutputs 透传给成员
    expect(wg).not.toMatch(/<WorkGroupMember[^>]*liveToolOutputs=/);
    expect(wg).toMatch(/liveOutput=\{isToolBlock\(m\) \? liveToolOutputs\?\.\[m\.callId\] : undefined\}/);
  });

  it("只有含运行中工具的组才收 liveToolOutputs（已结束的组不被每个直播增量击穿 memo）", () => {
    const es = readFileSync(
      resolve(__dirname, "../src/components/tasks/event-stream.tsx"),
      "utf8",
    );
    expect(es).toMatch(
      /liveToolOutputs=\{\s*item\.hasRunning \? liveToolOutputs : undefined\s*\}/,
    );
    // 前提：直播输出只在块 status === running 时展示（否则这里漏传会让已转后台的块丢输出）
    const tb = readFileSync(
      resolve(__dirname, "../src/components/tasks/event-stream/tool-block.tsx"),
      "utf8",
    );
    expect(tb).toMatch(/block\.status === "running" && liveOutput\s*\?\s*liveOutput/);
  });
});
