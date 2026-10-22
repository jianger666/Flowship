/**
 * 事件流尾部排序 + 「提交即到底」判定（2026-10-20 第二轮 review：V1-01 / V2-01）
 *
 * V1-01：运行中排队消息时，排队气泡画在流式回复上方、定稿后又跳到下方。
 *   根因是对「已拼好 pending 的数组」调 insertBeforeTrailingCompaction，流式项落到所有 pending 之后。
 * V2-01：上滚读历史后在输入框回车发送，事件流不回到底部。要在「本窗口新发起的占位出现」时贴底，
 *   且只认本地发起（飞书 / 别的窗口 / bootstrap 重建的占位不能把读历史的人拽走）。
 *
 * 排序与判定都是纯函数（src/lib/stream-pending.ts）；接线契约放在文件后半段。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { insertBeforeTrailingCompaction } from "@/lib/compaction-display";
import {
  applyPendingScan,
  composeStreamTail,
  nextPendingScan,
  projectPendingForStream,
  type PendingScanBaseline,
} from "@/lib/stream-pending";

type Item = { kind: string; id: string; meta?: Record<string, unknown> };

const user = (id: string): Item => ({ kind: "user_reply", id });
const assistant = (id: string): Item => ({ kind: "assistant_message", id });
const pending = (id: string): Item => ({ kind: "__pending_local__", id });
const streaming: Item = { kind: "__streaming__", id: "__streaming__" };
const compaction = (id: string): Item => ({
  kind: "info",
  id,
  meta: { kind: "compaction", status: "running" },
});
const ids = (items: readonly Item[]): string[] => items.map((it) => it.id);

describe("composeStreamTail：流式项排在 pending 之前（V1-01）", () => {
  it("有排队气泡时：流式回复在上、排队气泡在下（旧写法把流式项排到所有 pending 之后）", () => {
    const flow = [user("u1")];
    const queued = [pending("p1"), pending("p2")];
    expect(ids(composeStreamTail(flow, queued, streaming))).toEqual([
      "u1",
      "__streaming__",
      "p1",
      "p2",
    ]);
    // 对照：旧写法（对拼好 pending 的数组插）就是排到最后——这条断言钉住「为什么要改」
    expect(
      ids(insertBeforeTrailingCompaction([...flow, ...queued], streaming)),
    ).toEqual(["u1", "p1", "p2", "__streaming__"]);
  });

  it("定稿前后相对顺序不变：流式项的位置 = 定稿 assistant_message 在 flow 末尾的位置，不再从上方跳到下方", () => {
    const queued = [pending("p1")];
    const before = composeStreamTail([user("u1")], queued, streaming);
    // 定稿：流式项被 flow 末尾新落盘的 assistant_message 接管、流式项消失
    const after = composeStreamTail([user("u1"), assistant("a1")], queued, null);
    expect(before.findIndex((it) => it.kind === "__streaming__")).toBe(
      after.findIndex((it) => it.kind === "assistant_message"),
    );
    // 排队气泡相对回复的方向两边一致（都在回复下方）
    const pendingIdx = (arr: Item[]) => arr.findIndex((it) => it.id === "p1");
    expect(pendingIdx(before)).toBeGreaterThan(
      before.findIndex((it) => it.kind === "__streaming__"),
    );
    expect(pendingIdx(after)).toBeGreaterThan(
      after.findIndex((it) => it.kind === "assistant_message"),
    );
  });

  it("尾部连续压缩过程行仍排在流式项之后（「回复 → 正在压缩」不变），pending 在它们之后", () => {
    const flow = [user("u1"), compaction("c1"), compaction("c2")];
    expect(ids(composeStreamTail(flow, [pending("p1")], streaming))).toEqual([
      "u1",
      "__streaming__",
      "c1",
      "c2",
      "p1",
    ]);
  });

  it("没有流式项：就是 [...flow, ...pending]", () => {
    const flow = [user("u1"), assistant("a1")];
    const queued = [pending("p1")];
    expect(ids(composeStreamTail(flow, queued, null))).toEqual(["u1", "a1", "p1"]);
    expect(ids(composeStreamTail(flow, queued))).toEqual(["u1", "a1", "p1"]);
  });

  it("没有 pending：与单独对 flow 调 insertBeforeTrailingCompaction 完全一致（不改变无排队时的老行为）", () => {
    const flow = [user("u1"), compaction("c1")];
    expect(composeStreamTail(flow, [], streaming)).toEqual(
      insertBeforeTrailingCompaction(flow, streaming),
    );
  });

  it("空 flow：流式项在最前、pending 在后", () => {
    expect(ids(composeStreamTail([], [pending("p1")], streaming))).toEqual([
      "__streaming__",
      "p1",
    ]);
  });

  it("不改入参（flow / pending 是 useMemo 里的 memo 结果，改了会污染下一次复用）", () => {
    const flow = [user("u1"), compaction("c1")];
    const queued = [pending("p1")];
    const flowSnapshot = [...flow];
    const queuedSnapshot = [...queued];
    composeStreamTail(flow, queued, streaming);
    expect(flow).toEqual(flowSnapshot);
    expect(queued).toEqual(queuedSnapshot);
  });
});

describe("nextPendingScan：「提交即到底」只认本窗口新发起的占位（V2-01）", () => {
  it("基线还没建（首次挂载 / 刚切 task）：已经在的占位不算新发起", () => {
    const scan = nextPendingScan(null, [{ id: "p1" }, { id: "p2", local: true }]);
    expect(scan.hasNewLocal).toBe(false);
    // 但要把它们记进基线，下一轮才不会把它们当新的
    expect([...scan.ids].sort()).toEqual(["p1", "p2"]);
  });

  it("本地新发起的占位出现 → 触发", () => {
    const first = nextPendingScan(null, []);
    const next = nextPendingScan(first.ids, [{ id: "p1", local: true }]);
    expect(next.hasNewLocal).toBe(true);
  });

  it("缺省 local 不算本地（fail-closed，R5-03）：新增占位来源忘了标 local，最多不滚动、不会拽人", () => {
    const next = nextPendingScan(new Set(), [{ id: "nonce-1" }]);
    expect(next.hasNewLocal).toBe(false);
    // 显式 true 才触发
    expect(nextPendingScan(new Set(), [{ id: "nonce-1", local: true }]).hasNewLocal).toBe(true);
  });

  it("local === false 的新占位（bootstrap 重建 / 别的窗口登记）不触发——别把读历史的人拽走", () => {
    const next = nextPendingScan(new Set(["p1"]), [
      { id: "p1", local: true },
      { id: "from-bootstrap", local: false },
    ]);
    expect(next.hasNewLocal).toBe(false);
    // 记进基线：它之后即使 local 变化也不再算「新出现」
    expect(next.ids.has("from-bootstrap")).toBe(true);
  });

  it("同一批占位重复扫描（状态变化 / 重渲）不重复触发", () => {
    const list = [{ id: "p1", local: true }];
    const a = nextPendingScan(new Set(), list);
    expect(a.hasNewLocal).toBe(true);
    const b = nextPendingScan(a.ids, list);
    expect(b.hasNewLocal).toBe(false);
  });

  it("占位消失（落盘 / 失败清掉）不触发，并且从基线里去掉；已有占位的同时再发一条仍触发", () => {
    const a = nextPendingScan(new Set(), [{ id: "p1", local: true }]);
    const gone = nextPendingScan(a.ids, []);
    expect(gone.hasNewLocal).toBe(false);
    expect(gone.ids.size).toBe(0);

    const second = nextPendingScan(a.ids, [
      { id: "p1", local: true },
      { id: "p2", local: true },
    ]);
    expect(second.hasNewLocal).toBe(true);
  });

  it("入参基线不被修改", () => {
    const prev = new Set(["p1"]);
    nextPendingScan(prev, [{ id: "p1" }, { id: "p2" }]);
    expect([...prev]).toEqual(["p1"]);
  });
});

describe("applyPendingScan：「提交即到底」的 effect 体（fake 滚动回调，R5-03）", () => {
  const run = (
    prev: PendingScanBaseline | null,
    taskId: string,
    list: Array<{ id: string; local?: boolean }>,
  ): { next: PendingScanBaseline; scrolls: number } => {
    let scrolls = 0;
    const next = applyPendingScan(prev, taskId, list, () => {
      scrolls += 1;
    });
    return { next, scrolls };
  };

  it("本窗口新发起的占位出现 → 恰好滚一次；随后同一批占位再渲染不再滚", () => {
    const a = run(null, "t1", []);
    expect(a.scrolls).toBe(0);
    const b = run(a.next, "t1", [{ id: "p1", local: true }]);
    expect(b.scrolls).toBe(1);
    const c = run(b.next, "t1", [{ id: "p1", local: true }]);
    expect(c.scrolls).toBe(0);
    // 第二条本地占位再来 → 再滚一次
    const d = run(c.next, "t1", [
      { id: "p1", local: true },
      { id: "p2", local: true },
    ]);
    expect(d.scrolls).toBe(1);
  });

  it("首次挂载 / 刚切 task 时已在的占位只记基线、不滚（含 local=true 的）", () => {
    const a = run(null, "t1", [{ id: "p1", local: true }]);
    expect(a.scrolls).toBe(0);
    expect([...a.next.ids]).toEqual(["p1"]);
    expect(a.next.taskId).toBe("t1");
  });

  it("基线按 task 隔离：切到 t2 时拿 t1 的基线当不存在，t2 里已有的占位不被当成刚发的", () => {
    const onT1 = run(null, "t1", [{ id: "p1", local: true }]);
    // 切 task：t2 里已经有 p9（比如上次留下的排队占位）
    const onT2 = run(onT1.next, "t2", [{ id: "p9", local: true }]);
    expect(onT2.scrolls).toBe(0);
    expect(onT2.next.taskId).toBe("t2");
    // A→B→A：回到 t1 同样只当基线
    const backT1 = run(onT2.next, "t1", [{ id: "p1", local: true }]);
    expect(backT1.scrolls).toBe(0);
  });

  it("bootstrap 重建 / 别的窗口登记的占位（local=false）与缺省 local 的占位出现 → 不滚（不拽读历史的人）", () => {
    const base = run(null, "t1", []);
    const a = run(base.next, "t1", [{ id: "from-bootstrap", local: false }]);
    expect(a.scrolls).toBe(0);
    const b = run(a.next, "t1", [{ id: "from-bootstrap", local: false }, { id: "no-flag" }]);
    expect(b.scrolls).toBe(0);
  });

  it("消失的占位不留在基线里：同 id 重新出现（uncertain 重发复用 id 之外的新提交）按新出现算", () => {
    const a = run(null, "t1", []);
    const b = run(a.next, "t1", [{ id: "p1", local: true }]);
    const gone = run(b.next, "t1", []);
    expect([...gone.next.ids]).toEqual([]);
    const again = run(gone.next, "t1", [{ id: "p1", local: true }]);
    expect(again.scrolls).toBe(1);
  });
});

describe("projectPendingForStream：ledger 占位 → 事件流占位（local / mode / 过滤，R5-03）", () => {
  type P = { itemId: string; uncertain?: boolean; displayText: string };
  const L = (itemId: string, displayText = "hi", uncertain = false): P => ({
    itemId,
    displayText,
    uncertain,
  });
  const ctx = (queuedAtSubmit: Map<string, boolean>, runActive = false) => ({
    visible: (p: P) => p.displayText !== "",
    queuedAtSubmit,
    runActive,
  });

  it("local 只看「本窗口登记过」（queuedAtSubmit 里有）：登记过 = true，bootstrap 重建的 = false", () => {
    const out = projectPendingForStream(
      [L("mine"), L("rebuilt")],
      ctx(new Map([["mine", false]])),
    );
    expect(out.map((p) => [p.itemId, p.local])).toEqual([
      ["mine", true],
      ["rebuilt", false],
    ]);
  });

  it("local 不被 runActive 带偏：run 在跑时没登记过的占位仍是 false（旧写法 `|| true` 的洞）", () => {
    const out = projectPendingForStream([L("rebuilt")], ctx(new Map(), true));
    expect(out[0]!.local).toBe(false);
  });

  it("mode：登记时记下的「提交那一刻是否在跑」优先；没登记过的退回当前 runActive；uncertain 无分类", () => {
    const out = projectPendingForStream(
      [L("a"), L("b"), L("c"), L("d", "x", true)],
      ctx(
        new Map([
          ["a", true],
          ["b", false],
        ]),
        true,
      ),
    );
    expect(out.map((p) => p.mode)).toEqual(["queued", "inflight", "queued", undefined]);
  });

  it("visible 过滤：不画的占位不进事件流；不改入参、其余字段原样带上", () => {
    const input = [L("a", "keep"), L("b", "")];
    const out = projectPendingForStream(input, ctx(new Map([["a", false]])));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ itemId: "a", displayText: "keep" });
    expect(input).toHaveLength(2);
    expect("local" in input[0]!).toBe(false);
  });

  it("接入 chat-view 的真实过滤口径：没有内容可画的 bootstrap 重建占位不进流", async () => {
    const { hasPendingBubbleContent } = await import("@/lib/chat-pending-display");
    const out = projectPendingForStream(
      [
        { itemId: "mine", displayText: "你好", uncertain: false },
        { itemId: "rebuilt", displayText: "", uncertain: false },
      ],
      {
        visible: (p) => hasPendingBubbleContent(p),
        queuedAtSubmit: new Map([["mine", false]]),
        runActive: false,
      },
    );
    expect(out.map((p) => p.itemId)).toEqual(["mine"]);
  });
});

// ---------- 接线契约（UI 在 node 环境跑不起来，靠源码契约防「被删 / 被改回去」） ----------

const srcDir = path.resolve(import.meta.dirname, "..", "src");
const read = (...segments: string[]): string =>
  readFileSync(path.join(srcDir, ...segments), "utf-8");

const eventStream = read("components", "tasks", "event-stream.tsx");
const chatView = read("components", "tasks", "chat-view.tsx");

/** 从 `marker` 起按花括号 / 圆括号配对截出完整片段（marker 之后第一个 `(` 起算） */
const sliceCall = (source: string, marker: string): string => {
  const start = source.indexOf(marker);
  expect(start, `源码里找不到 \`${marker}\``).toBeGreaterThanOrEqual(0);
  const from = source.indexOf("(", start);
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`括号没配平：${marker}`);
};

describe("接线契约：V1-01 流式项排序", () => {
  it("items 那层用 composeStreamTail 拼流式项，不再对拼好 pending 的数组调 insertBeforeTrailingCompaction", () => {
    const items = sliceCall(eventStream, "const items: RenderItem[] = useMemo(");
    expect(items).toMatch(/composeStreamTail(<RenderItem>)?\(/);
    expect(items).not.toMatch(/insertBeforeTrailingCompaction\(\s*withPending/);
    expect(eventStream).toMatch(
      /import \{[^}]*composeStreamTail[^}]*\} from "@\/lib\/stream-pending"/,
    );
  });

  it("composeStreamTail 内部仍走 insertBeforeTrailingCompaction（「回复 → 正在压缩」的顺序不丢）", () => {
    expect(read("lib", "stream-pending.ts")).toContain(
      "insertBeforeTrailingCompaction(flow, streaming)",
    );
  });
});

describe("接线契约：V2-01 提交即到底", () => {
  it("EventStream 在 pendingLocalReplies 变化的 effect 里走 applyPendingScan，回调接 follow.scrollToBottomSmooth()（行为见上方 applyPendingScan 用例）", () => {
    expect(eventStream).toMatch(
      /import \{[^}]*applyPendingScan[^}]*\} from "@\/lib\/stream-pending"/,
    );
    const at = eventStream.indexOf("applyPendingScan(");
    expect(at).toBeGreaterThanOrEqual(0);
    // 取 effect 体：调用点往后到依赖数组
    const effect = eventStream.slice(at, eventStream.indexOf("[pendingLocalReplies", at));
    expect(effect).toContain("follow.scrollToBottomSmooth()");
  });

  it("基线按 task 隔离：effect 把 task.id 传给 applyPendingScan（基线隔离的行为在上方用例钉）", () => {
    const at = eventStream.indexOf("applyPendingScan(");
    const effect = eventStream.slice(at, eventStream.indexOf("[pendingLocalReplies", at));
    expect(effect).toMatch(/task\.id/);
  });

  it("占位 prop 带 local 标记；chat-view 的投影走 projectPendingForStream（local 口径的行为在上方用例钉）；task 页显式标 local:true", () => {
    expect(eventStream).toMatch(/local\?: boolean;/);
    const pendingForStream = sliceCall(chatView, "const pendingForStream = useMemo(");
    expect(pendingForStream).toContain("projectPendingForStream(");
    expect(pendingForStream).toContain("queuedAtSubmit: queuedAtSubmitRef.current");
    // fail-closed 之后，task 说话条的占位必须显式标本地，否则「提交即到底」在 task 页失效
    const taskPage = read("app", "tasks", "[id]", "page.tsx");
    const rows = taskPage.slice(taskPage.indexOf("pendingLocalReplies={pendingTalkRows"));
    expect(rows.slice(0, rows.indexOf("}))}"))).toMatch(/local: true/);
  });
});
