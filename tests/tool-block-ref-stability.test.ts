/**
 * D5-01 / D5-03：事件追加路径上，旧的渲染项引用必须稳定，`memo` 的成员行才有意义。
 *
 * 第三轮 review 的度量（scratch-D5/bench2 A）：5000 事件追加 1 条后，工作组成员 2059 个里只有 76 个（3.7%）引用不变
 * ——`toolCallToBlock` 每次重建对象，`memo(ToolBlockRow)` / `memo(WorkGroupRow)` 在「事件追加」这条路径上几乎一次都命不中，
 * 展开的运行中尾组每个新事件整组（854 成员 ≈ 60ms render）重渲。
 *
 * 这里用同一口径（真事件 + 真分组管线，追加 tool_call / assistant_message / info 各一条）度量成员 / 顶层引用稳定率，
 * 并守住「缓存不能返回陈旧数据」：缓存路径与无缓存路径深度等价（随机会话逐前缀）、result 到场 / 事件被就地改 /
 * 重复 tool_call 升级 args 都不能污染缓存。
 */
import { describe, expect, it } from "vitest";

import {
  groupChatRenderItems,
  type ChatRenderItem,
  type WorkGroupItem,
} from "../src/lib/chat-turns";
import { coalesceAdjacentThinking } from "../src/lib/merge-thinking";
import {
  coerceStaleRunningTools,
  isToolBlock,
  isToolVerbGroup,
  markBackgroundRunningTools,
  markBackgroundSubagentTools,
  mergeToolDisplayEvents,
  streamItemStableId,
  toolArgsParseCacheStats,
  toolBlockDetailLine,
  toolBlockExpandedArgsPreview,
  toolBlockSummary,
  toolBlockArgsTruncatedHint,
  type StreamRenderItem,
  type ToolBlock,
} from "../src/lib/tool-display";
import type { TaskEvent } from "../src/lib/types";

let clock = 0;
const mk = (kind: string, id: string, extra: Partial<TaskEvent> = {}): TaskEvent =>
  ({ id, ts: ++clock, kind, text: kind, ...extra }) as unknown as TaskEvent;
const call = (cid: string, name: string, args: unknown = {}) =>
  mk("tool_call", `call_${cid}`, {
    meta: { callId: cid, name, args: JSON.stringify(args) },
  });
const res = (cid: string, name: string, status = "success") =>
  mk("tool_result", `res_${cid}`, {
    meta: { callId: cid, name, status, output: "o" },
  });

const build = (events: TaskEvent[]): ChatRenderItem[] =>
  groupChatRenderItems(mergeToolDisplayEvents([...coalesceAdjacentThinking(events)]));

/** 大会话：n 个 turn，每个 turn = 用户 +（思考）+ 若干读 / 搜 / shell / edit + AI 正文 */
const bigSession = (turns: number): TaskEvent[] => {
  const evs: TaskEvent[] = [];
  let n = 0;
  for (let t = 0; t < turns; t++) {
    evs.push(mk("user_reply", `u${t}`));
    if (t % 2 === 0) evs.push(mk("thinking", `t${t}`));
    const k = 3 + (t % 5);
    for (let i = 0; i < k; i++) {
      const name = ["read", "grep", "shell", "edit", "read"][(t + i) % 5]!;
      const cid = `c${++n}`;
      evs.push(call(cid, name, { path: `/f${n}`, command: "ls" }));
      evs.push(res(cid, name));
    }
    evs.push(mk("assistant_message", `m${t}`));
  }
  return evs;
};

type Member = StreamRenderItem;
const memberMap = (items: ChatRenderItem[]): Map<string, Member> => {
  const out = new Map<string, Member>();
  for (const it of items) {
    if (it.kind !== "__work_group__") continue;
    for (const m of (it as WorkGroupItem).members) out.set(streamItemStableId(m), m);
  }
  return out;
};

describe("D5-01：追加 1 条事件后，旧的渲染项引用保持不变", () => {
  const evs = bigSession(550);
  const before = build(evs);
  const cases: Record<string, TaskEvent> = {
    "追加 tool_call": call("zzz", "shell", { command: "pnpm build" }),
    "追加 assistant_message": mk("assistant_message", "mz"),
    "追加 info": mk("info", "iz"),
  };

  it("会话规模足够大（≥ 5000 事件、≥ 2000 个工作组成员）", () => {
    expect(evs.length).toBeGreaterThanOrEqual(5000);
    expect(memberMap(before).size).toBeGreaterThanOrEqual(2000);
  });

  for (const [name, ev] of Object.entries(cases)) {
    it(`${name}：工作组成员引用不变率 ≥ 99%（修复前 3.7%）`, () => {
      const after = build([...evs, ev]);
      const a = memberMap(after);
      let same = 0;
      let total = 0;
      for (const [id, m] of memberMap(before)) {
        total++;
        if (a.get(id) === m) same++;
      }
      expect(same / total, `${name}: ${same}/${total}`).toBeGreaterThanOrEqual(0.99);
    });

    it(`${name}：非尾部工作组整体引用不变（WorkGroupRow 的 group 入参稳定）`, () => {
      const after = build([...evs, ev]);
      const byId = new Map(after.map((x) => [x.id, x]));
      let same = 0;
      let total = 0;
      for (const it of before) {
        if (it.kind !== "__work_group__") continue;
        total++;
        if (byId.get(it.id) === it) same++;
      }
      expect(same / total, `${name}: ${same}/${total}`).toBeGreaterThanOrEqual(0.99);
    });
  }

  it("verb 组引用也稳定：只追加在别处，旧的 verb 组对象不重建", () => {
    const after = build([...evs, cases["追加 info"]!]);
    const verbBefore = [...memberMap(before).values()].filter(isToolVerbGroup);
    const a = memberMap(after);
    expect(verbBefore.length).toBeGreaterThan(100);
    const same = verbBefore.filter((v) => a.get(streamItemStableId(v)) === v).length;
    expect(same / verbBefore.length).toBeGreaterThanOrEqual(0.99);
  });

  it("尾组追加一个成员：旧成员引用全部复用，只有新成员 / 尾组自己是新的", () => {
    const base = [mk("user_reply", "uu"), call("p", "read", { path: "/p" }), res("p", "read"), call("q", "shell", { command: "ls" })];
    const a = build(base);
    const b = build([...base, res("q", "shell"), call("r", "shell", { command: "pwd" })]);
    const ga = a.find((i) => i.kind === "__work_group__") as WorkGroupItem;
    const gb = b.find((i) => i.kind === "__work_group__") as WorkGroupItem;
    expect(gb).not.toBe(ga);
    // p（读）成员：引用不变
    expect(gb.members[0]).toBe(ga.members[0]);
  });
});

describe("缓存正确性：不能返回陈旧数据", () => {
  const toBlocks = (items: StreamRenderItem[]) => items.filter(isToolBlock);

  it("缓存路径与无缓存路径深度等价（随机会话逐前缀）", () => {
    const evs = bigSession(40);
    for (let i = 1; i <= evs.length; i += 3) {
      const slice = evs.slice(0, i);
      const cached = mergeToolDisplayEvents([...slice]);
      const fresh = mergeToolDisplayEvents([...slice], { noCache: true });
      expect(cached, `前缀 ${i}`).toEqual(fresh);
    }
  });

  it("running → 完成：result 到场后换新块；旧块对象没被改动", () => {
    const c = call("a", "shell", { command: "ls" });
    const running = toBlocks(mergeToolDisplayEvents([c]))[0]!;
    expect(running.status).toBe("running");
    const done = toBlocks(mergeToolDisplayEvents([c, res("a", "shell")]))[0]!;
    expect(done.status).toBe("success");
    expect(done).not.toBe(running);
    expect(running.status).toBe("running");
    // 再回到「还没有 result」的输入（回退 / 重连后的前缀）：还是 running
    expect(toBlocks(mergeToolDisplayEvents([c]))[0]!.status).toBe("running");
  });

  it("同一个 result 事件对象 → 复用同一个块；换了 result 事件（同 callId、不同结果）→ 新块", () => {
    const c = call("a", "shell", { command: "ls" });
    const r1 = res("a", "shell", "success");
    const b1 = toBlocks(mergeToolDisplayEvents([c, r1]))[0]!;
    expect(toBlocks(mergeToolDisplayEvents([c, r1]))[0]).toBe(b1);
    const r2 = res("a", "shell", "error");
    const b2 = toBlocks(mergeToolDisplayEvents([c, r2]))[0]!;
    expect(b2).not.toBe(b1);
    expect(b2.status).toBe("error");
  });

  it("事件被就地改了（text / args）→ 不返回旧块", () => {
    const c = call("a", "shell", { command: "ls" });
    const b1 = toBlocks(mergeToolDisplayEvents([c]))[0]!;
    (c.meta as { args: string }).args = JSON.stringify({ command: "ls -la /tmp" });
    c.text = "调用 shell（改）";
    const b2 = toBlocks(mergeToolDisplayEvents([c]))[0]!;
    expect(b2).not.toBe(b1);
    expect(b2.args).toContain("ls -la /tmp");
    expect(b2.text).toBe("调用 shell（改）");
  });

  it("历史双写：同 callId 的第二条 tool_call 升级 args 时不污染缓存（只有第一条的输入仍得到短 args）", () => {
    const c1 = call("a", "shell", { command: "ls" });
    const c2 = mk("tool_call", "call_a_dup", {
      meta: { callId: "a", name: "shell", args: JSON.stringify({ command: "ls", cwd: "/a/very/long/path" }) },
    });
    const first = toBlocks(mergeToolDisplayEvents([c1]))[0]!;
    const shortArgs = first.args;
    const merged = toBlocks(mergeToolDisplayEvents([c1, c2]))[0]!;
    expect(merged.args!.length).toBeGreaterThan(shortArgs!.length);
    // 第一条事件单独再来一次：仍是短 args，且缓存里的块没被改
    const again = toBlocks(mergeToolDisplayEvents([c1]))[0]!;
    expect(again.args).toBe(shortArgs);
    expect(first.args).toBe(shortArgs);
  });

  it("待办合并 / background 标记不改缓存块（它们走克隆）", () => {
    const t1 = call("t1", "todo_write", { todos: [] });
    const t2 = call("t2", "todo_write", { todos: [] });
    const [solo] = toBlocks(mergeToolDisplayEvents([t1]));
    const [merged] = toBlocks(mergeToolDisplayEvents([t1, t2]));
    expect(merged!.stableId).toBe(streamItemStableId(solo!));
    expect(solo!.stableId).toBeUndefined();
    const [solo2] = toBlocks(mergeToolDisplayEvents([t1]));
    expect(solo2).toBe(solo);
  });
});

describe("事件流里的后处理也不击穿引用稳定（后台标记 / 过期 running 兜底）", () => {
  it("后台 shell 标记：同一个块两次标记 → 同一个克隆；原块不被改", () => {
    const c = call("bg", "shell", { command: "pnpm dev" });
    const r = res("bg", "shell");
    const items1 = mergeToolDisplayEvents([c, r]);
    const items2 = mergeToolDisplayEvents([c, r, mk("info", "i1")]);
    const ids = new Set(["bg"]);
    const a = markBackgroundRunningTools(items1, ids).find(isToolBlock)!;
    const b = markBackgroundRunningTools(items2, ids).find(isToolBlock)!;
    expect(a.backgroundRunning).toBe(true);
    expect(b).toBe(a);
    expect(items1.find(isToolBlock)!.backgroundRunning).toBeUndefined();
  });

  it("后台子代理标记：同一个块两次标记 → 同一个克隆；清单变空后回到原块", () => {
    const c = call("tk", "task", { description: "d", prompt: "p" });
    const r = mk("tool_result", "res_tk", {
      meta: { callId: "tk", name: "task", status: "success", output: "已在后台启动（后台任务 bg_0123abcd）" },
    });
    const items1 = mergeToolDisplayEvents([c, r]);
    const items2 = mergeToolDisplayEvents([c, r, mk("info", "i1")]);
    const jobs = new Set(["bg_0123abcd"]);
    const a = markBackgroundSubagentTools(items1, jobs).find(isToolBlock)!;
    const b = markBackgroundSubagentTools(items2, jobs).find(isToolBlock)!;
    expect(a.backgroundRunning).toBe(true);
    expect(b).toBe(a);
    const off = markBackgroundSubagentTools(items2, new Set()).find(isToolBlock)!;
    expect(off.backgroundRunning).toBeUndefined();
    expect(off).toBe(items2.find(isToolBlock));
  });

  it("会话已停时对残留 running 块的「已中断」兜底：同一个块两次兜底 → 同一个克隆", () => {
    const c = call("dead", "shell", { command: "sleep 9" });
    const items1 = mergeToolDisplayEvents([c]);
    const items2 = mergeToolDisplayEvents([c, mk("info", "i1")]);
    const a = coerceStaleRunningTools(items1).find(isToolBlock)!;
    const b = coerceStaleRunningTools(items2).find(isToolBlock)!;
    expect(a.status).toBe("interrupted");
    expect(b).toBe(a);
    expect(items1.find(isToolBlock)!.status).toBe("running");
  });

  it("整条管线（含后处理）追加事件：后台 shell 所在组里，其它成员引用仍全部稳定", () => {
    const evs: TaskEvent[] = [mk("user_reply", "u0"), call("bg", "shell", { command: "pnpm dev" }), res("bg", "shell")];
    for (let i = 0; i < 40; i++) {
      evs.push(call(`r${i}`, "read", { path: `/f${i}` }), res(`r${i}`, "read"));
    }
    const run = (list: TaskEvent[]) => {
      const merged = mergeToolDisplayEvents([...coalesceAdjacentThinking(list)]);
      const marked = markBackgroundRunningTools(merged, new Set(["bg"]));
      return groupChatRenderItems(marked);
    };
    const a = run(evs);
    const b = run([...evs, mk("info", "i2")]);
    const ma = memberMap(a);
    const mb = memberMap(b);
    let same = 0;
    for (const [id, m] of ma) if (mb.get(id) === m) same++;
    expect(same).toBe(ma.size);
  });
});

describe("D5-03：parseToolArgsLoose 按参数字符串缓存（四个展示函数共用一次解析）", () => {
  // 500 字符被截断的 shell args（服务端 truncate(…,500) 的形态）：JSON.parse 必失败，走 18 个正则
  const truncated = (marker: string): ToolBlock => {
    const full = JSON.stringify({ command: `echo ${marker} ` + "a".repeat(600), cwd: "/tmp/x" });
    const args = full.slice(0, 500) + "…(truncated 123 chars)";
    return {
      kind: "__tool_block__",
      id: `b_${marker}`,
      callId: `c_${marker}`,
      name: "shell",
      status: "running",
      text: "调用 shell",
      args,
      ts: 1,
    };
  };

  it("同一个块的四个展示函数：只有第一次真解析（miss），其余命中", () => {
    const block = truncated("alpha");
    const s0 = toolArgsParseCacheStats();
    const summary = toolBlockSummary(block);
    toolBlockDetailLine(block);
    toolBlockExpandedArgsPreview(block);
    toolBlockArgsTruncatedHint(block);
    const s1 = toolArgsParseCacheStats();
    expect(s1.misses - s0.misses).toBe(1);
    expect(s1.hits - s0.hits).toBeGreaterThanOrEqual(3);
    expect(summary).toContain("echo alpha");
  });

  it("结果与不缓存时一致：不同 args 各得各的，互不串", () => {
    const a = truncated("one");
    const b = truncated("two");
    expect(toolBlockSummary(a)).toContain("echo one");
    expect(toolBlockSummary(b)).toContain("echo two");
    expect(toolBlockSummary(a)).toContain("echo one");
    expect(toolBlockArgsTruncatedHint(a)).toBe(toolBlockArgsTruncatedHint({ ...a }));
  });

  it("缓存有界：塞入远多于上限的不同 args 后条目数不超上限；超长 args 不入缓存", () => {
    for (let i = 0; i < 2000; i++) toolBlockSummary(truncated(`k${i}`));
    const st = toolArgsParseCacheStats();
    expect(st.size).toBeLessThanOrEqual(st.limit);
    const huge: ToolBlock = {
      ...truncated("huge"),
      args: `{"command":"${"x".repeat(100_000)}`,
    };
    const before = toolArgsParseCacheStats().size;
    toolBlockSummary(huge);
    expect(toolArgsParseCacheStats().size).toBe(before);
  });
});
