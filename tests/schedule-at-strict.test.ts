/**
 * R14 Q20-07：定时 `at`（绝对时间）只收严格 ISO 8601——日期 / 时刻字段越界、夏令时间隙一律拒绝，
 * `at` 距现在不足 1 分钟也拒绝（与 `delay_minutes` 同口径）。
 *
 * 背景：`at` 原来直接交给 `Date.parse` 宽松解析：`2026-02-30T10:00:00` 被静默进位成 3 月 2 日、`10/25/2026 09:00`
 * 能被 V8 吃掉、`T24:00` 进位到次日零点；而回执只回显规整后的时间，模型多半不会核对，于是定时悄悄落在一个它没想要的时刻。
 * `at` 还可以比现在只晚几秒（同样的等待 `delay_minutes` 有最小 1 分钟，`at` 没有）。
 *
 * ## 回归 / 对照 约定
 * - 回归：修复前（BF）会红，钉住 bug；对照：BF / SH 两边都绿，钉住没被改坏的老行为。
 * - `parseScheduleAtDetailed` 是这次新增的导出，BF 里没有：一律用动态方式取，取不到时让**断言**失败
 *   （而不是整个文件加载崩溃）。所以 `parseScheduleAtDetailed` 的整组用例在 BF 里都红（= 回归：新导出缺失）。
 * - 精细的「回归 / 对照」靠 `parseScheduleAt`（BF 里就有）逐行区分。表里的 `bf` 列 = 修复前 `parseScheduleAt`（`Date.parse`
 *   宽松解析）对这一行的**实际**返回（Node 22 / V8 上逐行实测）：返回数字 = 坏输入被静默纠正成了某个时刻 → 回归；
 *   已经返回 null = 老代码本来就拒 → 对照。这一列只用于说明与用例命名、不参与断言（V8 行为变了它可能过时，但不会让测试误红）。
 *
 * ## 时区
 * 本机时区不固定（`tests/setup/hermetic-env.ts` 与 vitest 配置都没钉 `TZ`）。不带时区的期望值一律用
 * `new Date(y, m, d, …)`（本机时区）现算，带时区的用 `Date.UTC`，不硬编码毫秒——换个时区的机器也不会红。
 * 夏令时用例在进程内把 `process.env.TZ` 临时改成 `America/New_York` / `Asia/Shanghai`（Node 里运行时改 TZ 立即生效），
 * 另有两个「间隙只改分钟 / 只改日」的时区：`Australia/Lord_Howe`（夏令时只差 30 分钟）、`Pacific/Apia`（2011-12-30 整天被跳过）。
 * 每个用例前保存、`afterEach` 对称还原（原来没设就 `delete`），并在切换后当场验证「真的生效了」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SCHEDULE_MIN_INTERVAL_MINUTES,
  parseScheduleAt,
  validateScheduleCreate,
  type ParseScheduleAtResult,
} from "@/lib/schedule";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type AtFailReason = "format" | "date" | "dst";
type Bf = "回归" | "对照";
type DetailedFn = (raw: string) => ParseScheduleAtResult;

const MIN = 60_000;

/** 本机时区的一个时刻（月份从 1 起，避开 `new Date(y, 9, …)` 里 9 = 10 月的坑） */
const local = (y: number, mo: number, d: number, h: number, mi: number, s = 0, ms = 0): number =>
  new Date(y, mo - 1, d, h, mi, s, ms).getTime();
/** UTC 时刻（月份从 1 起） */
const utc = (y: number, mo: number, d: number, h: number, mi: number, s = 0, ms = 0): number =>
  Date.UTC(y, mo - 1, d, h, mi, s, ms);

/** 用例名里要看得出前后空白 / 空串：统一用 JSON 形式显示输入 */
const q = (input: string): string => JSON.stringify(input);

/**
 * 动态取新导出 `parseScheduleAtDetailed`：BF（修复前）里没有它，静态 import 会让整个文件加载就崩，
 * 看不出是「哪个用例钉住了 bug」。这里取不到就让断言失败。
 */
const loadDetailed = async (): Promise<DetailedFn> => {
  const mod = (await import("@/lib/schedule")) as Record<string, unknown>;
  const fn = mod.parseScheduleAtDetailed;
  expect(fn, "schedule.ts 应导出 parseScheduleAtDetailed（BF 里没有它 = 回归）").toBeTypeOf("function");
  return fn as DetailedFn;
};

// ----------------- 表：每行 = 输入 / 期望（ok + ms，或 ok:false + reason） -----------------

interface PassRow {
  input: string;
  /** 期望的毫秒时间戳（带时区的用 UTC 算，不带时区的用本机时区算） */
  ms: number;
  why: string;
}

/** 通过：`ok:true` 且 `ms` 等于期望。修复前 `Date.parse` 对这些也都接受 → `parseScheduleAt` 版是对照 */
const PASS_ROWS: readonly PassRow[] = [
  { input: "2026-10-25T09:00:00+08:00", ms: utc(2026, 10, 25, 1, 0), why: "带 +08:00 偏移：按偏移换算（= 01:00Z）" },
  { input: "2026-10-25T01:00:00Z", ms: utc(2026, 10, 25, 1, 0), why: "Z = UTC，与上一行是同一时刻" },
  { input: "2026-10-25 09:00", ms: local(2026, 10, 25, 9, 0), why: "空格分隔 + 缺秒 + 不带时区 → 本机时区" },
  { input: "2026-10-25T09:00", ms: local(2026, 10, 25, 9, 0), why: "缺秒 + 不带时区 → 本机时区" },
  { input: "2026-10-25T09:00:00.500Z", ms: utc(2026, 10, 25, 9, 0, 0, 500), why: "带毫秒" },
  { input: "2028-02-29T10:00", ms: local(2028, 2, 29, 10, 0), why: "闰年的 2 月 29 日是真实存在的日子" },
  { input: "2000-02-29T10:00", ms: local(2000, 2, 29, 10, 0), why: "（额外）世纪闰年：能被 400 整除的 2000 年有 2 月 29 日" },
  { input: "2026-12-31T23:59:59", ms: local(2026, 12, 31, 23, 59, 59), why: "一天里的最后一秒（23:59:59 不是越界）" },
  { input: "  2026-10-25T09:00  ", ms: local(2026, 10, 25, 9, 0), why: "前后空白会被 trim" },
  {
    input: "2026-10-25T09:00:00+0800",
    ms: utc(2026, 10, 25, 1, 0),
    why: "无冒号的偏移：实测 V8 的 Date.parse 接受它、解析器的正则也放行 ±hhmm，按实际行为断言（若以后改成只收 ±hh:mm，这一行要跟着改）",
  },
  { input: "2026-10-25T09:00:00-05:30", ms: utc(2026, 10, 25, 14, 30), why: "（额外）负的半小时偏移" },
];

interface FailRow {
  input: string;
  reason: AtFailReason;
  /** 修复前 `parseScheduleAt` 的实际结果归类：数字 = 回归；null = 对照 */
  bf: Bf;
  why: string;
}

/** `reason: "format"`：不是严格 ISO 写法（含只有日期 / 空串 / 自然语言） */
const FORMAT_ROWS: readonly FailRow[] = [
  { input: "10/25/2026 09:00", reason: "format", bf: "回归", why: "美式斜杠日期：V8 宽松解析能吃，改前被当成本机 10-25 09:00" },
  { input: "Oct 25 2026 9:00", reason: "format", bf: "回归", why: "英文月份写法：同上" },
  { input: "2026-10-25", reason: "format", bf: "对照", why: "只有日期（会被当成 UTC 零点）：改前已被 DATE_ONLY_RE 挡掉" },
  { input: "2026-10", reason: "format", bf: "对照", why: "只有年月：同上" },
  { input: "2026", reason: "format", bf: "对照", why: "只有年：同上" },
  { input: "", reason: "format", bf: "对照", why: "空串" },
  { input: "   ", reason: "format", bf: "对照", why: "全空白" },
  { input: "not a date", reason: "format", bf: "对照", why: "乱写：V8 本来就解析不了" },
  { input: "tomorrow 9am", reason: "format", bf: "对照", why: "自然语言：V8 本来就解析不了" },
  { input: "2026-10-25T09", reason: "format", bf: "对照", why: "没有分钟：V8 不接受" },
  { input: "2026-10-25T9:00", reason: "format", bf: "对照", why: "单位数小时：V8 不接受" },
  { input: "2026-10-25T09:00:00 +08:00", reason: "format", bf: "对照", why: "时区前多一个空格：V8 不接受" },
];

/** `reason: "date"`：是 ISO 写法，但日期 / 时刻字段不存在（改前 `Date.parse` 会静默进位成另一个时刻） */
const DATE_ROWS: readonly FailRow[] = [
  { input: "2026-02-30T10:00:00", reason: "date", bf: "回归", why: "2 月没有 30 日：改前被静默进位成 3 月 2 日 10:00" },
  { input: "2026-13-01T10:00", reason: "date", bf: "对照", why: "13 月：V8 本来就返回 NaN" },
  { input: "2026-00-10T10:00", reason: "date", bf: "对照", why: "0 月：V8 本来就返回 NaN" },
  { input: "2026-10-25T24:00:00", reason: "date", bf: "回归", why: "24:00:00：ES 允许它表示次日零点，改前被进位成 10-26 00:00" },
  { input: "2026-10-25T10:60", reason: "date", bf: "对照", why: "60 分：V8 本来就返回 NaN" },
  { input: "2026-10-25T10:00:60", reason: "date", bf: "对照", why: "60 秒：V8 本来就返回 NaN" },
  { input: "2026-04-31T10:00", reason: "date", bf: "回归", why: "4 月只有 30 天：改前进位成 5 月 1 日" },
  { input: "2027-02-29T10:00", reason: "date", bf: "回归", why: "2027 不是闰年：改前进位成 3 月 1 日" },
  { input: "2100-02-29T10:00", reason: "date", bf: "回归", why: "（额外）世纪年不闰：2100 能被 100 整除、不能被 400 整除" },
  { input: "2026-02-30T10:00:00+08:00", reason: "date", bf: "回归", why: "（额外）带显式时区的越界日期也一样被进位，不能因为带了时区就放过" },
  { input: "2026-10-00T10:00", reason: "date", bf: "对照", why: "（额外）0 日：V8 本来就返回 NaN" },
  { input: "2026-10-32T10:00", reason: "date", bf: "对照", why: "（额外）32 日：V8 本来就返回 NaN" },
  { input: "2026-10-25T24:00", reason: "date", bf: "回归", why: "（额外）缺秒的 24:00：同 24:00:00，改前进位成次日零点" },
];

// ----------------- parseScheduleAtDetailed（新导出：BF 里没有 → 整组回归） -----------------

describe("parseScheduleAtDetailed（新导出：BF 里没有它，整组在 BF 里都红 = 回归）", () => {
  it("[回归] schedule.ts 导出了 parseScheduleAtDetailed", async () => {
    await loadDetailed();
  });

  describe("通过：ok:true，且 ms 等于期望", () => {
    for (const row of PASS_ROWS) {
      it(`${q(row.input)}  ${row.why}`, async () => {
        const parse = await loadDetailed();
        expect(parse(row.input)).toEqual({ ok: true, ms: row.ms });
      });
    }
  });

  describe('reason:"format"：不是严格 ISO 8601 写法', () => {
    for (const row of FORMAT_ROWS) {
      it(`${q(row.input)}  ${row.why}`, async () => {
        const parse = await loadDetailed();
        expect(parse(row.input)).toEqual({ ok: false, reason: "format" });
      });
    }
  });

  describe('reason:"date"：日期 / 时刻字段不存在，不再被静默进位', () => {
    for (const row of DATE_ROWS) {
      it(`${q(row.input)}  ${row.why}`, async () => {
        const parse = await loadDetailed();
        expect(parse(row.input)).toEqual({ ok: false, reason: "date" });
      });
    }
  });
});

// ----------------- parseScheduleAt（只要结果版：BF 里就有，逐行区分回归 / 对照） -----------------

describe("parseScheduleAt（只要结果版：同一批输入；BF 里逐行实测，数字 = 被静默纠正 = 回归，null = 对照）", () => {
  describe("[对照] 严格 ISO 的通过行：两边都返回同一个 ms", () => {
    for (const row of PASS_ROWS) {
      it(`${q(row.input)}  ${row.why}`, () => {
        expect(parseScheduleAt(row.input)).toBe(row.ms);
      });
    }
  });

  describe("format / date 失败行：一律 null（用例名前缀 = 该行在 BF 里的实际归类）", () => {
    for (const row of [...FORMAT_ROWS, ...DATE_ROWS]) {
      it(`[${row.bf}] ${q(row.input)}  ${row.why}`, () => {
        expect(parseScheduleAt(row.input)).toBeNull();
      });
    }
  });
});

// ----------------- 夏令时间隙（进程内临时改 TZ） -----------------

interface TzRow {
  input: string;
  /** `ok` = 本机时区里存在这个时刻；`dst` = 夏令时跳过了它 */
  outcome: "ok" | "dst";
  /** outcome 为 ok 时的期望毫秒（用 UTC 算，与本机时区无关：TZ 已被钉成纽约） */
  ms?: number;
  bf: Bf;
  why: string;
}

/** 美东 2026-03-08 02:00 → 03:00 是春季间隙（02:00–02:59:59 不存在）；EST = UTC-5，EDT = UTC-4 */
const NY_ROWS: readonly TzRow[] = [
  { input: "2026-03-08T01:59:00", outcome: "ok", ms: utc(2026, 3, 8, 6, 59), bf: "对照", why: "间隙前（EST，= 06:59Z）" },
  { input: "2026-03-08T01:59:59", outcome: "ok", ms: utc(2026, 3, 8, 6, 59, 59), bf: "对照", why: "（额外）间隙前最后一秒" },
  { input: "2026-03-08T02:00:00", outcome: "dst", bf: "回归", why: "（额外）间隙起点：不存在，改前被静默推到 03:00" },
  { input: "2026-03-08T02:30:00", outcome: "dst", bf: "回归", why: "间隙正中：不存在，改前被静默推到 03:30" },
  { input: "2026-03-08 02:30", outcome: "dst", bf: "回归", why: "（额外）空格分隔 + 缺秒的写法也一样" },
  { input: "2026-03-08T02:59:59", outcome: "dst", bf: "回归", why: "（额外）间隙最后一秒" },
  { input: "2026-03-08T03:00:00", outcome: "ok", ms: utc(2026, 3, 8, 7, 0), bf: "对照", why: "间隙结束（EDT，= 07:00Z）" },
  {
    input: "2026-03-08T02:30:00-05:00",
    outcome: "ok",
    ms: utc(2026, 3, 8, 7, 30),
    bf: "对照",
    why: "带显式时区：不做本机间隙检查（= 07:30Z）",
  },
];

describe("夏令时间隙（进程内临时改 process.env.TZ，用例后对称还原）", () => {
  let savedTz: string | undefined;
  beforeEach(() => {
    savedTz = process.env.TZ;
  });
  afterEach(() => {
    // 原来没设就 delete：赋 undefined 会变成字符串 "undefined"
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  /**
   * 切时区，并当场验证「运行时改 TZ 真的生效」：探测一个**不在间隙里**的正午，看 `getTimezoneOffset()`
   * （JS 里 = UTC - 本地，所以 UTC+8 是 -480）：
   * - 美东 2026-03-08 12:00 已是夏令时（UTC-4 → 240）；上海恒为 UTC+8（-480）；
   * - Lord_Howe 2026-10-04 12:00 已是夏令时（UTC+11 → -660，标准时间是 UTC+10:30）；
   * - Apia 2011-12-31 12:00 是跳日之后的夏令时（UTC+14 → -840）。
   */
  const TZ_PROBES = {
    "America/New_York": { probe: [2026, 2, 8, 12, 0], offset: 240 },
    "Asia/Shanghai": { probe: [2026, 2, 8, 12, 0], offset: -480 },
    "Australia/Lord_Howe": { probe: [2026, 9, 4, 12, 0], offset: -660 },
    "Pacific/Apia": { probe: [2011, 11, 31, 12, 0], offset: -840 },
  } as const;
  const useTz = (tz: keyof typeof TZ_PROBES): void => {
    process.env.TZ = tz;
    const [y, mo, d, h, mi] = TZ_PROBES[tz].probe;
    expect(new Date(y, mo, d, h, mi).getTimezoneOffset(), `运行时改 TZ=${tz} 没有生效`).toBe(TZ_PROBES[tz].offset);
  };

  describe("parseScheduleAtDetailed（TZ = America/New_York）", () => {
    for (const row of NY_ROWS) {
      it(`${q(row.input)}  ${row.why}`, async () => {
        useTz("America/New_York");
        const parse = await loadDetailed();
        expect(parse(row.input)).toEqual(
          row.outcome === "ok" ? { ok: true, ms: row.ms } : { ok: false, reason: "dst" },
        );
      });
    }

    it("秋季回拨 2026-11-01T01:30:00（这个本机时刻出现两次）→ 歧义不拒绝：ok:true，回读本地时间仍是 01:30（取哪一次是实现细节，不钉毫秒）", async () => {
      useTz("America/New_York");
      const parse = await loadDetailed();
      const r = parse("2026-11-01T01:30:00");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const back = new Date(r.ms);
      expect([back.getFullYear(), back.getMonth() + 1, back.getDate(), back.getHours(), back.getMinutes()]).toEqual([
        2026, 11, 1, 1, 30,
      ]);
    });
  });

  describe("parseScheduleAt（TZ = America/New_York）：间隙行 BF 里返回数字 = 回归，其余是对照", () => {
    for (const row of NY_ROWS) {
      it(`[${row.bf}] ${q(row.input)}  ${row.why}`, () => {
        useTz("America/New_York");
        expect(parseScheduleAt(row.input)).toBe(row.outcome === "ok" ? row.ms : null);
      });
    }

    it("[对照] 秋季回拨 2026-11-01T01:30:00 → 返回数字（不被当成间隙拒绝），回读本地仍是 01:30", () => {
      useTz("America/New_York");
      const ms = parseScheduleAt("2026-11-01T01:30:00");
      expect(ms).not.toBeNull();
      const back = new Date(ms as number);
      expect([back.getMonth() + 1, back.getDate(), back.getHours(), back.getMinutes()]).toEqual([11, 1, 1, 30]);
    });
  });

  describe("Asia/Shanghai（无夏令时）：常规通过，且同一个「3 月 8 日 02:30」在这里是存在的", () => {
    it("[对照] parseScheduleAt：2026-10-25T09:00 → 通过，= 01:00Z", () => {
      useTz("Asia/Shanghai");
      expect(parseScheduleAt("2026-10-25T09:00")).toBe(utc(2026, 10, 25, 1, 0));
    });

    it("[回归] parseScheduleAtDetailed（新导出）：2026-10-25T09:00 → ok:true，= 01:00Z", async () => {
      useTz("Asia/Shanghai");
      const parse = await loadDetailed();
      expect(parse("2026-10-25T09:00")).toEqual({ ok: true, ms: utc(2026, 10, 25, 1, 0) });
    });

    it("[对照] parseScheduleAt：2026-03-08T02:30:00 → 通过（= 2026-03-07 18:30Z）：证明上面「纽约被拒」来自时区间隙，不是这个日期本身有问题", () => {
      useTz("Asia/Shanghai");
      expect(parseScheduleAt("2026-03-08T02:30:00")).toBe(utc(2026, 3, 7, 18, 30));
    });

    it("[回归] parseScheduleAtDetailed（新导出）：2026-03-08T02:30:00 → ok:true，= 2026-03-07 18:30Z（同一个输入在纽约是 dst，在上海是存在的）", async () => {
      useTz("Asia/Shanghai");
      const parse = await loadDetailed();
      expect(parse("2026-03-08T02:30:00")).toEqual({ ok: true, ms: utc(2026, 3, 7, 18, 30) });
    });
  });

  describe("间隙只推走「分钟」或只推走「日」：回读要把分钟、日也比进去（只比小时 / 月 / 年会漏）", () => {
    // 纽约的间隙一跳就是一整个小时，小时比较就够抓；下面两个时区的间隙，小时（和年月）在被推走前后完全一样：
    it("Australia/Lord_Howe（夏令时只差 30 分钟）：2026-10-04T02:15:00 落在 02:00–02:29:59 的间隙里 → reason:dst（被推到 02:45，只有分钟变）；对照 02:30:00 → ok，= 2026-10-03 15:30Z", async () => {
      useTz("Australia/Lord_Howe");
      const parse = await loadDetailed();
      expect(parse("2026-10-04T02:15:00")).toEqual({ ok: false, reason: "dst" });
      expect(parse("2026-10-04T02:30:00")).toEqual({ ok: true, ms: utc(2026, 10, 3, 15, 30) });
    });

    it("Pacific/Apia（2011-12-30 整天被跳过）：2011-12-30T10:00:00 → reason:dst（被推到 12-31 10:00，只有日变）；对照 2011-12-31T10:00:00 → ok，= 2011-12-30 20:00Z", async () => {
      useTz("Pacific/Apia");
      const parse = await loadDetailed();
      expect(parse("2011-12-30T10:00:00")).toEqual({ ok: false, reason: "dst" });
      expect(parse("2011-12-31T10:00:00")).toEqual({ ok: true, ms: utc(2011, 12, 30, 20, 0) });
    });
  });

  describe("validateScheduleCreate 层（TZ = America/New_York）", () => {
    /** 美东 2026-03-07 07:00（EST）：离 3 月 8 日的间隙不到一天，at 落在未来 7 天内 */
    const NOW_NY = utc(2026, 3, 7, 12, 0);

    it("[回归] 落在间隙里的 at → 拒绝，文案点明「夏令时」；改前被静默推到 03:30 当成功建了", () => {
      useTz("America/New_York");
      const r = validateScheduleCreate({ title: "t", message: "m", at: "2026-03-08T02:30:00" }, NOW_NY);
      expect(r.ok, "应被拒绝").toBe(false);
      if (r.ok) return;
      expect(r.error).toContain("夏令时");
      // 三种 at 失败文案各自有不同关键词：这条不能被当成「格式不对」或「日期不存在」
      expect(r.error).not.toContain("ISO 8601");
      expect(r.error).not.toContain("进位");
    });

    it("[对照] 同一时刻写成带显式时区 -05:00 → 通过，firstFireAt = 07:30Z（带时区不做本机间隙检查）", () => {
      useTz("America/New_York");
      const r = validateScheduleCreate({ title: "t", message: "m", at: "2026-03-08T02:30:00-05:00" }, NOW_NY);
      expect(r.ok, "带显式时区应通过").toBe(true);
      if (!r.ok) return;
      expect(r.value.firstFireAt).toBe(utc(2026, 3, 8, 7, 30));
    });
  });
});

// ----------------- validateScheduleCreate：at 的三种失败文案 + 最小 1 分钟 -----------------

describe("validateScheduleCreate：at 失败文案（format / date 各有各的关键词）+ 最小 1 分钟（传 now，不用真实时钟）", () => {
  const base = { title: "t", message: "m" };
  /** 固定的「现在」（本机时区 2026-10-24 12:00）：下面这些「宽松解析后落在未来」的输入，在 BF 里才会被接受 */
  const NOW = local(2026, 10, 24, 12, 0);
  const iso = (ms: number): string => new Date(ms).toISOString();

  type Args = Parameters<typeof validateScheduleCreate>[0];
  const rejected = (args: Args, now: number = NOW): string => {
    const r = validateScheduleCreate(args, now);
    expect(r.ok, `应被拒绝，实际通过了（firstFireAt=${r.ok ? r.value.firstFireAt : "-"}）`).toBe(false);
    return r.ok ? "" : r.error;
  };
  const accepted = (args: Args, now: number = NOW) => {
    const r = validateScheduleCreate(args, now);
    expect(r.ok, `应通过，实际被拒：${r.ok ? "" : r.error}`).toBe(true);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };

  describe("三种 at 失败各带不同关键词（断言用 toContain，不钉整句）", () => {
    it("[回归] format：10/25/2026 09:00 → 「不是合法的 ISO 8601 时间」；改前被 V8 吃成本机 10-25 09:00 当成功建了", () => {
      const e = rejected({ ...base, at: "10/25/2026 09:00" });
      expect(e).toContain("ISO 8601");
      expect(e).not.toContain("进位");
      expect(e).not.toContain("夏令时");
    });

    it("[回归] date：T24:00:00 → 「日期 / 时刻不存在…不会替你进位」；改前被进位成次日零点当成功建了", () => {
      const e = rejected({ ...base, at: "2026-10-25T24:00:00" });
      expect(e).toContain("进位");
      expect(e).not.toContain("ISO 8601");
      expect(e).not.toContain("夏令时");
    });

    it("[回归] date：2 月 30 日 → 同上文案；改前被进位成 3 月 2 日当成功建了", () => {
      // 单独给一个 now（本机 3 月 1 日 12:00），让改前的进位结果（3 月 2 日 10:00）落在未来 7 天内、会被 BF 接受
      const e = rejected({ ...base, at: "2026-02-30T10:00:00" }, local(2026, 3, 1, 12, 0));
      expect(e).toContain("进位");
      expect(e).not.toContain("ISO 8601");
    });

    it("[对照] format：not a date → 仍是「不是合法的 ISO 8601 时间」（老文案没被改掉）", () => {
      expect(rejected({ ...base, at: "not a date" })).toContain("ISO 8601");
    });
  });

  interface MinRow {
    name: string;
    bf: Bf;
    args: Args;
    /** 通过时期望的 firstFireAt；不给 = 期望被拒绝 */
    firstFireAt?: number;
    /** 被拒绝时期望含的关键词 */
    errorHas?: readonly string[];
  }

  const tooShort = [`最小 ${SCHEDULE_MIN_INTERVAL_MINUTES} 分钟`, "wait"] as const;
  const MIN_ROWS: readonly MinRow[] = [
    { name: "at = now + 5 秒 → 拒绝（改前被接受）", bf: "回归", args: { ...base, at: iso(NOW + 5_000) }, errorHas: [...tooShort, "at 距现在不足"] },
    { name: "at = now + 59_999ms（差 1ms 满一分钟）→ 拒绝", bf: "回归", args: { ...base, at: iso(NOW + 59_999) }, errorHas: tooShort },
    { name: "at = now + 60_000ms（恰好一分钟）→ 通过", bf: "对照", args: { ...base, at: iso(NOW + 60_000) }, firstFireAt: NOW + 60_000 },
    {
      name: "every_minutes: 10 搭配 at = now + 5 秒 → 拒绝（周期的首次时间同口径）",
      bf: "回归",
      args: { ...base, every_minutes: 10, at: iso(NOW + 5_000) },
      errorHas: tooShort,
    },
    {
      name: "every_minutes: 10 搭配 at = now + 60_000ms → 通过，首次触发 = at",
      bf: "对照",
      args: { ...base, every_minutes: 10, at: iso(NOW + 60_000) },
      firstFireAt: NOW + 60_000,
    },
    { name: "delay_minutes: 1 → 通过（既有口径）", bf: "对照", args: { ...base, delay_minutes: 1 }, firstFireAt: NOW + MIN },
    {
      name: "delay_minutes: 0.5 → 拒绝（既有口径：文案是 delay_minutes 的，不是 at 的）",
      bf: "对照",
      args: { ...base, delay_minutes: 0.5 },
      errorHas: ["delay_minutes 最小", "wait"],
    },
    { name: "at = now → 拒绝「已经过了」（先判已过去，再判不足 1 分钟）", bf: "对照", args: { ...base, at: iso(NOW) }, errorHas: ["已经过了"] },
    { name: "at = now - 1 秒 → 拒绝「已经过了」", bf: "对照", args: { ...base, at: iso(NOW - 1_000) }, errorHas: ["已经过了"] },
  ];

  describe("最小 1 分钟（与 delay_minutes 同口径）", () => {
    for (const row of MIN_ROWS) {
      it(`[${row.bf}] ${row.name}`, () => {
        if (row.firstFireAt !== undefined) {
          expect(accepted(row.args).firstFireAt).toBe(row.firstFireAt);
          return;
        }
        const e = rejected(row.args);
        for (const kw of row.errorHas ?? []) expect(e).toContain(kw);
      });
    }

    it("[回归] 「不足 1 分钟」的文案各管各的：at 的文案里没有 delay_minutes，delay_minutes 的文案里没有「at 距现在」（at 这一半改前根本不报错）", () => {
      const atErr = rejected({ ...base, at: iso(NOW + 5_000) });
      const delayErr = rejected({ ...base, delay_minutes: 0.5 });
      expect(atErr).not.toContain("delay_minutes");
      expect(delayErr).not.toContain("at 距现在");
    });
  });
});

// ----------------- 进程内改 TZ 没有泄漏 -----------------

const ORIGINAL_TZ_ENV = process.env.TZ;
const ORIGINAL_OFFSET = new Date(2026, 9, 25, 9, 0).getTimezoneOffset();

describe("进程内改 TZ 的卫生", () => {
  it("[对照] 夏令时用例全部跑完后，本机时区与 process.env.TZ 都回到进入本文件时的样子（没有泄漏给别的用例）", () => {
    expect(process.env.TZ).toBe(ORIGINAL_TZ_ENV);
    expect(new Date(2026, 9, 25, 9, 0).getTimezoneOffset()).toBe(ORIGINAL_OFFSET);
  });
});
