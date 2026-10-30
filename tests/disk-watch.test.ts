/**
 * 低磁盘监视的纯函数（R14 B2-4b / Q15-10 壳部分）：electron-app/disk-watch.mjs
 *   A. 阈值与分级（严格小于、边界、量不到 = unknown）
 *   B. 通知决策（24h 冷却、升级立即提醒、回升不算新事件、恢复清零、unknown 不清记录、入参不可变）
 *   C. 文案（GB / MB 换算、不出现 undefined / NaN）
 *   D. 阈值之间的关系（通知线高于更新预检线、严重线低于它）——文案「自动更新也可能被拦下」成立的前提
 * main.js 里把它们接起来的编排（量盘 / 发通知 / 30 分钟定时）在 tests/disk-watch-wiring.test.ts。
 * ⚠ 纯函数 + 假数据：没有在真实 Electron 里让盘变满、没有真的看过系统通知。
 */
import { describe, expect, it } from "vitest";

import { MIN_MAC_STAGE_FREE_MB, MIN_TEMP_FREE_MB } from "../electron-app/disk-space.mjs";
import {
  DISK_CHECK_INTERVAL_MS,
  LOW_DISK_CRITICAL_MB,
  LOW_DISK_WARN_MB,
  NOTICE_COOLDOWN_MS,
  buildLowDiskNotice,
  classifyDiskLevel,
  decideDiskNotice,
  emptyDiskNoticeState,
} from "../electron-app/disk-watch.mjs";

type Level = "ok" | "low" | "critical" | "unknown";
interface State {
  low: number | null;
  critical: number | null;
}

const H = 3_600_000;
const T0 = 1_700_000_000_000;
const decide = (level: Level, nowMs: number, state: State) => decideDiskNotice({ level, nowMs, state });

describe("A. 阈值与分级", () => {
  it("阈值：2GB 通知 / 500MB 严重 / 30 分钟量一次 / 同级别 24 小时提醒一次", () => {
    expect(LOW_DISK_WARN_MB).toBe(2048);
    expect(LOW_DISK_CRITICAL_MB).toBe(500);
    expect(DISK_CHECK_INTERVAL_MS).toBe(30 * 60_000);
    expect(NOTICE_COOLDOWN_MS).toBe(24 * H);
  });

  it.each([
    [0, "critical"],
    [499, "critical"],
    [500, "low"],
    [2047, "low"],
    [2048, "ok"],
    [1_000_000, "ok"],
  ])("剩 %i MB → %s（严格小于才算：恰好 500 还是 low、恰好 2048 还是 ok）", (mb, level) => {
    expect(classifyDiskLevel(mb)).toBe(level);
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, "100"])(
    "量不到 / 非法值 %s → unknown（不当成 0、也不当成无限大）",
    (v) => {
      expect(classifyDiskLevel(v as number | null | undefined)).toBe("unknown");
    },
  );
});

describe("B. 通知决策", () => {
  it("ok：不通知，并清零记录（下次再低重新提醒）", () => {
    const r = decide("ok", T0, { low: T0 - H, critical: T0 - 2 * H });
    expect(r.notify).toBe(false);
    expect(r.state).toEqual(emptyDiskNoticeState());
  });

  it("unknown：不通知，记录原样（同一个对象，不是清零）", () => {
    const state: State = { low: T0 - H, critical: null };
    const r = decide("unknown", T0, state);
    expect(r.notify).toBe(false);
    expect(r.state).toBe(state);
  });

  it("low 首次：通知并记下时刻（只记 low，不动 critical）", () => {
    const r = decide("low", T0, emptyDiskNoticeState());
    expect(r.notify).toBe(true);
    expect(r.state).toEqual({ low: T0, critical: null });
  });

  it("low：24 小时内不重复；恰好满 24 小时起再提醒", () => {
    const s0: State = { low: T0, critical: null };
    expect(decide("low", T0 + 30 * 60_000, s0).notify).toBe(false);
    expect(decide("low", T0 + 24 * H - 1, s0).notify).toBe(false);
    const again = decide("low", T0 + 24 * H, s0);
    expect(again.notify).toBe(true);
    expect(again.state.low).toBe(T0 + 24 * H);
  });

  it("critical 首次：通知并记下时刻", () => {
    const r = decide("critical", T0, emptyDiskNoticeState());
    expect(r.notify).toBe(true);
    expect(r.state).toEqual({ low: null, critical: T0 });
  });

  it("low → critical：恶化到严重立刻再提醒一次（不受 low 的冷却限制），两个时刻都保留", () => {
    const r = decide("critical", T0 + 30 * 60_000, { low: T0, critical: null });
    expect(r.notify).toBe(true);
    expect(r.state).toEqual({ low: T0, critical: T0 + 30 * 60_000 });
  });

  it("critical：24 小时内不重复；满 24 小时起再提醒", () => {
    const s0: State = { low: null, critical: T0 };
    expect(decide("critical", T0 + 12 * H, s0).notify).toBe(false);
    expect(decide("critical", T0 + 24 * H - 1, s0).notify).toBe(false);
    expect(decide("critical", T0 + 24 * H, s0).notify).toBe(true);
  });

  it("critical 刚提醒过、空间回升到 low：不算新事件，不再提醒", () => {
    const s0: State = { low: null, critical: T0 };
    expect(decide("low", T0 + H, s0).notify).toBe(false);
  });

  it("critical 的提醒已超过 24 小时、此时是 low：可以再提醒 low", () => {
    const s0: State = { low: null, critical: T0 };
    expect(decide("low", T0 + 24 * H, s0).notify).toBe(true);
  });

  it("恢复到 ok 后再变低：重新提醒（清零生效，不用等满 24 小时）", () => {
    let state: State = emptyDiskNoticeState();
    const first = decide("low", T0, state);
    expect(first.notify).toBe(true);
    state = first.state;
    state = decide("ok", T0 + H, state).state;
    const second = decide("low", T0 + 2 * H, state);
    expect(second.notify).toBe(true);
  });

  it("夹一次 unknown（statfs 偶发失败）不会清掉记录、不会造成重复提醒", () => {
    let state: State = emptyDiskNoticeState();
    state = decide("low", T0, state).state;
    state = decide("unknown", T0 + 30 * 60_000, state).state;
    expect(decide("low", T0 + 60 * 60_000, state).notify).toBe(false);
  });

  it("不修改传入的 state（冻结的对象也不抛）", () => {
    const frozen = Object.freeze({ low: null, critical: null }) as State;
    expect(() => decide("critical", T0, frozen)).not.toThrow();
    expect(frozen).toEqual({ low: null, critical: null });
  });
});

describe("C. 文案", () => {
  it("偏低：标题 / 正文带剩余空间（≥ 1GB 用 GB 一位小数）", () => {
    const n = buildLowDiskNotice({ level: "low", freeMB: 1536 });
    expect(n.title).toBe("磁盘空间偏低");
    expect(n.body).toContain("只剩约 1.5 GB");
    expect(n.body).toContain("建议先清理");
  });

  it("严重：标题 / 正文带剩余空间（< 1GB 用 MB），点明后果与动作", () => {
    const n = buildLowDiskNotice({ level: "critical", freeMB: 300 });
    expect(n.title).toBe("磁盘空间严重不足");
    expect(n.body).toContain("只剩约 300 MB");
    expect(n.body).toContain("保存不了");
    expect(n.body).toContain("自动更新也可能被拦下");
    expect(n.body).toContain("请尽快清理磁盘");
  });

  it("GB / MB 的边界：1023 MB 还是 MB，1024 MB 起是「1.0 GB」", () => {
    expect(buildLowDiskNotice({ level: "low", freeMB: 1023 }).body).toContain("约 1023 MB");
    expect(buildLowDiskNotice({ level: "low", freeMB: 1024 }).body).toContain("约 1.0 GB");
  });

  it("文案里不出现 undefined / NaN", () => {
    for (const level of ["low", "critical"] as const) {
      const n = buildLowDiskNotice({ level, freeMB: 100 });
      expect(`${n.title}${n.body}`).not.toMatch(/undefined|NaN|\[object/);
    }
  });
});

describe("D. 阈值之间的关系", () => {
  it("通知线高于两个更新预检线（提醒赶在更新被拦之前）、严重线低于它们（「自动更新也可能被拦下」才成立）", () => {
    expect(LOW_DISK_WARN_MB).toBeGreaterThan(MIN_TEMP_FREE_MB);
    expect(LOW_DISK_WARN_MB).toBeGreaterThan(MIN_MAC_STAGE_FREE_MB);
    expect(LOW_DISK_CRITICAL_MB).toBeLessThan(MIN_TEMP_FREE_MB);
    expect(LOW_DISK_CRITICAL_MB).toBeLessThan(MIN_MAC_STAGE_FREE_MB);
    expect(LOW_DISK_CRITICAL_MB).toBeLessThan(LOW_DISK_WARN_MB);
  });
});
