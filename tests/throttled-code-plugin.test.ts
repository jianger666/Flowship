/**
 * 流式代码块「限频高亮」插件。
 *
 * 钉死的语义（浏览器 CPU 采样发现：流式增长的代码块每帧整块重新分词，代码密集回复 busy 86%）：
 * - 同一代码块的连续增长请求（后一次以前一次为前缀）在窗口内不跑 Shiki，
 *   而是返回「上一次真实高亮结果 + 新增文字（无色 token）」——文字照常逐帧增长；
 * - 窗口到期对最新完整 code 真实高亮一次；窗口 = 上次耗时 × costFactor，夹在 [min, max]；
 * - I1 不丢请求 / I2 文字不回退 / I3 终态正确 / I4 内存有界；
 * - 短代码直通，行为与上游一致。
 */
import { describe, expect, it, vi } from "vitest";
import {
  code as realCodePlugin,
  type CodeHighlighterPlugin,
  type HighlightOptions,
  type HighlightResult,
} from "@streamdown/code";

import {
  createThrottledCodePlugin,
  extendHighlightResult,
  THROTTLED_CODE_DEFAULTS,
  type ThrottleClock,
} from "@/lib/throttled-code-plugin";

type Callback = (r: HighlightResult) => void;

// ───────── 测试替身 ─────────

const makeClock = () => {
  let t = 1000;
  let nextId = 1;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  const clock: ThrottleClock = {
    now: () => t,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, at: t + ms, fn });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  return {
    clock,
    now: () => t,
    timerCount: () => timers.length,
    /** 只推进时间、不触发定时器——模拟主线程被占住、定时器迟迟没轮到 */
    jump(ms: number) {
      t += ms;
    },
    /** 推进时间，并按到期顺序触发定时器 */
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = timers
          .filter((x) => x.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        t = Math.max(t, due.at);
        due.fn();
      }
      t = end;
    },
  };
};

/** 着色结果：整行一个带 color 的 token；空行 = [] */
const colored = (src: string): HighlightResult =>
  ({
    tokens: src
      .split("\n")
      .map((line) => (line ? [{ content: line, offset: 0, color: "#f00" }] : [])),
    fg: "#000",
    bg: "#fff",
    themeName: "fake",
    rootStyle: "",
  }) as unknown as HighlightResult;

const render = (r: HighlightResult): string =>
  r.tokens.map((l) => l.map((t) => t.content).join("")).join("\n");

const hasColor = (t: { color?: string; htmlStyle?: unknown }) =>
  t.color !== undefined || t.htmlStyle !== undefined;

const req = (src: string, over: Partial<HighlightOptions> = {}): HighlightOptions => ({
  code: src,
  language: "ts" as never,
  themes: ["github-light", "github-dark"],
  ...over,
});

const makeBase = () => {
  const calls: { req: HighlightOptions; cb?: Callback }[] = [];
  const cache = new Map<string, HighlightResult>();
  const base: CodeHighlighterPlugin = {
    name: "shiki",
    type: "code-highlighter",
    supportsLanguage: vi.fn(() => true),
    getSupportedLanguages: vi.fn(() => ["ts"] as never),
    getThemes: vi.fn(() => ["github-light", "github-dark"] as never),
    highlight: vi.fn((r, cb) => {
      const hit = cache.get(r.code);
      if (hit) return hit;
      calls.push({ req: r, cb });
      return null;
    }),
  };
  /** 完成第 i 次提交：产出着色结果并回调（上游按调用顺序回调） */
  const finish = (i: number) => {
    const { req: r, cb } = calls[i];
    const result = colored(r.code);
    cache.set(r.code, result);
    cb?.(result);
    return result;
  };
  return { base, calls, cache, finish };
};

/** n 行、每行 ~40 字符的代码；n≥8 时 >240 字符（越过「短代码直通」阈值） */
const codeOf = (n: number, tag = "a") =>
  Array.from({ length: n }, (_, i) => `const ${tag}${i} = compute(items, ${i}); // pad`).join("\n");
/** 单行末尾追加 n 个字符，模拟逐字增长 */
const C = (n: number, tag = "a") => codeOf(8, tag) + "x".repeat(n);

const setup = (opts: Parameters<typeof createThrottledCodePlugin>[1] = {}) => {
  const k = makeClock();
  const b = makeBase();
  const plugin = createThrottledCodePlugin(b.base, { clock: k.clock, ...opts });
  return { k, plugin, ...b };
};

// ───────── extendHighlightResult ─────────

describe("extendHighlightResult：旧色前缀 + 无色增量", () => {
  it("续写同一行：文字等于新 code，已有 token 引用复用，新增为无色 token", () => {
    const prev = colored("const a = 1;");
    const out = extendHighlightResult(prev, "const a = 1;", "const a = 1; // hi");
    expect(render(out)).toBe("const a = 1; // hi");
    expect(out.tokens[0][0]).toBe(prev.tokens[0][0]);
    expect(hasColor(out.tokens[0][1])).toBe(false);
    expect(out.tokens[0][1].content).toBe(" // hi");
  });

  it("续写跨多行（含空行）：文字一致，前缀行数组引用复用", () => {
    const prev = colored("a\nb");
    const out = extendHighlightResult(prev, "a\nb", "a\nb c\nd\n\ne");
    expect(render(out)).toBe("a\nb c\nd\n\ne");
    expect(out.tokens[0]).toBe(prev.tokens[0]);
    expect(out.tokens[3]).toEqual([]);
  });

  it("prev 以换行结尾（末行为空）：续写落在新的一行", () => {
    const out = extendHighlightResult(colored("a\n"), "a\n", "a\nb");
    expect(out.tokens).toHaveLength(2);
    expect(render(out)).toBe("a\nb");
    expect(hasColor(out.tokens[0][0])).toBe(true);
  });

  it("suffix 以换行开头：上一行保持原样，不追加空 token", () => {
    const prev = colored("a");
    const out = extendHighlightResult(prev, "a", "a\nb");
    expect(out.tokens[0]).toBe(prev.tokens[0]);
    expect(render(out)).toBe("a\nb");
  });

  it("suffix 为空 → 返回同一份结果", () => {
    const prev = colored("a");
    expect(extendHighlightResult(prev, "a", "a")).toBe(prev);
  });

  it("next 不以 prev 为前缀（调用方不该这么用）→ 原样返回，不抛", () => {
    const prev = colored("abc");
    expect(extendHighlightResult(prev, "abc", "xyz")).toBe(prev);
  });

  it("保留 fg / bg / themeName / rootStyle 等非 tokens 字段", () => {
    const out = extendHighlightResult(colored("a"), "a", "ab") as unknown as Record<string, unknown>;
    expect(out.fg).toBe("#000");
    expect(out.bg).toBe("#fff");
    expect(out.themeName).toBe("fake");
    expect(out.rootStyle).toBe("");
  });

  it("上游行数比 prev 的 split 行数少（尾随空行被吞）：先补齐再续写，位置正确", () => {
    const short = { ...colored("a"), tokens: [colored("a").tokens[0]] } as HighlightResult;
    const out = extendHighlightResult(short, "a\n", "a\nb");
    expect(render(out)).toBe("a\nb");
  });

  it("末行是 [{content:''}] 的空行：续写时剔除空 token", () => {
    const prev = { ...colored("a\n"), tokens: [colored("a").tokens[0], [{ content: "", offset: 2 }]] } as unknown as HighlightResult;
    const out = extendHighlightResult(prev, "a\n", "a\nb");
    expect(out.tokens[1]).toHaveLength(1);
    expect(out.tokens[1][0].content).toBe("b");
  });

  it("链式延展多次，文字始终等于最新 code", () => {
    let code = "const a = 1;\nconst b";
    let cur = colored(code);
    for (const add of [" = 2;", "\n", "\nfoo", "()", ";\n\n", "end"]) {
      const next = code + add;
      cur = extendHighlightResult(cur, code, next);
      code = next;
      expect(render(cur)).toBe(code);
    }
  });

  it("不修改入参", () => {
    const prev = colored("a\nb");
    const snapshot = JSON.stringify(prev);
    extendHighlightResult(prev, "a\nb", "a\nb c\nd");
    expect(JSON.stringify(prev)).toBe(snapshot);
  });

  it("offset 随新增文字递增（供下游需要时参考）", () => {
    const out = extendHighlightResult(colored("ab"), "ab", "ab\ncd");
    expect(out.tokens[1][0].offset).toBe(3);
  });
});

// ───────── 节流行为 ─────────

describe("短代码直通", () => {
  it("<240 字符：不建 slot、不节流，回调原样转发", () => {
    const { plugin, calls, finish } = setup();
    const cb = vi.fn();
    expect(plugin.highlight(req("const a = 1;"), cb)).toBeNull();
    expect(plugin.highlight(req("const a = 1; // x"), cb)).toBeNull();
    expect(calls).toHaveLength(2);
    finish(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(plugin.getStats()).toMatchObject({ requests: 2, passthrough: 2, submitted: 0, slots: 0 });
  });

  it("恰好卡在阈值：239 直通，240 进入节流跟踪", () => {
    const { plugin } = setup();
    plugin.highlight(req("x".repeat(THROTTLED_CODE_DEFAULTS.minThrottleCodeLength - 1)));
    expect(plugin.getStats().slots).toBe(0);
    plugin.highlight(req("y".repeat(THROTTLED_CODE_DEFAULTS.minThrottleCodeLength)));
    expect(plugin.getStats().slots).toBe(1);
  });
});

describe("窗口内：不跑高亮，文字照常增长", () => {
  it("首次立即提交；窗口内不再提交，返回「旧色 + 无色增量」", () => {
    const { plugin, calls, finish, k } = setup();
    const cb1 = vi.fn();
    expect(plugin.highlight(req(C(0)), cb1)).toBeNull();
    expect(calls).toHaveLength(1);
    finish(0);
    k.advance(10);

    const r = plugin.highlight(req(C(5)), vi.fn());
    expect(calls).toHaveLength(1); // 没有新提交
    expect(render(r!)).toBe(C(5)); // 文字已是最新
    expect(r!.tokens[0][0]).toMatchObject({ color: "#f00" }); // 旧色保留
    const lastLine = r!.tokens[r!.tokens.length - 1];
    expect(hasColor(lastLine[lastLine.length - 1])).toBe(false); // 新增部分无色
  });

  it("还没有任何真实高亮结果时，窗口内返回 null（界面保持原样）", () => {
    const { plugin, calls, k } = setup();
    plugin.highlight(req(C(0)), vi.fn());
    k.advance(10);
    expect(plugin.highlight(req(C(3)), vi.fn())).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("窗口到期：只提交一次，用最新 code；所有窗口内回调都收到结果", () => {
    const { plugin, calls, finish, k } = setup();
    const cb1 = vi.fn();
    plugin.highlight(req(C(0)), cb1);
    finish(0);
    expect(cb1).toHaveBeenCalledTimes(1);

    const cb2 = vi.fn();
    const cb3 = vi.fn();
    k.advance(10);
    plugin.highlight(req(C(5)), cb2);
    plugin.highlight(req(C(9)), cb3);
    expect(calls).toHaveLength(1);
    expect(k.timerCount()).toBe(1); // 只会有一个 trailing 定时器

    k.advance(300);
    expect(calls).toHaveLength(2);
    expect(calls[1].req.code).toBe(C(9));
    finish(1);
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb3).toHaveBeenCalledTimes(1);
    expect(render(cb3.mock.calls[0][0])).toBe(C(9));
    expect(cb1).toHaveBeenCalledTimes(1); // 首次的回调不会被重复调用
  });

  it("窗口已过、没有 pending 的新请求：立即提交", () => {
    const { plugin, calls, finish, k } = setup();
    plugin.highlight(req(C(0)), vi.fn());
    finish(0);
    k.advance(500);
    plugin.highlight(req(C(4)), vi.fn());
    expect(calls).toHaveLength(2);
    expect(calls[1].req.code).toBe(C(4));
  });

  it("窗口已过但定时器还没来得及触发：新请求立即提交，并带上 pending 的回调、取消定时器", () => {
    const { plugin, calls, finish, k } = setup();
    plugin.highlight(req(C(0)), vi.fn());
    finish(0);
    const cbMid = vi.fn();
    const cbNew = vi.fn();
    k.advance(10);
    plugin.highlight(req(C(2)), cbMid); // 进 pending，挂上 trailing 定时器
    expect(k.timerCount()).toBe(1);

    k.jump(500); // 主线程被占住：时间越过窗口，但定时器没轮到
    plugin.highlight(req(C(4)), cbNew); // dueIn<=0 → 取消定时器、立即提交
    expect(k.timerCount()).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].req.code).toBe(C(4));

    finish(1);
    expect(cbMid).toHaveBeenCalledTimes(1); // 被取代的 pending 回调没有丢
    expect(cbNew).toHaveBeenCalledTimes(1);
    expect(render(cbMid.mock.calls[0][0])).toBe(C(4));
    expect(plugin.getStats().flushed).toBe(0); // 不是靠定时器落地的
  });
});

describe("窗口长度：上次耗时 × costFactor，夹在 [min, max]", () => {
  it("耗时 50ms → 窗口 200ms：199ms 仍节流，200ms 到期提交", () => {
    const { plugin, calls, finish, k } = setup();
    plugin.highlight(req(C(0)), vi.fn());
    k.advance(50);
    finish(0); // cost = 50
    k.advance(149); // 距首次提交 199ms
    plugin.highlight(req(C(1)), vi.fn());
    expect(calls).toHaveLength(1);
    k.advance(1); // 200ms：trailing 触发
    expect(calls).toHaveLength(2);
  });

  it("耗时很小 → 取下限 minIntervalMs（120）", () => {
    const { plugin, calls, finish, k } = setup();
    plugin.highlight(req(C(0)), vi.fn());
    finish(0); // cost = 0
    k.advance(119);
    plugin.highlight(req(C(1)), vi.fn());
    expect(calls).toHaveLength(1);
    k.advance(1);
    expect(calls).toHaveLength(2);
  });

  it("耗时很大 → 取上限 maxIntervalMs（1000）", () => {
    const { plugin, calls, finish, k } = setup();
    plugin.highlight(req(C(0)), vi.fn());
    k.advance(600);
    finish(0); // cost = 600 → 2400 → 夹到 1000
    k.advance(399); // 距首次提交 999ms
    plugin.highlight(req(C(1)), vi.fn());
    expect(calls).toHaveLength(1);
    k.advance(1);
    expect(calls).toHaveLength(2);
  });

  it("耗时用 EWMA 平滑：一次异常慢的样本不会让窗口永久变大", () => {
    const { plugin, calls, finish, k } = setup({ costSmoothing: 0.5 });
    plugin.highlight(req(C(0)), vi.fn());
    k.advance(400);
    finish(0); // costMs = 400 → 窗口 1000（夹）
    for (let i = 1; i <= 4; i++) {
      k.advance(1000);
      plugin.highlight(req(C(i)), vi.fn());
      finish(calls.length - 1); // 这次几乎瞬间完成：cost = 0
    }
    // 400 → 200 → 100 → 50 → 25：窗口已缩回下限 120。
    // 若耗时没被平滑（窗口永远 1000），120ms 后的请求会被节流、calls 仍是 5
    expect(calls).toHaveLength(5);
    k.advance(120);
    plugin.highlight(req(C(9)), vi.fn());
    expect(calls).toHaveLength(6);
  });
});

describe("不同块互不干扰 / 分叉不丢请求", () => {
  it("两个互不为前缀的长代码块：各自立即提交，互不节流", () => {
    const { plugin, calls } = setup();
    plugin.highlight(req(C(0, "a")), vi.fn());
    plugin.highlight(req(C(0, "b")), vi.fn());
    expect(calls).toHaveLength(2);
    expect(plugin.getStats().slots).toBe(2);
  });

  it("同代码不同语言 / 不同主题 → 不同块", () => {
    const { plugin, calls } = setup();
    plugin.highlight(req(C(0)), vi.fn());
    plugin.highlight(req(C(0), { language: "js" as never }), vi.fn());
    plugin.highlight(req(C(0), { themes: ["github-light", "nord"] }), vi.fn());
    expect(calls).toHaveLength(3);
  });

  it("共享已提交前缀的两块（分叉）：旧 pending 先落地，新请求另起一块，谁都不丢", () => {
    const { plugin, calls, finish, k } = setup();
    const head = codeOf(8, "s") + "\nA0"; // 两块共享的、已提交的前缀
    const cbA = vi.fn();
    const cbB = vi.fn();
    plugin.highlight(req(head), vi.fn()); // 块 A 起步
    finish(0);
    k.advance(10);
    plugin.highlight(req(head + " more"), cbA); // A 的增长：窗口内 → pending
    expect(calls).toHaveLength(1);

    // B 也以 head 为前缀，但不是 A 的 pending（head + " more"）的延伸 → 分叉
    plugin.highlight(req(head + " other"), cbB);
    expect(calls).toHaveLength(3); // A 的 pending 被落地 + B 立即提交
    expect(calls[1].req.code).toBe(head + " more");
    expect(calls[2].req.code).toBe(head + " other");
    expect(plugin.getStats().forks).toBe(1);
    expect(plugin.getStats().slots).toBe(2);

    finish(1);
    finish(2);
    expect(render(cbA.mock.calls[0][0])).toBe(head + " more"); // 没被 B 的文字污染
    expect(render(cbB.mock.calls[0][0])).toBe(head + " other");

    // 之后各自增长，互不串线
    k.advance(500);
    plugin.highlight(req(head + " more!!"), vi.fn());
    plugin.highlight(req(head + " other!!"), vi.fn());
    expect(calls[3].req.code).toBe(head + " more!!");
    expect(calls[4].req.code).toBe(head + " other!!");
  });

  it("与另一块无关的新请求不会动别人的 pending（pending 仍会按时落地）", () => {
    const { plugin, calls, finish, k } = setup();
    plugin.highlight(req(C(0, "a")), vi.fn());
    finish(0);
    k.advance(10);
    plugin.highlight(req(C(3, "a")), vi.fn()); // a 块 pending
    plugin.highlight(req(C(0, "b")), vi.fn()); // 无关的 b 块：立即提交
    expect(calls).toHaveLength(2);
    k.advance(500);
    expect(calls[2].req.code).toBe(C(3, "a")); // a 的 pending 照常落地
  });
});

describe("缓存", () => {
  it("同一份 code 完成后再次请求：本层缓存同步命中，不再调用上游", () => {
    const { plugin, calls, finish, k } = setup();
    plugin.highlight(req(C(0)), vi.fn());
    finish(0);
    k.advance(500);
    const hit = plugin.highlight(req(C(0)), vi.fn());
    expect(hit).not.toBeNull();
    expect(render(hit!)).toBe(C(0));
    expect(calls).toHaveLength(1);
    expect(plugin.getStats().cacheHits).toBe(1);
  });

  it("上游同步命中：直接返回结果；trailing 落地时命中则补发给窗口内的回调", () => {
    const { plugin, calls, cache, finish, k } = setup();
    plugin.highlight(req(C(0)), vi.fn());
    finish(0);
    k.advance(10);
    const cb = vi.fn();
    plugin.highlight(req(C(6)), cb); // 窗口内 → pending
    cache.set(C(6), colored(C(6))); // 上游此刻已有这份结果（比如别处刚高亮过）
    k.advance(500); // trailing → submit → 上游同步命中
    expect(calls).toHaveLength(1); // 上游没有新增异步任务
    expect(cb).toHaveBeenCalledTimes(1);
    expect(render(cb.mock.calls[0][0])).toBe(C(6));
  });

  it("同一 slot 只保留最新一份中间结果：旧版本不再命中缓存", () => {
    const { plugin, finish, k } = setup();
    plugin.highlight(req(C(0)), vi.fn());
    finish(0);
    k.advance(500);
    plugin.highlight(req(C(5)), vi.fn());
    finish(1);
    // C(0) 的结果已被 C(5) 的取代 → 再请求 C(0) 不会同步命中本层缓存（落到上游，上游缓存命中也行，这里只看本层）
    const before = plugin.getStats().cacheHits;
    k.advance(500);
    plugin.highlight(req(C(0)), vi.fn());
    expect(plugin.getStats().cacheHits).toBe(before);
  });

  it("结果缓存条数有上限（LRU）", () => {
    const { plugin, calls, finish, k } = setup({ maxResults: 4, maxSlots: 100 });
    for (let i = 0; i < 10; i++) {
      plugin.highlight(req(C(0, `blk${i}_`)), vi.fn());
      finish(calls.length - 1);
      k.advance(1);
    }
    let hits = 0;
    for (let i = 0; i < 10; i++) {
      const before = plugin.getStats().cacheHits;
      plugin.highlight(req(C(0, `blk${i}_`)), vi.fn());
      if (plugin.getStats().cacheHits > before) hits++;
    }
    expect(hits).toBeLessThanOrEqual(4);
  });
});

describe("I2 文字不回退", () => {
  it("提交 C0 后又收到更长的 C7：C0 的结果回来时被补齐到 C7 再交给回调，旧色保留", () => {
    const { plugin, finish, k } = setup();
    const cb1 = vi.fn();
    plugin.highlight(req(C(0)), cb1);
    k.advance(10);
    plugin.highlight(req(C(7)), vi.fn()); // 进 pending，latest = C7
    finish(0); // C0 的结果现在才回来
    const out = cb1.mock.calls[0][0] as HighlightResult;
    expect(render(out)).toBe(C(7));
    expect(out.tokens[0][0]).toMatchObject({ color: "#f00" });
  });

  it("旧提交的结果乱序迟到：不会覆盖更新的结果，回调拿到的仍是最新文字", () => {
    const { plugin, finish, k } = setup();
    const cb0 = vi.fn();
    plugin.highlight(req(C(0)), cb0); // #0
    k.advance(300);
    plugin.highlight(req(C(9)), vi.fn()); // #1（窗口已过，立即提交）
    finish(1); // 新的先回来
    finish(0); // 旧的迟到
    expect(render(cb0.mock.calls[cb0.mock.calls.length - 1][0])).toBe(C(9));
  });
});

describe("回收与容量（I4）", () => {
  it("slot 数不超过 maxSlots；被挤掉的 slot 若有 pending，先落地不丢", () => {
    const { plugin, calls, finish, k } = setup({ maxSlots: 3 });
    const cbs: ReturnType<typeof vi.fn>[] = [];
    for (let i = 0; i < 6; i++) {
      const cb = vi.fn();
      cbs.push(cb);
      plugin.highlight(req(C(0, `s${i}_`)), cb);
      finish(calls.length - 1);
      k.advance(1);
      plugin.highlight(req(C(3, `s${i}_`)), vi.fn()); // 每块都留一个 pending
    }
    expect(plugin.getStats().slots).toBeLessThanOrEqual(3 + 1);
    // 所有被挤掉的块的 pending 都已提交：最后统一落地后，每块最新 code 都被提交过
    k.advance(2000);
    for (let i = 0; i < 6; i++) {
      expect(calls.some((c) => c.req.code === C(3, `s${i}_`))).toBe(true);
    }
  });

  it("闲置超过 TTL 的 slot 被回收：之后同块请求视为新块，立即提交", () => {
    const { plugin, calls, finish, k } = setup({ slotTtlMs: 5000 });
    plugin.highlight(req(C(0)), vi.fn());
    finish(0);
    expect(plugin.getStats().slots).toBe(1);
    k.advance(6000);
    plugin.highlight(req(C(0, "zzz_")), vi.fn()); // 触发 prune
    expect(plugin.getStats().slots).toBe(1); // 旧的被回收、新的加入
    plugin.highlight(req(C(4)), vi.fn());
    expect(calls[calls.length - 1].req.code).toBe(C(4));
  });

  it("有 pending 的 slot 不会被 TTL 回收", () => {
    const { plugin, calls, finish, k } = setup({ slotTtlMs: 5000, minIntervalMs: 100000, maxIntervalMs: 100000 });
    plugin.highlight(req(C(0)), vi.fn());
    finish(0);
    plugin.highlight(req(C(2)), vi.fn()); // pending（窗口 100s）
    k.advance(6000); // 超过 TTL（5s），但没到 100s 窗口 → 定时器未触发
    plugin.highlight(req(C(0, "other_")), vi.fn()); // 触发 prune
    expect(plugin.getStats().slots).toBe(2); // 有 pending 的没被回收
    expect(calls).toHaveLength(2); // other 立即提交；原 slot 的 pending 仍在等
  });

  it("单窗口内累积的回调有上限，超出丢最早的（它们等价于同一个 setState）", () => {
    const { plugin, calls, finish, k } = setup({ maxPendingCallbacks: 3 });
    plugin.highlight(req(C(0)), vi.fn());
    finish(0);
    k.advance(10);
    const cbs = Array.from({ length: 5 }, () => vi.fn());
    cbs.forEach((cb, i) => plugin.highlight(req(C(i + 1)), cb));
    k.advance(500);
    finish(calls.length - 1);
    expect(cbs.map((cb) => cb.mock.calls.length)).toEqual([0, 0, 1, 1, 1]);
  });
});

describe("健壮性", () => {
  it("上游同步抛错：不向外抛，返回 null", () => {
    const { base } = makeBase();
    (base.highlight as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("boom");
    });
    const k = makeClock();
    const plugin = createThrottledCodePlugin(base, { clock: k.clock });
    expect(() => plugin.highlight(req("short"), vi.fn())).not.toThrow();
    expect(plugin.highlight(req(C(0)), vi.fn())).toBeNull();
    k.advance(10);
    expect(plugin.highlight(req(C(3)), vi.fn())).toBeNull();
    expect(() => k.advance(1000)).not.toThrow();
  });

  it("一个回调抛错不影响同窗口内的其它回调", () => {
    const { plugin, finish, k } = setup();
    plugin.highlight(req(C(0)), vi.fn());
    finish(0);
    k.advance(10);
    const bad = vi.fn(() => {
      throw new Error("ui crashed");
    });
    const good = vi.fn();
    plugin.highlight(req(C(2)), bad);
    plugin.highlight(req(C(4)), good);
    k.advance(500);
    expect(() => finish(1)).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("没有传回调：不崩溃（窗口内仍返回延展结果）", () => {
    const { plugin, finish, k } = setup();
    plugin.highlight(req(C(0)));
    finish(0);
    k.advance(10);
    const r = plugin.highlight(req(C(3)));
    expect(render(r!)).toBe(C(3));
    expect(() => k.advance(500)).not.toThrow();
  });

  it("插件元信息与上游一致（Streamdown 通过它们判断语言 / 主题）", () => {
    const { plugin, base } = setup();
    expect(plugin.name).toBe("shiki");
    expect(plugin.type).toBe("code-highlighter");
    expect(plugin.supportsLanguage("ts" as never)).toBe(true);
    expect(plugin.getSupportedLanguages()).toEqual(["ts"]);
    expect(plugin.getThemes()).toEqual(["github-light", "github-dark"]);
    expect(base.supportsLanguage).toHaveBeenCalledWith("ts");
  });
});

describe("统计字段（给观测用）", () => {
  it("requests / submitted / throttled / flushed / cost 累计正确", () => {
    const { plugin, finish, k } = setup();
    plugin.highlight(req(C(0)), vi.fn()); // submitted 1
    k.advance(40);
    finish(0); // cost 40
    k.advance(10);
    plugin.highlight(req(C(1)), vi.fn()); // throttled 1
    plugin.highlight(req(C(2)), vi.fn()); // throttled 2
    k.advance(500); // flushed 1 → submitted 2
    finish(1);
    const s = plugin.getStats();
    expect(s.requests).toBe(3);
    expect(s.submitted).toBe(2);
    expect(s.throttled).toBe(2);
    expect(s.flushed).toBe(1);
    expect(s.costCount).toBe(2);
    expect(s.costMaxMs).toBeGreaterThanOrEqual(40);
    expect(s.costSumMs).toBeGreaterThanOrEqual(40);
  });

  it("takeStats：取走窗口增量并清零；costMaxMs 是窗口内最大值；getStats 仍是生命期累计", () => {
    const { plugin, finish, k } = setup();
    plugin.highlight(req(C(0)), vi.fn());
    k.advance(30);
    finish(0); // cost 30
    k.advance(10);
    plugin.highlight(req(C(1)), vi.fn()); // 窗口内 → throttled

    const w1 = plugin.takeStats();
    expect(w1).toMatchObject({ requests: 2, submitted: 1, throttled: 1, costCount: 1, costMaxMs: 30, slots: 1 });

    k.advance(500); // trailing 落地 → submitted 2
    finish(1);
    const w2 = plugin.takeStats();
    expect(w2).toMatchObject({ requests: 0, submitted: 1, throttled: 0, flushed: 1, costCount: 1 });
    expect(w2.costMaxMs).toBeGreaterThan(30); // 上个窗口的 30 不会残留；这个窗口的耗时更长
    expect(w2.costSumMs).toBe(w2.costMaxMs);

    // 没有新活动：全部归零（slots 是当前值，不清）
    expect(plugin.takeStats()).toMatchObject({
      requests: 0, submitted: 0, throttled: 0, flushed: 0, costCount: 0, costMaxMs: 0, costSumMs: 0, slots: 1,
    });

    // 累计值不受 takeStats 影响
    expect(plugin.getStats()).toMatchObject({ requests: 2, submitted: 2, throttled: 1, flushed: 1, costCount: 2 });
  });
});

// ───────── 属性测试：随机增长 / 随机时间 / 随机完成顺序 ─────────

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("属性：随机序列下 I1 / I2 / I3 恒成立", () => {
  const fullCode = Array.from(
    { length: 40 },
    (_, i) => `${"  ".repeat(i % 3)}const v${i} = useMemo(() => compute(items, ${i}), [items]);`,
  ).join("\n");

  for (let seed = 1; seed <= 150; seed++) {
    it(`seed=${seed}`, () => {
      const rnd = mulberry32(seed);
      const { plugin, calls, finish, k } = setup({
        minIntervalMs: 20 + Math.floor(rnd() * 80),
        maxIntervalMs: 200 + Math.floor(rnd() * 600),
      });

      let ui: HighlightResult = {
        tokens: [[{ content: fullCode.slice(0, 260), offset: 0 }]],
      } as unknown as HighlightResult; // Streamdown 的初值：raw 文本
      let uiLen = ui.tokens[0][0].content.length;
      let done = 0; // 已完成的提交数（上游按序完成）
      const apply = (r: HighlightResult) => {
        ui = r;
      };
      const check = (current: string) => {
        const text = render(ui);
        expect(current.startsWith(text) || text === current).toBe(true); // 文字是当前 code 的前缀（不会超前、不会错位）
        expect(text.length).toBeGreaterThanOrEqual(uiLen); // 不回退
        uiLen = text.length;
      };

      let len = 260;
      while (len < fullCode.length) {
        len = Math.min(fullCode.length, len + 1 + Math.floor(rnd() * 30));
        const current = fullCode.slice(0, len);
        const r = plugin.highlight(req(current), apply);
        if (r) apply(r);
        check(current);
        k.advance(Math.floor(rnd() * 60));
        // 随机完成若干个已提交的高亮
        while (done < calls.length && rnd() < 0.5) {
          finish(done++);
          check(current);
        }
      }

      // 收尾：让所有定时器与高亮落定
      for (let round = 0; round < 20; round++) {
        k.advance(2000);
        while (done < calls.length) finish(done++);
        if (k.timerCount() === 0 && done >= calls.length) break;
      }
      // I3 终态正确
      expect(render(ui)).toBe(fullCode);
      // I1 最终 code 一定被提交过（或命中过缓存）
      expect(calls.some((c) => c.req.code === fullCode) || plugin.getStats().cacheHits > 0).toBe(true);
      // I4 容量
      expect(plugin.getStats().slots).toBeLessThanOrEqual(THROTTLED_CODE_DEFAULTS.maxSlots);
    });
  }

  it("节流确实把提交次数压了下来（逐帧请求 vs 实际高亮）", () => {
    const { plugin, calls, finish, k } = setup();
    let done = 0;
    let requests = 0;
    for (let len = 260; len < fullCode.length; len += 8) {
      plugin.highlight(req(fullCode.slice(0, len)), vi.fn());
      requests++;
      k.advance(16); // 60fps
      while (done < calls.length) finish(done++);
    }
    expect(requests).toBeGreaterThan(60);
    expect(calls.length).toBeLessThan(requests / 4);
  });
});

// ───────── 真实 Shiki 集成 ─────────

describe("真实 Shiki 集成（@streamdown/code）", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const realistic = Array.from(
    { length: 60 },
    (_, i) =>
      i % 7 === 0
        ? `export function handle${i}(input: Input${i}): Promise<void> {`
        : i % 7 === 6
          ? "}"
          : `  const r${i} = await fetchSomething(input.id, { retries: ${i % 5}, signal });`,
  ).join("\n");

  it(
    "逐帧增长：文字单调不回退且始终是当前 code 的前缀；终态与最终 code 一致且已上色；高亮次数远少于请求次数",
    async () => {
      const plugin = createThrottledCodePlugin(realCodePlugin, {
        minIntervalMs: 20,
        maxIntervalMs: 80,
      });
      let ui = {
        tokens: [[{ content: realistic.slice(0, 260), offset: 0 }]],
      } as unknown as HighlightResult;
      let prevLen = 0;
      const apply = (r: HighlightResult) => {
        ui = r;
      };

      for (let len = 260; len < realistic.length; len += 20) {
        const current = realistic.slice(0, len);
        const r = plugin.highlight(req(current), apply);
        if (r) apply(r);
        const text = render(ui);
        expect(current.startsWith(text)).toBe(true);
        expect(text.length).toBeGreaterThanOrEqual(prevLen);
        prevLen = text.length;
        await sleep(6);
      }
      const r = plugin.highlight(req(realistic), apply);
      if (r) apply(r);

      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (render(ui) === realistic && ui.tokens.flat().some(hasColor)) break;
        await sleep(20);
      }
      expect(render(ui)).toBe(realistic);

      const colorful = ui.tokens.flat().filter(hasColor).length;
      expect(colorful / ui.tokens.flat().length).toBeGreaterThan(0.5);

      const s = plugin.getStats();
      expect(s.throttled).toBeGreaterThan(0);
      expect(s.submitted).toBeLessThan(s.requests / 2);
    },
    30_000,
  );

  it("上游真实的行数规则：尾随换行 → 多一个空末行；延展后文字仍与 code 一致", async () => {
    const run = (src: string) =>
      new Promise<HighlightResult>((resolve) => {
        const r = realCodePlugin.highlight(req(src), resolve);
        if (r) resolve(r);
      });
    const prev = "const a = 1;\nconst b = 2;\n";
    const result = await run(prev);
    expect(result.tokens).toHaveLength(prev.split("\n").length);
    const next = prev + "const c = 3;\n\nlet d";
    expect(render(extendHighlightResult(result, prev, next))).toBe(next);
  }, 30_000);
});
