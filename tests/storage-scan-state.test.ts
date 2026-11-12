/**
 * 会话管理页占用统计的纯逻辑 + 页面接线契约（评审 R15-01 / R15-19）。
 *
 * R15-01：旧轮询的下一次定时器只由「storage 状态变了」排出来——静默请求失败 / 到上限时链条悄悄断掉，
 * pending 仍 > 0，「重新统计」按钮永久禁用、顶部一直挂「统计中…」。
 * R15-19：统计中的行显示只含任务数据的偏小数字且可按占用排序，轮询期间行会跳。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  decideNextPoll,
  isSizeSortReady,
  STORAGE_POLL_MAX_FAILS,
  STORAGE_FETCH_TIMEOUT_MS,
  STORAGE_POLL_MAX_MS,
  STORAGE_POLL_MS,
  stepPoll,
  worktreeSizeState,
} from "@/lib/storage-scan-state";

describe("decideNextPoll：轮询继续 / 放弃", () => {
  const t0 = 1_000_000;

  it("正常：隔一个基础间隔再拉", () => {
    expect(decideNextPoll({ startedAt: t0, now: t0 + 100, consecutiveFailures: 0 })).toEqual({
      action: "wait",
      delayMs: STORAGE_POLL_MS,
    });
  });

  it("失败也要排下一次（旧实现在这里把链条断掉了）：指数退避、最多放大 8 倍", () => {
    const delays = [0, 1, 2, 3, 4].slice(0, STORAGE_POLL_MAX_FAILS).map((f) => {
      const d = decideNextPoll({ startedAt: t0, now: t0 + 100, consecutiveFailures: f });
      expect(d.action).toBe("wait");
      return (d as { delayMs: number }).delayMs;
    });
    expect(delays).toEqual([
      STORAGE_POLL_MS,
      STORAGE_POLL_MS * 2,
      STORAGE_POLL_MS * 4,
      STORAGE_POLL_MS * 8,
      STORAGE_POLL_MS * 8,
    ]);
  });

  it("连续失败达到上限：明确放弃（reason=errors），不再悄悄断掉", () => {
    expect(
      decideNextPoll({ startedAt: t0, now: t0 + 100, consecutiveFailures: STORAGE_POLL_MAX_FAILS }),
    ).toEqual({ action: "giveup", reason: "errors" });
  });

  it("超过最长轮询时长：明确放弃（reason=timeout）；刚好到上限还继续", () => {
    expect(
      decideNextPoll({ startedAt: t0, now: t0 + STORAGE_POLL_MAX_MS, consecutiveFailures: 0 }).action,
    ).toBe("wait");
    expect(
      decideNextPoll({ startedAt: t0, now: t0 + STORAGE_POLL_MAX_MS + 1, consecutiveFailures: 0 }),
    ).toEqual({ action: "giveup", reason: "timeout" });
  });

  it("两个条件同时满足：失败优先报（更能说明问题）", () => {
    expect(
      decideNextPoll({
        startedAt: t0,
        now: t0 + STORAGE_POLL_MAX_MS + 1,
        consecutiveFailures: STORAGE_POLL_MAX_FAILS,
      }),
    ).toEqual({ action: "giveup", reason: "errors" });
  });

  it("成功一次清零失败计数后，间隔回到基础值", () => {
    expect(decideNextPoll({ startedAt: t0, now: t0 + 100, consecutiveFailures: 0 })).toEqual({
      action: "wait",
      delayMs: STORAGE_POLL_MS,
    });
  });
});

describe("stepPoll：一次请求结束后的状态推进（评审 R16-04 / R16-08）", () => {
  const t0 = 1_000_000;
  const late = t0 + STORAGE_POLL_MAX_MS + 5_000; // 已经过了 10 分钟线

  it("失败：连续失败数 +1；成功：清零（failures 这一行以前没有任何测试）", () => {
    expect(stepPoll({ startedAt: t0, failures: 0 }, { ok: false, pending: 0 }, t0 + 1).failures).toBe(1);
    expect(stepPoll({ startedAt: t0, failures: 3 }, { ok: false, pending: 0 }, t0 + 1).failures).toBe(4);
    expect(stepPoll({ startedAt: t0, failures: 4 }, { ok: true, pending: 2 }, t0 + 1).failures).toBe(0);
  });

  it("成功但后台还在量：继续等（按基础间隔）；失败：按失败数退避", () => {
    expect(stepPoll({ startedAt: t0, failures: 2 }, { ok: true, pending: 2 }, t0 + 1).decision).toEqual({
      action: "wait",
      delayMs: STORAGE_POLL_MS,
    });
    expect(stepPoll({ startedAt: t0, failures: 1 }, { ok: false, pending: 0 }, t0 + 1).decision).toEqual({
      action: "wait",
      delayMs: STORAGE_POLL_MS * 4,
    });
  });

  it("失败累计到上限：放弃（errors）", () => {
    const step = stepPoll(
      { startedAt: t0, failures: STORAGE_POLL_MAX_FAILS - 1 },
      { ok: false, pending: 0 },
      t0 + 1,
    );
    expect(step.failures).toBe(STORAGE_POLL_MAX_FAILS);
    expect(step.decision).toEqual({ action: "giveup", reason: "errors" });
  });

  it("【R16-04】过了 10 分钟线，但这一次成功且服务端已量完 → done，不是 timeout（旧代码在这里误报「统计超时」）", () => {
    expect(stepPoll({ startedAt: t0, failures: 0 }, { ok: true, pending: 0 }, late).decision).toEqual({
      action: "done",
    });
  });

  it("过了 10 分钟线、成功但还没量完 → 才算超时；过了线且失败也是放弃（失败过多优先报 errors）", () => {
    expect(stepPoll({ startedAt: t0, failures: 0 }, { ok: true, pending: 1 }, late).decision).toEqual({
      action: "giveup",
      reason: "timeout",
    });
    expect(stepPoll({ startedAt: t0, failures: 0 }, { ok: false, pending: 0 }, late).decision).toEqual({
      action: "giveup",
      reason: "timeout",
    });
  });

  it("失败的请求 pending 无意义：即使带着 pending=0 也不能当成『量完了』", () => {
    expect(stepPoll({ startedAt: t0, failures: 0 }, { ok: false, pending: 0 }, t0 + 1).decision.action).toBe(
      "wait",
    );
  });

  it("单次请求超时有明确上限（挂住的 fetch 不能让链条永远停在 await 上）", () => {
    expect(STORAGE_FETCH_TIMEOUT_MS).toBeGreaterThan(0);
    expect(STORAGE_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("worktreeSizeState：统计中 / 量不出", () => {
  it("有数 = measured（不管 pending 多少）", () => {
    expect(worktreeSizeState(0, { pending: 3, gaveUp: false })).toBe("measured");
    expect(worktreeSizeState(12345, { pending: 0, gaveUp: true })).toBe("measured");
  });

  it("没数、后台还在量 = measuring", () => {
    expect(worktreeSizeState(null, { pending: 2, gaveUp: false })).toBe("measuring");
  });

  it("没数、后台已量完（pending=0）= unmeasurable：不能一直转圈", () => {
    expect(worktreeSizeState(null, { pending: 0, gaveUp: false })).toBe("unmeasurable");
  });

  it("没数、页面放弃了轮询（超时 / 连续失败）= unmeasurable，即使服务端 pending 仍 > 0", () => {
    expect(worktreeSizeState(null, { pending: 5, gaveUp: true })).toBe("unmeasurable");
  });
});

describe("isSizeSortReady：按占用排序何时开放", () => {
  it("占用数据没拉到 → 不可用", () => {
    expect(isSizeSortReady({ hasStorage: false, pending: 0, gaveUp: false })).toBe(false);
  });
  it("还有工作区在统计 → 不可用（行会随轮询跳、可能点错）", () => {
    expect(isSizeSortReady({ hasStorage: true, pending: 3, gaveUp: false })).toBe(false);
  });
  it("统计完 → 可用", () => {
    expect(isSizeSortReady({ hasStorage: true, pending: 0, gaveUp: false })).toBe(true);
  });
  it("页面放弃轮询后（不会再跳了）→ 可用", () => {
    expect(isSizeSortReady({ hasStorage: true, pending: 3, gaveUp: true })).toBe(true);
  });
});

describe("会话管理页接线（源码契约）", () => {
  const src = readFileSync(
    path.join(__dirname, "..", "src", "app", "sessions", "page.tsx"),
    "utf8",
  );

  it("轮询由独立 effect 里的定时链驱动，依赖不含 storage（旧实现靠 storage 变化排下一次→失败时断链）", () => {
    const m = /useEffect\(\(\) => \{\s*if \(!worktreeMeasuring\) return;[\s\S]*?\}, \[([^\]]*)\]\);/.exec(src);
    expect(m, "找不到轮询 effect").not.toBeNull();
    expect(m![1]).not.toMatch(/\bstorage\b/);
    // 链里的推进全交给纯函数 stepPoll，并把 scan 的结果（含 pending）原样交给它
    expect(m![0]).toMatch(/const outcome = await scan\(\{ silent: true \}\)/);
    expect(m![0]).toMatch(/stepPoll\(\{ startedAt, failures \}, outcome, Date\.now\(\)\)/);
    expect(m![0]).toMatch(/failures = step\.failures/);
    expect(m![0]).toMatch(/setPollGaveUp\(next\.reason\)/);
    // 失败也要排下一次：wait 分支调用 schedule；done 分支什么都不做（不得再置放弃标记）
    expect(m![0]).toMatch(/else if \(next\.action === "wait"\) schedule\(next\.delayMs\)/);
    expect(m![0]).not.toMatch(/setPollGaveUp\("timeout"\)/);
  });

  it("scan 返回 { ok, pending }（轮询据此退避 / 收尾），成功与失败两个出口各带一个", () => {
    const m = /const scan = useCallback\([\s\S]*?\}, \[\]\);/.exec(src);
    expect(m, "找不到 scan").not.toBeNull();
    expect(m![0]).toMatch(/Promise<PollOutcome>/);
    expect(m![0]).toMatch(/return \{ ok: true, pending \};/);
    expect(m![0]).toMatch(/return \{ ok: false, pending: 0 \};/);
  });

  it("scan 的请求带超时（AbortController + STORAGE_FETCH_TIMEOUT_MS），并在 finally 里清定时器（R16-06）", () => {
    const m = /const scan = useCallback\([\s\S]*?\}, \[\]\);/.exec(src)!;
    expect(m[0]).toMatch(/new AbortController\(\)/);
    expect(m[0]).toMatch(/setTimeout\(\(\) => aborter\.abort\(\), STORAGE_FETCH_TIMEOUT_MS\)/);
    expect(m[0]).toMatch(/signal: aborter\.signal/);
    expect(m[0]).toMatch(/finally \{\s*clearTimeout\(abortTimer\)/);
  });

  it("放弃轮询后给「继续等待」：只清放弃标记（重起轮询）、不 refresh；「重新统计」才作废缓存（R16-06）", () => {
    const m = /<button\s+type="button"\s+className="[^"]*"\s+onClick=\{[^}]*\}\s*>\s*继续等待\s*<\/button>/.exec(src);
    expect(m, "找不到「继续等待」按钮").not.toBeNull();
    expect(m![0].length, "匹配范围应只是这一个按钮、不是跨了很多代码").toBeLessThan(400);
    expect(m![0]).toMatch(/onClick=\{\(\) => setPollGaveUp\(null\)\}/);
    expect(m![0]).not.toMatch(/refresh/);
    // 只在「放弃了、且服务端确实还在量」时出现
    expect(src).toMatch(/pollGaveUp !== null && worktreePending > 0 && \(\s*<button/);
  });

  it("「重新统计」按钮：放弃轮询后可点（禁用只看 scanning / 仍在统计），点了清掉放弃标记", () => {
    expect(src).toMatch(/disabled=\{scanning \|\| worktreeMeasuring\}/);
    expect(src).not.toMatch(/disabled=\{scanning \|\| worktreePending > 0\}/);
    expect(src).toMatch(/setPollGaveUp\(null\);\s*void scan\(\{ refresh: true \}\)/);
  });

  it("工作区统计中的行带「+」标记；按占用排序在统计中不可用；残留行区分「统计中…」与「量不出」", () => {
    expect(src).toMatch(/worktreeBytes === null && \(\s*<span aria-hidden>\+<\/span>/);
    expect(src).toMatch(/const unavailable = s\.key === "size" && !sizeSortReady/);
    expect(src).toMatch(/if \(sort === "size" && sizeSortReady\)/);
    expect(src).toMatch(/"统计中…"\s*:\s*"量不出"/);
  });

  it("合计注记区分：统计中 / 统计失败 / 统计超时 / 量不出", () => {
    expect(src).toMatch(/（工作区统计中…）/);
    expect(src).toMatch(/工作区统计失败/);
    expect(src).toMatch(/工作区统计超时/);
    expect(src).toMatch(/个工作区量不出/);
  });
});
