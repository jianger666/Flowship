/**
 * N1-03：收件箱「窗口不可见时还扫不扫」。
 *
 * 以前 tick 里 `document.visibilityState !== "visible"` 一律不扫：Cmd+W 收进托盘后角标不涨、通知发不出，
 * 回前台补拉时 `document.hasFocus()` 已为真，通知又被静默——「不在窗口前也要提醒」的功能在最需要的时候失效。
 * 现在：可见照旧；Electron 壳内不可见放宽到 10 分钟继续扫；浏览器标签页不可见仍不扫。
 * 决策在纯函数 shouldPollInboxNow，这里测行为（含一整段时间线的节奏）；
 * tick / 回前台补拉 / 发起时刻的接线在 `mr-inbox-poller.ts`（行为测试见 mr-inbox-poller.test.ts），
 * hook 里剩下的三处接线见 mr-inbox-hook-wiring-contract.test.ts。
 */
import { describe, expect, it } from "vitest";
import {
  MR_INBOX_CACHE_TTL_MS,
  MR_INBOX_HIDDEN_POLL_INTERVAL_MS,
  MR_INBOX_POLL_INTERVAL_MS,
} from "@/lib/mr-inbox";
import { shouldPollInboxNow } from "@/lib/mr-inbox-state";

const MIN = 60 * 1000;

describe("shouldPollInboxNow：单点判定", () => {
  it("窗口可见：无论壳 / 浏览器、距上次多久，每拍都扫（行为与以前一致）", () => {
    for (const inShell of [true, false]) {
      for (const sinceLastFetchMs of [0, 1, MIN, MR_INBOX_POLL_INTERVAL_MS, 10 * MIN]) {
        expect(
          shouldPollInboxNow({ visible: true, inShell, sinceLastFetchMs }),
        ).toBe(true);
      }
    }
  });

  it("浏览器标签页不可见：永远不扫（距上次再久也不扫，没人看的标签页不占 meegle / GitLab 额度）", () => {
    for (const sinceLastFetchMs of [0, 5 * MIN, 10 * MIN, 24 * 60 * MIN]) {
      expect(
        shouldPollInboxNow({ visible: false, inShell: false, sinceLastFetchMs }),
      ).toBe(false);
    }
  });

  it("壳内不可见：刚扫完那一拍（距上次 5 分钟）不扫，满约 10 分钟那一拍才扫", () => {
    const at = (sinceLastFetchMs: number) =>
      shouldPollInboxNow({ visible: false, inShell: true, sinceLastFetchMs });
    expect(at(0)).toBe(false);
    expect(at(MR_INBOX_POLL_INTERVAL_MS)).toBe(false);
    expect(at(MR_INBOX_HIDDEN_POLL_INTERVAL_MS)).toBe(true);
    expect(at(MR_INBOX_HIDDEN_POLL_INTERVAL_MS + MIN)).toBe(true);
    expect(at(60 * MIN)).toBe(true);
  });

  it("壳内不可见：容差——距上次略小于 10 分钟（抖动 / 扫描耗时）仍扫，否则会被拖成每 15 分钟", () => {
    const at = (sinceLastFetchMs: number) =>
      shouldPollInboxNow({ visible: false, inShell: true, sinceLastFetchMs });
    expect(at(MR_INBOX_HIDDEN_POLL_INTERVAL_MS - 30_000)).toBe(true);
    expect(at(MR_INBOX_HIDDEN_POLL_INTERVAL_MS - 2 * MIN)).toBe(true);
    // 容差只有半拍：距上次不到 7.5 分钟的拍（典型：刚扫完隔一拍）不能扫
    expect(at(MR_INBOX_HIDDEN_POLL_INTERVAL_MS - 3 * MIN)).toBe(false);
  });
});

describe("常量关系（「隔拍扫」成立的前提）", () => {
  it("不可见间隔是拍的整数倍、且比拍长", () => {
    expect(MR_INBOX_HIDDEN_POLL_INTERVAL_MS).toBeGreaterThan(
      MR_INBOX_POLL_INTERVAL_MS,
    );
    expect(MR_INBOX_HIDDEN_POLL_INTERVAL_MS % MR_INBOX_POLL_INTERVAL_MS).toBe(0);
  });

  it("不可见间隔大于缓存 TTL：每次不可见扫描都是真扫，不会命中服务端缓存白跑一拍", () => {
    expect(MR_INBOX_HIDDEN_POLL_INTERVAL_MS).toBeGreaterThan(
      MR_INBOX_CACHE_TTL_MS,
    );
  });
});

/**
 * 用真实判定函数跑一段时间线：每 5 分钟一拍（可带抖动），scan 记录「发起时刻」（对应 hook 的 lastFetchAtRef）。
 * visibleAt(t)：t 时刻窗口是否可见。
 */
const simulate = (opts: {
  inShell: boolean;
  totalMs: number;
  visibleAt: (t: number) => boolean;
  jitterMs?: (tickIndex: number) => number;
  /** 启动时那次立即扫描的时刻（hook 启动即拉） */
  startScanAt?: number;
  /** 用户手动刷新的时刻（不在拍上，会打乱相位；手动刷新也会记发起时刻） */
  manualScanAt?: number;
}): number[] => {
  const scans: number[] = [opts.startScanAt ?? 0];
  let lastFetchAt = scans[0];
  let manualPending = opts.manualScanAt;
  for (let k = 1; k * MR_INBOX_POLL_INTERVAL_MS <= opts.totalMs; k++) {
    const t = k * MR_INBOX_POLL_INTERVAL_MS + (opts.jitterMs?.(k) ?? 0);
    if (manualPending !== undefined && manualPending <= t) {
      scans.push(manualPending);
      lastFetchAt = manualPending;
      manualPending = undefined;
    }
    if (
      shouldPollInboxNow({
        visible: opts.visibleAt(t),
        inShell: opts.inShell,
        sinceLastFetchMs: t - lastFetchAt,
      })
    ) {
      scans.push(t);
      lastFetchAt = t;
    }
  }
  return scans;
};

const gaps = (scans: number[]): number[] =>
  scans.slice(1).map((t, i) => t - scans[i]);

describe("shouldPollInboxNow：整段时间线的节奏", () => {
  const HOURS = 2 * 60 * MIN;

  it("壳内一直不可见（收进托盘 2 小时）：每 10 分钟扫一次，含启动那次共 13 次（启动 1 + 之后 12 个 10 分钟点）、间隔恒为 10 分钟", () => {
    const scans = simulate({
      inShell: true,
      totalMs: HOURS,
      visibleAt: () => false,
    });
    expect(scans.length).toBe(13);
    expect(new Set(gaps(scans))).toEqual(new Set([MR_INBOX_HIDDEN_POLL_INTERVAL_MS]));
  });

  it("壳内一直不可见 + 定时器抖动 ±20 秒：节奏不漂（每个间隔都在 10 分钟 ±40 秒内，不会退化成 15 分钟）", () => {
    // 确定性伪抖动：-20s / +20s 交替
    const jitter = (k: number) => (k % 2 === 0 ? 20_000 : -20_000);
    const scans = simulate({
      inShell: true,
      totalMs: HOURS,
      visibleAt: () => false,
      jitterMs: jitter,
    });
    for (const g of gaps(scans)) {
      expect(Math.abs(g - MR_INBOX_HIDDEN_POLL_INTERVAL_MS)).toBeLessThanOrEqual(
        40_000,
      );
    }
    expect(scans.length).toBeGreaterThanOrEqual(12);
  });

  it("壳内一直可见：每 5 分钟扫一次（与改动前完全一致）", () => {
    const scans = simulate({
      inShell: true,
      totalMs: HOURS,
      visibleAt: () => true,
    });
    expect(scans.length).toBe(25);
    expect(new Set(gaps(scans))).toEqual(new Set([MR_INBOX_POLL_INTERVAL_MS]));
  });

  it("浏览器标签页一直不可见：只有启动那一次，之后一次都不扫（与改动前完全一致）", () => {
    const scans = simulate({
      inShell: false,
      totalMs: HOURS,
      visibleAt: () => false,
    });
    expect(scans).toEqual([0]);
  });

  it("壳内：可见 → 收进托盘 → 再打开，切换后节奏平滑衔接（不可见段 10 分钟一扫、可见后回到 5 分钟一拍）", () => {
    // 0~30 分钟可见、30~90 分钟收在托盘、90 分钟后重新可见
    const visibleAt = (t: number) => t < 30 * MIN || t >= 90 * MIN;
    const scans = simulate({ inShell: true, totalMs: 120 * MIN, visibleAt });
    const inRange = (from: number, to: number) =>
      scans.filter((t) => t >= from && t < to);
    // 可见段：0,5,...,25 每拍都扫
    expect(inRange(0, 30 * MIN)).toEqual([0, 5, 10, 15, 20, 25].map((m) => m * MIN));
    // 托盘段：从最后一次扫描（25 分）起每 10 分钟一次 → 35、45、...、85
    expect(inRange(30 * MIN, 90 * MIN)).toEqual(
      [35, 45, 55, 65, 75, 85].map((m) => m * MIN),
    );
    // 重新可见后：每拍都扫
    expect(inRange(90 * MIN, 125 * MIN)).toEqual(
      [90, 95, 100, 105, 110, 115, 120].map((m) => m * MIN),
    );
  });

  it("托盘里手动刷新会打乱相位：不论手动刷新落在哪（每 10 秒扫一遍 0~10 分钟），相邻两次扫描的间隔都不超过 10 分钟 + 半拍（12.5 分钟）", () => {
    // 手动刷新落在拍后 2.5 分钟刚过一点时最坏：下一拍距上次只有 7.4 分钟不够、再下一拍才扫 → 约 12.4 分钟
    let worst = 0;
    for (let off = 0; off <= 10 * MIN; off += 10_000) {
      const scans = simulate({
        inShell: true,
        totalMs: 3 * 60 * MIN,
        visibleAt: () => false,
        manualScanAt: 30 * MIN + off,
      });
      for (const g of gaps(scans)) worst = Math.max(worst, g);
    }
    expect(worst).toBeLessThanOrEqual(
      MR_INBOX_HIDDEN_POLL_INTERVAL_MS + MR_INBOX_POLL_INTERVAL_MS / 2,
    );
    // 并且确实会比 10 分钟长（容差生效、相位偏移是真的）——别让上面的上界因为模拟没打乱相位而空过
    expect(worst).toBeGreaterThan(MR_INBOX_HIDDEN_POLL_INTERVAL_MS);
  });
});
