/**
 * 行视图状态的 key：taskId / 行 id / 字段 三个组成部分都要钉住（R4 §3「接线正确性」）。
 *
 * 第三轮 review 的 mutation：工具块 key 里的行 id 换成常量 "x"（所有工具块共用一份状态）、
 * 工作组 key 里的 taskId 换成 ""（跨任务共享）、思考行 key 用 ev.ts 代替 ev.id——旧的接线契约
 * 只钉了「调没调 useRowViewState」与「字段名互不相同」，三种 mutation 全绿。
 *
 * 做法（把调用点决策抽成纯函数）：各行组件不再自己拼 `rowViewStateKey(...)`，统一走
 * `src/lib/row-view-keys.ts` 的四个 helper。helper 是纯函数、这里用真事件 + 真分组管线做行为断言；
 * 组件侧只剩「实参必须恰好是 (taskId, block|group|ev…, ROW_VIEW_FIELD.xxx)」这一条源码契约，
 * 换成常量 / 空串 / ev.ts 都会红。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import { useRowViewState } from "../src/hooks/use-row-view-state";
import { groupChatRenderItems, type WorkGroupItem } from "../src/lib/chat-turns";
import { rowViewStateStore } from "../src/lib/event-row-view-state";
import {
  ROW_VIEW_FIELD,
  eventRowViewKey,
  toolRowViewKey,
  userEditViewKeys,
  verbGroupViewKey,
  workGroupViewKey,
} from "../src/lib/row-view-keys";
import {
  isToolVerbGroup,
  mergeToolDisplayEvents,
  type ToolBlock,
  type ToolVerbGroup,
} from "../src/lib/tool-display";
import type { TaskEvent } from "../src/lib/types";

let clock = 0;
const mk = (kind: string, id: string, extra: Partial<TaskEvent> = {}): TaskEvent =>
  ({ id, ts: ++clock, kind, text: kind, ...extra }) as unknown as TaskEvent;
const call = (cid: string, name: string) =>
  mk("tool_call", `call_${cid}`, { meta: { callId: cid, name, args: "{}" } });
const res = (cid: string, name: string) =>
  mk("tool_result", `res_${cid}`, {
    meta: { callId: cid, name, status: "success", output: "o" },
  });

const blocksOf = (events: TaskEvent[]): ToolBlock[] => {
  const items = mergeToolDisplayEvents(events);
  return items.filter((i): i is ToolBlock => i.kind === "__tool_block__");
};

describe("ROW_VIEW_FIELD", () => {
  it("字段名各不相同、非空、不含 key 分隔符", () => {
    const values = Object.values(ROW_VIEW_FIELD);
    expect(values.length).toBeGreaterThanOrEqual(11);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) {
      expect(v.length).toBeGreaterThan(0);
      expect(v).not.toContain("\u001f");
    }
  });
});

describe("toolRowViewKey：taskId / 行 / 字段，缺一不可", () => {
  const [a, b] = blocksOf([call("a", "read"), res("a", "read"), call("b", "shell"), res("b", "shell")]);
  const F = ROW_VIEW_FIELD.toolManualCollapsed;

  it("同参数同 key；任一组成部分变就换 key", () => {
    const base = toolRowViewKey("t1", a!, F);
    expect(toolRowViewKey("t1", a!, F)).toBe(base);
    expect(toolRowViewKey("t2", a!, F)).not.toBe(base); // taskId
    expect(toolRowViewKey("t1", b!, F)).not.toBe(base); // 行
    expect(toolRowViewKey("t1", a!, ROW_VIEW_FIELD.toolOutputOpen)).not.toBe(base); // 字段
  });

  it("行身份来自块本身（callId），不是时间戳：同 ts 的两个块不会共用一份状态", () => {
    const x = { ...a!, ts: 42 };
    const y = { ...b!, ts: 42 };
    expect(toolRowViewKey("t1", x, F)).not.toBe(toolRowViewKey("t1", y, F));
  });

  it("task 没有名字（空串）也不会和别的 task 串：空 taskId 的 key 不等于 t1 的", () => {
    expect(toolRowViewKey("", a!, F)).not.toBe(toolRowViewKey("t1", a!, F));
  });

  it("写进 store 的 key 能被 clearTask(taskId) 清到，且不波及别的任务", () => {
    rowViewStateStore.clear();
    rowViewStateStore.set(toolRowViewKey("task-a", a!, F), true);
    rowViewStateStore.set(toolRowViewKey("task-b", a!, F), true);
    expect(rowViewStateStore.clearTask("task-a")).toBe(1);
    expect(rowViewStateStore.has(toolRowViewKey("task-b", a!, F))).toBe(true);
    rowViewStateStore.clear();
  });
});

describe("workGroupViewKey / verbGroupViewKey / eventRowViewKey", () => {
  const evs = [
    mk("user_reply", "u1"),
    mk("thinking", "t1"),
    call("a", "read"),
    res("a", "read"),
    call("b", "read"),
    res("b", "read"),
    mk("assistant_message", "m1"),
    mk("thinking", "t2"),
    call("c", "shell"),
    res("c", "shell"),
  ];
  const items = groupChatRenderItems(mergeToolDisplayEvents(evs));
  const groups = items.filter((i): i is WorkGroupItem => i.kind === "__work_group__");

  it("工作组：taskId / 组 id / 字段各自参与", () => {
    const [g1, g2] = groups;
    const k = workGroupViewKey("t1", g1!, ROW_VIEW_FIELD.workManual);
    expect(workGroupViewKey("t2", g1!, ROW_VIEW_FIELD.workManual)).not.toBe(k);
    expect(workGroupViewKey("t1", g2!, ROW_VIEW_FIELD.workManual)).not.toBe(k);
    expect(workGroupViewKey("t1", g1!, ROW_VIEW_FIELD.workPinned)).not.toBe(k);
  });

  it("verb 组：用首个事件的稳定身份，随组向后追加不变", () => {
    const verb = groups[0]!.members.find(isToolVerbGroup) as ToolVerbGroup;
    expect(verb).toBeTruthy();
    const k = verbGroupViewKey("t1", verb, ROW_VIEW_FIELD.verbCollapsed);
    expect(verbGroupViewKey("t2", verb, ROW_VIEW_FIELD.verbCollapsed)).not.toBe(k);
    // 再追加一个读 → verb 组多一个成员、id 不变
    const more = groupChatRenderItems(
      mergeToolDisplayEvents([...evs.slice(0, 6), call("d", "grep"), res("d", "grep")]),
    );
    const verb2 = (more.find((i) => i.kind === "__work_group__") as WorkGroupItem).members.find(
      isToolVerbGroup,
    ) as ToolVerbGroup;
    expect(verb2.members.length).toBe(3);
    expect(verbGroupViewKey("t1", verb2, ROW_VIEW_FIELD.verbCollapsed)).toBe(k);
  });

  it("事件行：taskId / 事件 id / 字段各自参与；同 ts 的两条事件不串", () => {
    const k = eventRowViewKey("t1", "ev1", ROW_VIEW_FIELD.eventManualCollapsed);
    expect(eventRowViewKey("t2", "ev1", ROW_VIEW_FIELD.eventManualCollapsed)).not.toBe(k);
    expect(eventRowViewKey("t1", "ev2", ROW_VIEW_FIELD.eventManualCollapsed)).not.toBe(k);
    expect(eventRowViewKey("t1", "ev1", ROW_VIEW_FIELD.userEditing)).not.toBe(k);
  });
});

describe("userEditViewKeys：用户消息原地编辑的 editing / 草稿（R4-05）", () => {
  it("editing 与草稿是两个字段；换 task / 换消息都不串", () => {
    const k = userEditViewKeys("t1", "u1");
    expect(k.editing).not.toBe(k.draft);
    expect(userEditViewKeys("t2", "u1").draft).not.toBe(k.draft);
    expect(userEditViewKeys("t1", "u2").draft).not.toBe(k.draft);
    expect(userEditViewKeys("t1", "u1")).toEqual(k);
  });

  describe("行被虚拟列表卸载再挂回：已敲的字和编辑态都在", () => {
    beforeEach(() => rowViewStateStore.clear());
    const mount = (node: ReactNode): string => renderToStaticMarkup(node as never);
    let setDraft: ((v: string) => void) | null = null;
    let setEditing: ((v: boolean) => void) | null = null;

    const Row = ({ taskId, evId }: { taskId: string; evId: string }) => {
      const keys = userEditViewKeys(taskId, evId);
      const [editing, setE] = useRowViewState<boolean>(keys.editing, false);
      const [draft, setD] = useRowViewState<string>(keys.draft, "");
      setEditing = setE;
      setDraft = setD;
      return createElement("span", null, `${editing}|${draft}`);
    };

    it("编辑中途滚走（卸载）→ 滚回来仍在编辑态、草稿原样", () => {
      expect(mount(createElement(Row, { taskId: "t1", evId: "u1" }))).toBe("<span>false|</span>");
      setEditing!(true);
      setDraft!("改成：把登录页的校验改成异步");
      expect(mount(createElement(Row, { taskId: "t1", evId: "u1" }))).toBe(
        "<span>true|改成：把登录页的校验改成异步</span>",
      );
    });

    it("别的消息 / 别的任务里同 id 的行不受影响", () => {
      mount(createElement(Row, { taskId: "t1", evId: "u1" }));
      setDraft!("草稿 A");
      expect(mount(createElement(Row, { taskId: "t1", evId: "u2" }))).toBe("<span>false|</span>");
      expect(mount(createElement(Row, { taskId: "t2", evId: "u1" }))).toBe("<span>false|</span>");
    });
  });
});

/**
 * 源码契约：组件里每个 key 都只能由 helper 产出，实参恰好是 (taskId, 行对象 / ev.id, ROW_VIEW_FIELD.xxx)。
 * 把 taskId 换成 ""、行换成常量 / ev.ts、字段写成裸字符串，都会红。
 */
describe("各行组件接线（源码契约：三个组成部分都用对）", () => {
  const read = (rel: string): string => readFileSync(path.join(__dirname, "..", rel), "utf8");
  const FILES = {
    TOOL: read("src/components/tasks/event-stream/tool-block.tsx"),
    WORK: read("src/components/tasks/event-stream/work-group.tsx"),
    ROWS: read("src/components/tasks/event-stream/rows.tsx"),
  };

  // helper 名 → 第二个实参允许的写法
  const SECOND_ARG: Record<string, RegExp> = {
    toolRowViewKey: /^block$/,
    workGroupViewKey: /^group$/,
    verbGroupViewKey: /^group$/,
    eventRowViewKey: /^ev\.id$/,
    userEditViewKeys: /^ev\.id$/,
  };

  const calls = (src: string) =>
    [...src.matchAll(/\b(toolRowViewKey|workGroupViewKey|verbGroupViewKey|eventRowViewKey|userEditViewKeys)\(\s*([^()]*?)\s*\)/g)].map(
      (m) => ({ helper: m[1]!, args: m[2]!.split(",").map((s) => s.trim()).filter(Boolean) }),
    );

  it("组件里不再直接拼 rowViewStateKey（必须经 helper，三要素才有行为测试守着）", () => {
    for (const [name, src] of Object.entries(FILES)) {
      expect(src, name).not.toMatch(/\browViewStateKey\(/);
    }
  });

  it("每个 helper 调用：第一个实参 taskId、第二个实参是行对象本身、字段是 ROW_VIEW_FIELD.<已登记字段>", () => {
    let total = 0;
    for (const [name, src] of Object.entries(FILES)) {
      for (const c of calls(src)) {
        total++;
        const where = `${name}: ${c.helper}(${c.args.join(", ")})`;
        expect(c.args[0], where).toBe("taskId");
        expect(c.args[1], where).toMatch(SECOND_ARG[c.helper]!);
        if (c.helper !== "userEditViewKeys") {
          const m = /^ROW_VIEW_FIELD\.(\w+)$/.exec(c.args[2] ?? "");
          expect(m, `${where}（字段必须是 ROW_VIEW_FIELD.xxx）`).toBeTruthy();
          expect(Object.keys(ROW_VIEW_FIELD), where).toContain(m![1]);
        } else {
          expect(c.args.length, where).toBe(2);
        }
      }
    }
    // 工具块 4 + 待办 1 + verb 1 + 工作组 2 + 事件行 1 + 用户消息编辑 1 = 10
    expect(total).toBeGreaterThanOrEqual(10);
  });

  it("每个 ROW_VIEW_FIELD 字段至多被一个 useRowViewState 使用（两个状态共用一个字段 = 串状态）", () => {
    const all = Object.values(FILES).join("\n");
    for (const field of Object.keys(ROW_VIEW_FIELD)) {
      const uses = [...all.matchAll(new RegExp(`ROW_VIEW_FIELD\\.${field}\\b`, "g"))].length;
      expect(uses, field).toBeLessThanOrEqual(1);
    }
  });

  it("用户消息的 editing / editDraft 走 store；超长展开 / 飞行锁等瞬时态仍是普通 state", () => {
    expect(FILES.ROWS).toMatch(/const \[editing, setEditing\] = useRowViewState/);
    expect(FILES.ROWS).toMatch(/const \[editDraft, setEditDraft\] = useRowViewState/);
    // 草稿不再有 useState 版本（排队气泡自己的 `editing` 是另一个组件、仍是 useState，别误伤）
    expect(FILES.ROWS).not.toMatch(/const \[editDraft, setEditDraft\] = useState/);
    expect(FILES.ROWS.match(/const \[editing, setEditing\] = useState/g)?.length).toBe(1);
    // 只有用户消息才读写存档（别的事件行传 null key，不白占 LRU）
    expect(FILES.ROWS).toMatch(/ev\.kind === "user_reply" \? userEditViewKeys\(taskId, ev\.id\) : null/);
    // 重挂恢复编辑态不抢焦点：autoFocus 只认「点编辑按钮进入」
    expect(FILES.ROWS).toMatch(/autoFocus=\{autoFocusEditRef\.current\}/);
    // 飞行锁是瞬时态：重挂后没有在飞的请求可接，不进存档
    expect(FILES.ROWS).toMatch(/const \[editSubmitting, setEditSubmitting\] = useState/);
  });

  it("工作组成员 / verb 成员的 React key 用稳定身份（并组、合并待办时不 remount）", () => {
    expect(FILES.WORK).toMatch(/key=\{streamItemStableId\(m\)\}/);
    expect(FILES.TOOL).toMatch(/key=\{streamItemStableId\(m\)\}/);
    expect(FILES.WORK).not.toMatch(/key=\{m\.id\}/);
  });

  it("work-group.tsx 的组 id 注释与实现一致（不再声称「组 id = 第一个成员的 id」）", () => {
    expect(FILES.WORK).not.toMatch(/组 id = 第一个成员的 id/);
    expect(FILES.WORK).toMatch(/稳定身份/);
  });
});
