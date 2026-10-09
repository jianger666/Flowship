/**
 * 前端流畅度上报的服务端入口：字段白名单 + 数值裁剪 + 限频 + 体积上限。
 *
 * 前端发来的东西一律不可信（可能是旧版本 / 畸形 / 恶意）：
 * - 只落白名单字段，多余字段（哪怕是 prompt / url / ua）一律丢弃
 * - 数值裁剪到合理范围，非有限数拒绝整条
 * - 每分钟最多落 N 条，超了静默丢弃（观测不能反过来拖垮应用）
 */
import { describe, expect, it, vi } from "vitest";

import {
  MAX_UI_PERF_BODY_BYTES,
  createIngestLimiter,
  handleUiPerfPost,
  sanitizeUiPerfSample,
} from "@/lib/server/ui-perf-ingest";

const valid = () => ({
  v: 1,
  reason: "interval",
  windowMs: 30_000,
  visibleMs: 29_000,
  longTasks: { n: 3, sumMs: 700, maxMs: 400, n100: 2, n250: 1 },
  inputs: { n: 5, p50Ms: 60, maxMs: 240, n200: 1 },
  afterShowMs: 350,
  heartbeat: false,
  heapMB: 180.5,
  domNodes: 12_345,
  taskId: "t_1700000000000_abc123",
});

describe("sanitizeUiPerfSample", () => {
  it("合法样本原样通过（只含白名单字段）", () => {
    const out = sanitizeUiPerfSample(valid());
    expect(out).toEqual({
      v: 1,
      reason: "interval",
      windowMs: 30_000,
      visibleMs: 29_000,
      longTasks: { n: 3, sumMs: 700, maxMs: 400, n100: 2, n250: 1 },
      inputs: { n: 5, p50Ms: 60, maxMs: 240, n200: 1 },
      afterShowMs: 350,
      heapMB: 180.5,
      domNodes: 12_345,
      taskId: "t_1700000000000_abc123",
    });
  });

  it("多余字段（prompt / url / userAgent / 嵌套对象里的夹带）一律丢弃", () => {
    const out = sanitizeUiPerfSample({
      ...valid(),
      prompt: "TOPSECRET 用户的提问",
      url: "http://127.0.0.1:8876/tasks/xxx?token=abc",
      userAgent: "Mozilla/5.0",
      longTasks: { ...valid().longTasks, attribution: "TOPSECRET" },
      inputs: { ...valid().inputs, target: "textarea#prompt" },
    })!;
    expect(JSON.stringify(out)).not.toContain("TOPSECRET");
    expect(JSON.stringify(out)).not.toContain("127.0.0.1");
    expect(Object.keys(out).sort()).toEqual(
      [
        "afterShowMs",
        "domNodes",
        "heapMB",
        "inputs",
        "longTasks",
        "reason",
        "taskId",
        "v",
        "visibleMs",
        "windowMs",
      ].sort(),
    );
    expect(Object.keys(out.longTasks as object).sort()).toEqual(
      ["maxMs", "n", "n100", "n250", "sumMs"].sort(),
    );
    expect(Object.keys(out.inputs as object).sort()).toEqual(
      ["maxMs", "n", "n200", "p50Ms"].sort(),
    );
  });

  it("heartbeat 只在为 true 时保留", () => {
    expect(sanitizeUiPerfSample({ ...valid(), heartbeat: true })!.heartbeat).toBe(true);
    expect(sanitizeUiPerfSample({ ...valid(), heartbeat: false })!.heartbeat).toBeUndefined();
    expect(sanitizeUiPerfSample({ ...valid(), heartbeat: "yes" })!.heartbeat).toBeUndefined();
  });

  it("非对象 / 数组 / null / 字符串 / 数字 → null", () => {
    for (const bad of [null, undefined, [], "x", 1, true]) {
      expect(sanitizeUiPerfSample(bad)).toBeNull();
    }
  });

  it("必填字段缺失 / 类型错误 → null", () => {
    const base = valid();
    for (const key of ["reason", "windowMs", "visibleMs", "longTasks", "inputs"] as const) {
      const o: Record<string, unknown> = { ...base };
      delete o[key];
      expect(sanitizeUiPerfSample(o), `缺 ${key}`).toBeNull();
    }
    expect(sanitizeUiPerfSample({ ...base, reason: "whatever" })).toBeNull();
    expect(sanitizeUiPerfSample({ ...base, v: 2 })).toBeNull();
    expect(sanitizeUiPerfSample({ ...base, longTasks: "x" })).toBeNull();
    expect(sanitizeUiPerfSample({ ...base, windowMs: "30000" })).toBeNull();
  });

  it("非有限数（NaN / Infinity）→ 拒绝整条", () => {
    const base = valid();
    expect(sanitizeUiPerfSample({ ...base, windowMs: Number.NaN })).toBeNull();
    expect(
      sanitizeUiPerfSample({ ...base, longTasks: { ...base.longTasks, maxMs: Number.POSITIVE_INFINITY } }),
    ).toBeNull();
  });

  it("数值裁剪：负数 → 0；超大值 → 上限", () => {
    const out = sanitizeUiPerfSample({
      ...valid(),
      windowMs: -5,
      visibleMs: 9e15,
      longTasks: { n: 9e9, sumMs: 9e9, maxMs: 9e9, n100: -1, n250: 0 },
      domNodes: 9e15,
      heapMB: -3,
    })!;
    expect(out.windowMs).toBe(0);
    expect(out.visibleMs).toBe(86_400_000);
    const lt = out.longTasks as Record<string, number>;
    expect(lt.n).toBe(1_000_000);
    expect(lt.sumMs).toBe(3_600_000);
    expect(lt.maxMs).toBe(3_600_000);
    expect(lt.n100).toBe(0);
    expect(out.domNodes).toBe(100_000_000);
    expect(out.heapMB).toBe(0);
  });

  it("可选字段类型错误只是省略，不拒绝整条", () => {
    const out = sanitizeUiPerfSample({ ...valid(), afterShowMs: "x", heapMB: null, domNodes: {} })!;
    expect(out.afterShowMs).toBeUndefined();
    expect(out.heapMB).toBeUndefined();
    expect(out.domNodes).toBeUndefined();
  });

  it("taskId 格式不合法（路径穿越 / 超长 / 含空格）→ 省略该字段而不是拒绝整条", () => {
    for (const bad of ["../../etc/passwd", "a".repeat(65), "a b", "", 123]) {
      const out = sanitizeUiPerfSample({ ...valid(), taskId: bad })!;
      expect(out.taskId, String(bad)).toBeUndefined();
      expect(out.reason).toBe("interval");
    }
  });

  it("四种 reason 都接受", () => {
    for (const reason of ["interval", "hidden", "pagehide", "switch"]) {
      expect(sanitizeUiPerfSample({ ...valid(), reason })?.reason).toBe(reason);
    }
  });
});

describe("createIngestLimiter", () => {
  it("窗口内前 max 条放行，之后拒绝；窗口过后恢复", () => {
    const lim = createIngestLimiter({ max: 3, windowMs: 60_000 });
    expect([lim.allow(0), lim.allow(1000), lim.allow(2000)]).toEqual([true, true, true]);
    expect(lim.allow(3000)).toBe(false);
    expect(lim.allow(59_999)).toBe(false);
    expect(lim.allow(60_001)).toBe(true);
  });

  it("被拒绝的请求不占名额、不推迟窗口", () => {
    const lim = createIngestLimiter({ max: 1, windowMs: 1000 });
    expect(lim.allow(0)).toBe(true);
    for (let t = 1; t < 1000; t += 100) expect(lim.allow(t)).toBe(false);
    expect(lim.allow(1000)).toBe(true);
  });
});

describe("handleUiPerfPost", () => {
  const mkDeps = () => {
    const record = vi.fn();
    return {
      deps: {
        now: () => 1_000,
        limiter: createIngestLimiter({ max: 20, windowMs: 60_000 }),
        record,
        env: { FLOWSHIP_APP_VERSION: "1.9.28", FLOWSHIP_PREVENT_APP_NAP: "1" } as Record<string, string | undefined>,
      },
      record,
    };
  };

  it("合法请求 → 204，落一条 ui-perf.jsonl，带上版本与防节流开关", () => {
    const { deps, record } = mkDeps();
    const res = handleUiPerfPost(JSON.stringify(valid()), deps);
    expect(res.status).toBe(204);
    expect(record).toHaveBeenCalledTimes(1);
    const [file, rec] = record.mock.calls[0] as [string, Record<string, unknown>];
    expect(file).toBe("ui-perf.jsonl");
    expect(rec.version).toBe("1.9.28");
    expect(rec.appNap).toBe(true);
    expect(rec.longTasks).toEqual(valid().longTasks);
  });

  it("没有版本 / 开关环境变量时不带这两个字段", () => {
    const { deps, record } = mkDeps();
    deps.env = {};
    handleUiPerfPost(JSON.stringify(valid()), deps);
    const rec = record.mock.calls[0][1] as Record<string, unknown>;
    expect(rec.version).toBeUndefined();
    expect(rec.appNap).toBeUndefined();
  });

  it("坏 JSON → 400，不落盘", () => {
    const { deps, record } = mkDeps();
    expect(handleUiPerfPost("{not json", deps).status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it("字段不合法 → 400，不落盘", () => {
    const { deps, record } = mkDeps();
    expect(handleUiPerfPost(JSON.stringify({ hello: "world" }), deps).status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it("超过体积上限 → 413，不落盘", () => {
    const { deps, record } = mkDeps();
    const big = JSON.stringify({ ...valid(), pad: "x".repeat(MAX_UI_PERF_BODY_BYTES) });
    expect(handleUiPerfPost(big, deps).status).toBe(413);
    expect(record).not.toHaveBeenCalled();
  });

  it("超限频 → 静默 204（不让前端重试），不落盘", () => {
    const { deps, record } = mkDeps();
    deps.limiter = createIngestLimiter({ max: 2, windowMs: 60_000 });
    expect(handleUiPerfPost(JSON.stringify(valid()), deps).status).toBe(204);
    expect(handleUiPerfPost(JSON.stringify(valid()), deps).status).toBe(204);
    expect(handleUiPerfPost(JSON.stringify(valid()), deps).status).toBe(204);
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("record 抛错也不外泄（观测不能拖垮请求）", () => {
    const { deps, record } = mkDeps();
    record.mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(handleUiPerfPost(JSON.stringify(valid()), deps).status).toBe(204);
  });
});

describe("highlight：流式代码块限频高亮统计", () => {
  const hl = () => ({
    requests: 120,
    passthrough: 4,
    cacheHits: 2,
    submitted: 14,
    throttled: 100,
    flushed: 12,
    forks: 1,
    costSumMs: 640,
    costMaxMs: 89,
    costCount: 14,
    slots: 2,
  });

  it("白名单通过，原样落盘", () => {
    const out = sanitizeUiPerfSample({ ...valid(), highlight: hl() })!;
    expect(out.highlight).toEqual(hl());
  });

  it("旧版本前端不带该字段：样本照常通过、没有 highlight", () => {
    const out = sanitizeUiPerfSample(valid())!;
    expect(out).not.toBeNull();
    expect("highlight" in out).toBe(false);
  });

  it("多余字段（含夹带的文本）一律丢弃", () => {
    const out = sanitizeUiPerfSample({
      ...valid(),
      highlight: { ...hl(), code: "const SECRET = 1", language: "ts", extra: { a: 1 } },
    })!;
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(Object.keys(out.highlight as object).sort()).toEqual(Object.keys(hl()).sort());
  });

  it("highlight 不是对象 / requests 非法：省略 highlight，但不拒绝整条样本", () => {
    for (const bad of [null, "x", 5, [], { requests: "120" }, { requests: Number.NaN }, { submitted: 3 }]) {
      const out = sanitizeUiPerfSample({ ...valid(), highlight: bad });
      expect(out).not.toBeNull();
      expect(out!.highlight).toBeUndefined();
    }
  });

  it("单个字段非法只省略该字段，其余保留", () => {
    const out = sanitizeUiPerfSample({
      ...valid(),
      highlight: { ...hl(), costMaxMs: "slow", throttled: Number.NaN },
    })!;
    const h = out.highlight as Record<string, unknown>;
    expect(h.costMaxMs).toBeUndefined();
    expect(h.throttled).toBeUndefined();
    expect(h.requests).toBe(120);
    expect(h.submitted).toBe(14);
  });

  it("数值裁剪到上限 / 下限", () => {
    const out = sanitizeUiPerfSample({
      ...valid(),
      highlight: { ...hl(), requests: 9e12, costSumMs: 9e15, submitted: -5 },
    })!;
    const h = out.highlight as Record<string, number>;
    expect(h.requests).toBe(1_000_000);
    expect(h.costSumMs).toBe(3_600_000);
    expect(h.submitted).toBe(0);
  });

  it("极端值的完整样本仍远小于体积上限（不会因此被 413）", () => {
    const worst = {
      ...valid(),
      highlight: Object.fromEntries(Object.keys(hl()).map((k) => [k, 999_999_999])),
    };
    expect(JSON.stringify(worst).length).toBeLessThan(MAX_UI_PERF_BODY_BYTES / 2);
  });

  it("端到端：经 handleUiPerfPost 落盘时带着 highlight", () => {
    const record = vi.fn();
    const deps = {
      now: () => 1_000,
      limiter: createIngestLimiter({ max: 20, windowMs: 60_000 }),
      record,
      env: {} as Record<string, string | undefined>,
    };
    expect(handleUiPerfPost(JSON.stringify({ ...valid(), highlight: hl() }), deps).status).toBe(204);
    expect((record.mock.calls[0][1] as Record<string, unknown>).highlight).toEqual(hl());
  });
});
