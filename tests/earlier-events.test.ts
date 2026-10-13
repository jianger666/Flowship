/**
 * 上拉加载更早事件：一次上拉必须「顶部多出至少一条可见条目、或历史读完」
 *
 * 2026-10-13 用户反馈「聊天太多的话，往回滚，滚着滚着就滚不动了」。真实对话里一个
 * 工作过程组有 671 条原始事件（250 次工具调用，中间 AI 一句话没说），而分页一页只有 300 条：
 * 一整页都是这个组的成员，prepend 后并进最顶上那一条、条目数不变、`firstItemIndex` 不变，
 * Virtuoso 的 startReached 按第一项序号去重 → 再也不触发，用户停在顶部翻不动。
 *
 * 条目数这里用真实的渲染管线（隐藏闸 → 工具配对 → 工作过程分组）来数，
 * 不自己模拟「几条事件算几个条目」——分组语义变了，这些测试要跟着变红。
 */
import { describe, expect, it } from "vitest";

import { groupChatRenderItems } from "@/lib/chat-turns";
import {
  EARLIER_MAX_PAGES_PER_BATCH,
  EARLIER_PAGE_SIZE,
  fetchEarlierBatch,
  type EarlierPage,
} from "@/lib/earlier-events";
import { isHiddenFromEventStream } from "@/lib/event-stream-hidden";
import { mergeToolDisplayEvents } from "@/lib/tool-display";
import type { TaskEvent } from "@/lib/types";

// ---------- 造数据 ----------

let seq = 0;
const resetSeq = () => {
  seq = 0;
};
const mk = (
  kind: TaskEvent["kind"],
  text: string,
  meta?: Record<string, unknown>,
): TaskEvent => {
  seq += 1;
  return {
    id: `e_${String(seq).padStart(6, "0")}`,
    ts: 1_000_000 + seq,
    seq,
    kind,
    text,
    ...(meta ? { meta } : {}),
  };
};
const userReply = (t = "问") => mk("user_reply", t);
const reply = (t = "答") => mk("assistant_message", t);
const think = () => mk("thinking", "想一想");
/** 一次工具调用 = call + result 两条原始事件，渲染成一个工具块 */
const toolPair = (i: number): TaskEvent[] => {
  const callId = `call_${seq}_${i}`;
  return [
    mk("tool_call", "调用 shell", { callId, name: "shell", args: "{}" }),
    mk("tool_result", "工具完成 shell", {
      callId,
      name: "shell",
      status: "success",
      output: "",
    }),
  ];
};
/** 一段只有过程（思考 + 工具）的事件：chat 里会折成同一个工作过程组 */
const processRun = (steps: number): TaskEvent[] => {
  const out: TaskEvent[] = [];
  for (let i = 0; i < steps; i += 1) {
    out.push(think(), ...toolPair(i));
  }
  return out;
};

/** 与渲染管线同口径的条目数（chat 形态） */
const countItems = (evs: readonly TaskEvent[]): number =>
  groupChatRenderItems(
    mergeToolDisplayEvents(
      evs.filter((e) => !isHiddenFromEventStream(e, { isChat: true })),
    ),
  ).length;

/**
 * 内存版服务端：与 readEventsBefore 同语义——beforeId 之前紧邻的 limit 条（时间正序）；
 * 锚点不存在 → 空页 + hasMore:false。
 */
const makeServer = (all: TaskEvent[]) => {
  const calls: Array<{ beforeId: string; limit: number }> = [];
  const fetchPage = async (
    beforeId: string,
    limit: number,
  ): Promise<EarlierPage> => {
    calls.push({ beforeId, limit });
    const idx = all.findIndex((e) => e.id === beforeId);
    if (idx < 0) return { events: [], hasMore: false };
    const start = Math.max(0, idx - limit);
    return { events: all.slice(start, idx), hasMore: start > 0 };
  };
  return { fetchPage, calls };
};

/** 模拟前端本地状态：尾部 N 条 + 每次提交 prepend */
const makeLocal = (all: TaskEvent[], tail: number) => {
  let cur = all.slice(-tail);
  return {
    getCurrent: () => cur,
    prepend: (fresh: TaskEvent[]) => {
      cur = [...fresh, ...cur];
    },
  };
};

// 用户那个对话的形状：开头几轮正常对话 → 一个 671 事件的超大过程组 → 一句话 → 之后几轮
const buildBigGroupLog = () => {
  resetSeq();
  const log: TaskEvent[] = [];
  // 大组之前还有一千多条正常回合——翻过大组之后历史还没到头（hasMore 仍为 true）
  for (let i = 0; i < 60; i += 1) {
    log.push(userReply(`早期 ${i}`), ...processRun(5), reply(`早期答 ${i}`));
  }
  log.push(userReply("第 3 问"));
  const bigStart = log.length;
  log.push(...processRun(222)); // 222 × 3 = 666 条原始事件、折成同一个组
  const bigEnd = log.length;
  log.push(reply("第一版剪好了"));
  for (let i = 0; i < 8; i += 1) {
    log.push(userReply(`后续 ${i}`), ...processRun(10), reply(`答 ${i}`));
  }
  return { log, bigStart, bigEnd };
};

describe("前提：一整页都是同一个过程组的成员时，单页 prepend 条目数不变（旧实现卡死的原因）", () => {
  it("大组里的整页事件并进最顶上那个组，条目数 0 变化", () => {
    const { log, bigStart, bigEnd } = buildBigGroupLog();
    // 本地从大组中段开始（顶部是个只有一部分成员的组）
    const localStart = bigStart + 300;
    const cur = log.slice(localStart);
    const page = log.slice(localStart - EARLIER_PAGE_SIZE, localStart);
    // 这一页完全落在大组里
    expect(localStart - EARLIER_PAGE_SIZE).toBeGreaterThanOrEqual(bigStart);
    expect(localStart).toBeLessThan(bigEnd);

    expect(countItems([...page, ...cur])).toBe(countItems(cur));
  });
});

describe("fetchEarlierBatch：一次上拉要么顶部多出一条可见条目、要么历史读完", () => {
  it("【回归】整页都在同一个大组里：继续往前拉，直到越过组边界、条目数变多（而不是历史读完）", async () => {
    const { log, bigStart } = buildBigGroupLog();
    const localStart = bigStart + 300;
    const server = makeServer(log);
    const local = makeLocal(log, log.length - localStart);

    const before = countItems(local.getCurrent());
    const batch = await fetchEarlierBatch({
      getCurrent: local.getCurrent,
      fetchPage: server.fetchPage,
      countItems,
    });
    expect(batch).not.toBeNull();
    // 第一页（300 条）正好是大组的前半截、并进去没进展；第二页越过组边界才多出条目
    expect(batch!.pages).toBe(2);
    expect(batch!.progressed).toBe(true);
    // 这一批是靠「条目数变多」收工的，不是读到头——历史还有
    expect(batch!.hasMore).toBe(true);
    expect(batch!.fresh.length).toBeGreaterThan(EARLIER_PAGE_SIZE);

    local.prepend(batch!.fresh);
    expect(countItems(local.getCurrent())).toBeGreaterThan(before);
    // 提交之后顶部已经越过了大组（拉到了大组之前的内容）
    expect(local.getCurrent()[0]!.id < log[bigStart]!.id).toBe(true);
  });

  it("【回归】从最新一路翻到最开头：每一批都有进展、没有一批原地空转，最终拿全整段历史", async () => {
    const { log } = buildBigGroupLog();
    const server = makeServer(log);
    const local = makeLocal(log, 300); // 与 page.tsx 的 EVENT_TAIL 同口径

    let batches = 0;
    let hasMore = true;
    while (hasMore) {
      const beforeItems = countItems(local.getCurrent());
      const batch = await fetchEarlierBatch({
        getCurrent: local.getCurrent,
        fetchPage: server.fetchPage,
        countItems,
      });
      batches += 1;
      expect(batches).toBeLessThan(100);
      local.prepend(batch!.fresh);
      // 核心不变量：只要还有更早的，这一批提交后条目数必须变多
      // （条目数不变 = firstItemIndex 不变 = Virtuoso 不再触发 startReached = 卡死）
      if (batch!.hasMore) {
        expect(batch!.progressed).toBe(true);
        expect(countItems(local.getCurrent())).toBeGreaterThan(beforeItems);
      }
      hasMore = batch!.hasMore;
    }
    expect(local.getCurrent()).toEqual(log);
  });

  it("单页就多出条目：只拉一页，用第一页的页大小", async () => {
    resetSeq();
    const log = [
      userReply("a"),
      reply("a1"),
      userReply("b"),
      reply("b1"),
      userReply("c"),
      reply("c1"),
    ];
    const server = makeServer(log);
    const local = makeLocal(log, 2);
    const batch = await fetchEarlierBatch({
      getCurrent: local.getCurrent,
      fetchPage: server.fetchPage,
      countItems,
      pageSize: 2,
    });
    expect(batch).toEqual({
      fresh: log.slice(2, 4),
      hasMore: true,
      progressed: true,
      pages: 1,
    });
    expect(server.calls).toEqual([{ beforeId: log[4]!.id, limit: 2 }]);
  });

  it("历史读完：progressed 为 true、hasMore 为 false（即使条目数没变）", async () => {
    resetSeq();
    // 全部是过程事件：整个对话只有一个组，翻到头也不会多出条目
    const log = processRun(40);
    const server = makeServer(log);
    const local = makeLocal(log, 30);
    const batch = await fetchEarlierBatch({
      getCurrent: local.getCurrent,
      fetchPage: server.fetchPage,
      countItems,
      pageSize: 20,
    });
    expect(batch!.hasMore).toBe(false);
    expect(batch!.progressed).toBe(true);
    expect(batch!.fresh).toEqual(log.slice(0, log.length - 30));
    local.prepend(batch!.fresh);
    expect(local.getCurrent()).toEqual(log);
  });

  it("每一页都用同一个页大小（没进展也不放大——最后让条目变多的那页要和普通页一样大）", async () => {
    resetSeq();
    const log = processRun(2000); // 6000 条、一个组
    const server = makeServer(log);
    const local = makeLocal(log, 100);
    await fetchEarlierBatch({
      getCurrent: local.getCurrent,
      fetchPage: server.fetchPage,
      countItems,
      maxPages: 3,
    });
    expect(server.calls.map((c) => c.limit)).toEqual([
      EARLIER_PAGE_SIZE,
      EARLIER_PAGE_SIZE,
      EARLIER_PAGE_SIZE,
    ]);
  });

  it("单批到页数上限还没进展：progressed=false、hasMore=true，调用方提交后接着拉直到有进展", async () => {
    resetSeq();
    // 一个超长过程组（6000 条）在最顶，往上没有别的条目——模拟「顶上全是同一组」
    const tailPart = [userReply("问"), ...processRun(5), reply("答")];
    const log = [...processRun(2000), ...tailPart];
    const server = makeServer(log);
    const local = makeLocal(log, tailPart.length + 30);

    // 调用方循环（与 event-stream.tsx 的 loadEarlier 同形）：没进展且还有就接着来
    let batches = 0;
    let lastBatch;
    for (;;) {
      const batch = await fetchEarlierBatch({
        getCurrent: local.getCurrent,
        fetchPage: server.fetchPage,
        countItems,
        maxPages: 2,
      });
      batches += 1;
      lastBatch = batch!;
      local.prepend(batch!.fresh);
      if (batch!.progressed || !batch!.hasMore) break;
      expect(batch!.pages).toBe(2);
      expect(batches).toBeLessThan(200); // 防死循环
    }
    expect(batches).toBeGreaterThan(1);
    // 整个对话顶部就是那个大组，最终读到头
    expect(lastBatch.hasMore).toBe(false);
    expect(local.getCurrent()).toEqual(log);
  });

  it("单批默认页数上限是个有限值（不会一次提交拉空整个历史）", () => {
    expect(EARLIER_MAX_PAGES_PER_BATCH).toBeGreaterThan(1);
    expect(EARLIER_MAX_PAGES_PER_BATCH).toBeLessThanOrEqual(20);
  });

  it("本地没有任何事件：不发请求，直接收工", async () => {
    const server = makeServer([]);
    const batch = await fetchEarlierBatch({
      getCurrent: () => [],
      fetchPage: server.fetchPage,
      countItems,
    });
    expect(batch).toEqual({ fresh: [], hasMore: false, progressed: true, pages: 0 });
    expect(server.calls).toHaveLength(0);
  });

  it("一页回来时事件已被别处并进本地（全是已知的）：游标照样推到这一页最早一条、不在原地空转", async () => {
    resetSeq();
    const log = [
      userReply("a"),
      reply("a1"),
      userReply("b"),
      reply("b1"),
      userReply("c"),
      reply("c1"),
    ];
    const local = makeLocal(log, 2); // 本地 = [c, c1]
    const cursors: string[] = [];
    let n = 0;
    const fetchPage = async (beforeId: string): Promise<EarlierPage> => {
      cursors.push(beforeId);
      n += 1;
      const idx = log.findIndex((e) => e.id === beforeId);
      if (n === 1) {
        // 请求飞行期间，这一页（b、b1）被别的路径并进了本地——回来时全是已知的
        local.prepend(log.slice(2, 4));
        return { events: log.slice(2, idx), hasMore: true };
      }
      return { events: log.slice(0, idx), hasMore: false };
    };
    const batch = await fetchEarlierBatch({
      getCurrent: local.getCurrent,
      fetchPage,
      countItems,
      pageSize: 2,
    });
    // 第二次请求的游标是第一页最早的 b，而不是还停在 c
    expect(cursors).toEqual([log[4]!.id, log[2]!.id]);
    expect(batch!.fresh).toEqual(log.slice(0, 2));
    expect(batch!.hasMore).toBe(false);
  });

  it("服务端说 hasMore 却给了空页：当作到头，不无限循环", async () => {
    resetSeq();
    const log = [userReply("a"), reply("a1")];
    const local = makeLocal(log, 1);
    let calls = 0;
    const batch = await fetchEarlierBatch({
      getCurrent: local.getCurrent,
      fetchPage: async () => {
        calls += 1;
        return { events: [], hasMore: true };
      },
      countItems,
    });
    expect(calls).toBe(1);
    expect(batch).toEqual({ fresh: [], hasMore: false, progressed: true, pages: 1 });
  });

  it("拉的过程中任务被切走：返回 null，不再继续请求", async () => {
    resetSeq();
    const log = processRun(500);
    const server = makeServer(log);
    const local = makeLocal(log, 50);
    let cancelled = false;
    const batch = await fetchEarlierBatch({
      getCurrent: local.getCurrent,
      fetchPage: async (b, l) => {
        const r = await server.fetchPage(b, l);
        cancelled = true; // 第一页回来时用户已经切走
        return r;
      },
      countItems,
      isCancelled: () => cancelled,
    });
    expect(batch).toBeNull();
    expect(server.calls).toHaveLength(1);
  });

  it("某一页请求失败：整批抛错（调用方据此显示重试），已拉到的不泄漏", async () => {
    resetSeq();
    const log = processRun(1000);
    const server = makeServer(log);
    const local = makeLocal(log, 50);
    let n = 0;
    await expect(
      fetchEarlierBatch({
        getCurrent: local.getCurrent,
        fetchPage: async (b, l) => {
          n += 1;
          if (n === 2) throw new Error("boom");
          return server.fetchPage(b, l);
        },
        countItems,
      }),
    ).rejects.toThrow("boom");
    // 本地没被动过：重试从同一个游标重新开始
    expect(local.getCurrent()).toEqual(log.slice(-50));
  });

  it("拉的过程中本地又追加了新事件：fresh 不含新事件、也没有重复", async () => {
    resetSeq();
    const log = [
      ...processRun(300), // 900 条一个组
      userReply("问"),
      reply("答"),
    ];
    const server = makeServer(log);
    let cur = log.slice(-60);
    const appended = reply("流式期间新到的");
    const fetchPage = async (b: string, l: number) => {
      const r = await server.fetchPage(b, l);
      // 第一页回来时本地尾部多了一条新事件
      if (!cur.includes(appended)) cur = [...cur, appended];
      return r;
    };
    const batch = await fetchEarlierBatch({
      getCurrent: () => cur,
      fetchPage,
      countItems,
    });
    const ids = batch!.fresh.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(appended.id);
    for (const e of cur) expect(ids).not.toContain(e.id);
  });
});
