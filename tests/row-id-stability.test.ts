/**
 * R4-01 / R4-02 / V8-04：事件流「行身份」逐前缀稳定性（性质测试，喂真实分组管线）。
 *
 * 背景：折叠 / 展开状态按「行 id」存档（`event-row-view-state`），Virtuoso / React 的 key 也是行 id。
 * 只要流式过程中某个已经出现过的 id 在下一帧消失（换成了别的 id），整行 remount、用户点开 / 收起的状态
 * 被无声还原。第三轮 review 的合成分布里，turn 内「顶层 id 消失」的比例是 4% / 18% / 36%：
 *   - 读类工具连续完成：`WG:call_a → WG:verb_call_a`（工作过程组 id 取首成员 id，首成员由单块并成 verb 组后 id 变了）；
 *   - 连续 `todo_write`：合并块的 id 取最新一条 call，agent 每更新一次待办就换 key；
 *   - 分页边界劈开 call / result：尾页里的孤儿 `tool_result` 按自己的 id 成组，补上上一页后翻成 call 的 id。
 *
 * 这里的断言：对一个会话的事件序列逐条增长（= 流式 / 逐条落盘），任一前缀里出现过的
 *   ① 顶层 item id（Virtuoso key、工作过程组存档 key）
 *   ② 所有层级的行身份（工作过程组成员 / verb 组成员的 React key 与存档 key）
 * 在后续前缀里必须仍然存在。分页补页（尾页 → 更长的尾页）同理，唯一的例外见最后一组「已知限制」。
 */
import { describe, expect, it } from "vitest";

import {
  groupChatRenderItems,
  type ChatRenderItem,
  type WorkGroupItem,
} from "../src/lib/chat-turns";
import { coalesceAdjacentThinking } from "../src/lib/merge-thinking";
import {
  mergeToolDisplayEvents,
  isToolBlock,
  type ToolBlock,
  isToolVerbGroup,
  streamItemStableId,
} from "../src/lib/tool-display";
import {
  ROW_VIEW_FIELD,
  eventRowViewKey,
  toolRowViewKey,
  verbGroupViewKey,
  workGroupViewKey,
} from "../src/lib/row-view-keys";
import type { TaskEvent } from "../src/lib/types";

// ---------- 事件构造 ----------

let clock = 0;
const mk = (
  kind: TaskEvent["kind"],
  id: string,
  extra: Partial<TaskEvent> = {},
): TaskEvent =>
  ({ id, ts: ++clock, kind, text: kind, ...extra }) as unknown as TaskEvent;

const user = (id: string) => mk("user_reply", id);
const think = (id: string) => mk("thinking", id);
const asst = (id: string) => mk("assistant_message", id);
const call = (cid: string, name: string, args: unknown = {}) =>
  mk("tool_call", `call_${cid}`, {
    meta: { callId: cid, name, args: JSON.stringify(args) },
  });
const res = (cid: string, name: string) =>
  mk("tool_result", `res_${cid}`, {
    meta: { callId: cid, name, status: "success", output: "o" },
  });
const todoArgs = (n: number) => ({
  todos: [{ id: "1", content: `x${n}`, status: "pending" }],
});

/** 与 EventStream 的 buildStreamItems 同一条纯管线（去掉只依赖运行态的几步） */
const build = (events: TaskEvent[]): ChatRenderItem[] =>
  groupChatRenderItems(
    mergeToolDisplayEvents([...coalesceAdjacentThinking(events)]),
  );

// ---------- 身份收集 ----------

type Identities = { top: Set<string>; all: Set<string>; workKeys: Set<string> };

/**
 * 一个渲染结果里所有会被当作 key 用的身份。
 * `verbKeys: false` = 不收 verb 组自己的折叠 key（已知限制，见文件末尾：并行读乱序完成、更早的那个最后完成时，
 * verb 组向「前」长大，首成员换了，组自己的折叠 key 随之换；组内各块的状态按块身份存、不受影响）。
 */
const collect = (
  items: ChatRenderItem[],
  taskId = "t",
  verbKeys = true,
): Identities => {
  const top = new Set<string>();
  const all = new Set<string>();
  const workKeys = new Set<string>();
  const addBlock = (b: Parameters<typeof toolRowViewKey>[1]) => {
    all.add(streamItemStableId(b as ToolBlock));
    workKeys.add(toolRowViewKey(taskId, b, ROW_VIEW_FIELD.toolManualCollapsed));
    workKeys.add(toolRowViewKey(taskId, b, ROW_VIEW_FIELD.todoCollapsed));
  };
  for (const it of items) {
    top.add(it.id);
    all.add(it.id);
    if (it.kind !== "__work_group__") continue;
    const g = it as WorkGroupItem;
    workKeys.add(workGroupViewKey(taskId, g, ROW_VIEW_FIELD.workManual));
    workKeys.add(workGroupViewKey(taskId, g, ROW_VIEW_FIELD.workPinned));
    for (const m of g.members) {
      all.add(streamItemStableId(m));
      if (isToolBlock(m)) addBlock(m);
      else if (isToolVerbGroup(m)) {
        if (verbKeys) {
          workKeys.add(verbGroupViewKey(taskId, m, ROW_VIEW_FIELD.verbCollapsed));
        }
        for (const n of m.members) addBlock(n);
      } else {
        workKeys.add(eventRowViewKey(taskId, m.id, ROW_VIEW_FIELD.eventManualCollapsed));
      }
    }
  }
  return { top, all, workKeys };
};

const lost = (before: Set<string>, after: Set<string>): string[] =>
  [...before].filter((k) => !after.has(k));

/** 逐前缀断言：先前出现过的身份在后续前缀里仍存在 */
const assertPrefixStable = (
  label: string,
  events: TaskEvent[],
  opts: { verbKeys?: boolean } = {},
): void => {
  const everTop = new Set<string>();
  const everAll = new Set<string>();
  const everKeys = new Set<string>();
  for (let i = 1; i <= events.length; i++) {
    const cur = collect(build(events.slice(0, i)), "t", opts.verbKeys ?? true);
    const lostTop = lost(everTop, cur.top);
    const lostAll = lost(everAll, cur.all);
    const lostKeys = lost(everKeys, cur.workKeys);
    const where = `${label} @事件#${i}(${events[i - 1]!.id})`;
    const show = (ks: string[]) => JSON.stringify(ks.map((k) => k.replaceAll("\u001f", "|")));
    expect(lostTop, `${where} 顶层 id 消失 ${show(lostTop)}`).toEqual([]);
    expect(lostAll, `${where} 行身份消失 ${show(lostAll)}`).toEqual([]);
    expect(lostKeys, `${where} 存档 key 消失 ${show(lostKeys)}`).toEqual([]);
    cur.top.forEach((k) => everTop.add(k));
    cur.all.forEach((k) => everAll.add(k));
    cur.workKeys.forEach((k) => everKeys.add(k));
  }
};

// ---------- 点名场景（报告 keys.test.ts 的 S1…S6） ----------

describe("R4-01：读类工具连续完成 → 工作过程组 id 不翻转", () => {
  it("S1 读打头（无思考）：read A 完成后组 id 是什么，read B / grep 并进来后仍是它", () => {
    const evs = [
      user("u1"),
      call("a", "read", { path: "/a" }),
      res("a", "read"),
      call("b", "read", { path: "/b" }),
      res("b", "read"),
      call("c", "grep", { pattern: "x" }),
      res("c", "grep"),
      call("e", "edit", { path: "/a" }),
      res("e", "edit"),
      asst("m1"),
    ];
    assertPrefixStable("S1", evs);
    const groupId = (n: number) =>
      build(evs.slice(0, n)).find((i) => i.kind === "__work_group__")!.id;
    // 第一个读完成（单块）与两个读并成 verb 组之后，是同一个组 id
    expect(groupId(3)).toBe(groupId(5));
    expect(groupId(3)).toBe(groupId(7));
    expect(groupId(3)).toBe(groupId(9));
  });

  it("S2 思考打头：组 id 始终是思考 id；并组前后的读块身份都在", () => {
    const evs = [
      user("u1"),
      think("t1"),
      call("a", "read", { path: "/a" }),
      res("a", "read"),
      call("b", "read", { path: "/b" }),
      res("b", "read"),
      asst("m1"),
    ];
    assertPrefixStable("S2", evs);
    expect(build(evs.slice(0, 6)).find((i) => i.kind === "__work_group__")!.id).toBe(
      "t1",
    );
  });

  it("S4 并行读：最慢的完成时（三个一起并成 verb 组）组 id 不翻", () => {
    const evs = [
      user("u1"),
      call("a", "read", { path: "/a" }),
      call("b", "read", { path: "/b" }),
      call("c", "read", { path: "/c" }),
      res("a", "read"),
      res("c", "read"),
      res("b", "read"),
      asst("m1"),
    ];
    assertPrefixStable("S4", evs);
  });
});

describe("R4-02：连续待办更新 → 待办卡的存档 key 不随最新 call 变", () => {
  const evs = [
    user("u1"),
    think("t1"),
    call("t_a", "todo_write", todoArgs(1)),
    res("t_a", "todo_write"),
    call("t_b", "todo_write", todoArgs(2)),
    res("t_b", "todo_write"),
    call("t_c", "todo_write", todoArgs(3)),
    res("t_c", "todo_write"),
    asst("m1"),
  ];

  it("S3 逐前缀：待办卡的行身份 / 折叠 key 一直在", () => {
    assertPrefixStable("S3", evs);
  });

  it("合并块的 stableId = 首条待办；折叠 key 用它，而不是最新 call 的 id", () => {
    const todoBlock = (n: number) => {
      const g = build(evs.slice(0, n)).find((i) => i.kind === "__work_group__") as WorkGroupItem;
      return g.members.find((m) => isToolBlock(m) && m.name === "todo_write")!;
    };
    const first = todoBlock(4);
    const latest = todoBlock(8);
    if (!isToolBlock(first) || !isToolBlock(latest)) throw new Error("expected tool blocks");
    // id 仍跟随最新（兼容既有用法）；身份与存档 key 不变
    expect(latest.id).toBe("call_t_c");
    expect(latest.stableId).toBe(first.stableId ?? streamItemStableId(first));
    expect(toolRowViewKey("t", latest, ROW_VIEW_FIELD.todoCollapsed)).toBe(
      toolRowViewKey("t", first, ROW_VIEW_FIELD.todoCollapsed),
    );
  });

  it("待办打头的工作组：组 id 也不随待办更新翻转", () => {
    const only = [
      user("u1"),
      call("t_a", "todo_write", todoArgs(1)),
      res("t_a", "todo_write"),
      call("t_b", "todo_write", todoArgs(2)),
      res("t_b", "todo_write"),
    ];
    assertPrefixStable("todo-first", only);
    expect(build(only.slice(0, 3)).find((i) => i.kind === "__work_group__")!.id).toBe(
      build(only.slice(0, 5)).find((i) => i.kind === "__work_group__")!.id,
    );
  });
});

describe("V8-04：分页边界劈开 call / result", () => {
  const full = [
    user("u1"),
    call("a", "read", { path: "/a" }),
    res("a", "read"),
    call("b", "read", { path: "/b" }),
    res("b", "read"),
    asst("m1"),
  ];

  it("S5 尾页里的孤儿 tool_result：补上上一页后，工作组 id / 块身份 / 存档 key 不变", () => {
    const tail = collect(build(full.slice(2)));
    const whole = collect(build(full));
    expect(lost(tail.top, whole.top)).toEqual([]);
    expect(lost(tail.all, whole.all)).toEqual([]);
    expect(lost(tail.workKeys, whole.workKeys)).toEqual([]);
  });

  it("孤儿块的 stableId 只由 callId 决定（与 call 到场后的块一致），不依赖 result 事件自己的 id", () => {
    const orphan = build([res("a", "read"), asst("m1")]);
    const paired = build([call("a", "read", { path: "/a" }), res("a", "read"), asst("m1")]);
    const pick = (items: ChatRenderItem[]) => {
      const g = items[0] as WorkGroupItem;
      return streamItemStableId(g.members[0]!);
    };
    expect(pick(orphan)).toBe(pick(paired));
    expect(orphan[0]!.id).toBe(paired[0]!.id);
  });
});

// ---------- 合成分布：随机会话 ----------

/** mulberry32：可复现的伪随机 */
const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const TOOLS = ["read", "grep", "read", "shell", "edit", "todo_write"] as const;

/**
 * 生成一个会话：若干 turn，每个 turn = 用户消息 +（可选思考）+ 若干工具（顺序或并行批）+（可选 AI 正文）。
 * `todo` 关闭时不产生待办（分页补页对待办有已知限制，见最后一组）。
 */
const genSession = (
  seed: number,
  opts: { todo: boolean; inOrder?: boolean },
): TaskEvent[] => {
  const r = rng(seed);
  const evs: TaskEvent[] = [];
  let n = 0;
  const turns = 2 + Math.floor(r() * 4);
  for (let t = 0; t < turns; t++) {
    evs.push(user(`u${seed}_${t}`));
    if (r() < 0.5) evs.push(think(`t${seed}_${t}`));
    const calls = 1 + Math.floor(r() * 8);
    let i = 0;
    while (i < calls) {
      const batch = r() < 0.3 ? Math.min(calls - i, 2 + Math.floor(r() * 3)) : 1;
      const names: string[] = [];
      for (let k = 0; k < batch; k++) {
        let name: string = TOOLS[Math.floor(r() * TOOLS.length)]!;
        if (name === "todo_write" && !opts.todo) name = "read";
        names.push(name);
      }
      const ids = names.map(() => `${seed}_${++n}`);
      names.forEach((name, k) =>
        evs.push(call(ids[k]!, name, name === "todo_write" ? todoArgs(n) : { path: `/f${ids[k]}` })),
      );
      // 并行批的结果：inOrder = 按调用顺序返回；否则乱序返回
      const order = ids.map((_, k) => k);
      if (!opts.inOrder) order.sort(() => r() - 0.5);
      for (const k of order) evs.push(res(ids[k]!, names[k]!));
      i += batch;
    }
    if (r() < 0.7) evs.push(asst(`m${seed}_${t}`));
  }
  return evs;
};

describe("性质：逐前缀，先前出现过的顶层 / 成员 id 在后续前缀里仍存在", () => {
  it("300 个随机会话（读类 / 搜类 / shell / edit / 待办 / 并行批按序返回 / 思考打头与否）：顶层 id、成员身份、全部存档 key 一个不丢", () => {
    for (let seed = 1; seed <= 300; seed++) {
      assertPrefixStable(`seed ${seed}`, genSession(seed, { todo: true, inOrder: true }));
    }
  });

  it("并行批乱序返回：顶层 id、成员身份、除 verb 组自己折叠 key 以外的存档 key 一个不丢", () => {
    for (let seed = 1; seed <= 300; seed++) {
      assertPrefixStable(`seed ${seed}`, genSession(seed, { todo: true }), {
        verbKeys: false,
      });
    }
  });
});

describe("性质：分页补页（尾页 → 更长的尾页）不丢行身份", () => {
  it("无待办的 300 个随机会话 × 若干切点：成员身份并集只增不减；顶层 id 要么还在、要么被向前扩展的同一工作组吸收", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const evs = genSession(seed, { todo: false });
      const r = rng(seed * 7919);
      for (let rep = 0; rep < 4; rep++) {
        const k1 = 1 + Math.floor(r() * (evs.length - 1));
        const k2 = Math.floor(r() * k1);
        const tail = build(evs.slice(k1));
        const longer = build(evs.slice(k2));
        const a = collect(tail);
        const b = collect(longer);
        const where = `seed ${seed} 切点 ${k1}→${k2}`;
        expect(lost(a.all, b.all), `${where} 行身份消失`).toEqual([]);
        // 顶层 id：还在；或是工作组，且其全部成员身份都落进了补页后的某个工作组（组向前长大了）
        const groupsAfter = longer.filter((i) => i.kind === "__work_group__") as WorkGroupItem[];
        const membersOf = (g: WorkGroupItem): string[] => {
          const out: string[] = [];
          for (const m of g.members) {
            out.push(streamItemStableId(m));
            if (isToolVerbGroup(m)) for (const x of m.members) out.push(streamItemStableId(x));
          }
          return out;
        };
        for (const it of tail) {
          if (b.top.has(it.id)) continue;
          expect(it.kind, `${where} 顶层 ${it.id} 消失且不是工作组`).toBe("__work_group__");
          const mine = membersOf(it as WorkGroupItem);
          const absorbed = groupsAfter.some((g) => {
            const theirs = new Set(membersOf(g));
            return mine.every((x) => theirs.has(x));
          });
          expect(absorbed, `${where} 工作组 ${it.id} 没被补页后的组吸收`).toBe(true);
        }
      }
    }
  });
});

describe("已知限制（记账，不是修复）：verb 组向「前」长大时，组自己的折叠 key 随新的首成员变", () => {
  it("三个并行读乱序完成、最早发起的最后完成：verb 组首成员从 b 换成 a；工作组 id、各块身份都不变", () => {
    const evs = [
      user("u1"),
      call("a", "read", { path: "/a" }),
      call("b", "read", { path: "/b" }),
      call("c", "read", { path: "/c" }),
      res("c", "read"),
      res("b", "read"),
      res("a", "read"),
    ];
    const verbOf = (n: number) => {
      const g = build(evs.slice(0, n)).find((i) => i.kind === "__work_group__") as WorkGroupItem;
      return g.members.find(isToolVerbGroup);
    };
    const before = verbOf(6)!; // b、c 已完成，a 还在跑 → verb(b, c)
    const after = verbOf(7)!; // a 完成 → verb(a, b, c)
    expect(before.members.length).toBe(2);
    expect(after.members.length).toBe(3);
    expect(verbGroupViewKey("t", before, ROW_VIEW_FIELD.verbCollapsed)).not.toBe(
      verbGroupViewKey("t", after, ROW_VIEW_FIELD.verbCollapsed),
    );
    // 工作组 id 与各块身份都在
    assertPrefixStable("verb-head", evs, { verbKeys: false });
  });
});

describe("已知限制（记账，不是修复）：分页补页让工作组向前长大时，组 id 随新的首成员变", () => {
  it("S6 组跨页：尾页里的组 id 是它的首成员，补页后换成更早的首成员——成员身份一个不丢，但组级展开态（work:manual / work:pinned）不跟", () => {
    const longTurn = [
      user("u1"),
      think("t1"),
      call("s1", "shell", { command: "ls" }),
      res("s1", "shell"),
      call("s2", "shell", { command: "ls" }),
      res("s2", "shell"),
      call("s3", "shell", { command: "ls" }),
      res("s3", "shell"),
      asst("m1"),
    ];
    const tail = build(longTurn.slice(4));
    const whole = build(longTurn);
    const tailGroup = tail.find((i) => i.kind === "__work_group__")!;
    const wholeGroup = whole.find((i) => i.kind === "__work_group__")!;
    expect(tailGroup.id).not.toBe(wholeGroup.id);
    expect(wholeGroup.id).toBe("t1");
    expect(lost(collect(tail).all, collect(whole).all).filter((k) => k !== tailGroup.id)).toEqual(
      [],
    );
  });
});
