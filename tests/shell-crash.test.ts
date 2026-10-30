/**
 * 壳的崩溃处置（R14 B2-4b / Q15-04 + Q15-03 的渲染 / 子进程退出）：`electron-app/shell-crash.mjs` 的纯函数
 *
 * 台账原句（Q15-04）：server 退出只收 code、被信号杀掉时就是常量 `code=?`；弹窗只有「确定」、不告诉日志在哪、
 * 也不告诉用户已经生成了崩溃取证报告；跑了几小时后一次偶发崩溃也让整个 App 退出。
 * 这里测决策与文案（弹窗 / 重启 / reload 的编排在 tests/shell-crash-wiring.test.ts，切 main.js 函数体真跑）：
 *   A. (code, signal) 的描述   B. 像不像内存不足   C. server 退出后怎么办（忽略 / 自动重启 / 弹窗）
 *   D. 崩溃弹窗的文案与按钮   E. 本次崩溃之后才生成的取证报告   F. 渲染进程退出后怎么办（刷新 / 放弃）
 *   G. 渲染 / 子进程的日志行与提示   H. 运行时长的人话
 */
import { describe, expect, it } from "vitest";

import {
  AUTO_RESTART_MIN_UPTIME_MS,
  BUTTON_OPEN_LOGS,
  BUTTON_OPEN_REPORTS,
  BUTTON_QUIT,
  BUTTON_RELOAD,
  MAX_AUTO_RESTARTS,
  RENDER_RELOAD_MAX_TOTAL,
  RENDER_RELOAD_WINDOW_MS,
  buildRenderGoneNotice,
  buildServerCrashNotice,
  decideRenderGone,
  decideServerExit,
  describeChildGone,
  describeExit,
  describeRenderGone,
  formatUptime,
  looksLikeOutOfMemory,
  pickFreshReports,
  renderReasonLabel,
} from "../electron-app/shell-crash.mjs";

describe("A. (code, signal) 的描述", () => {
  it("被信号杀掉时 code 是 null：两个都进文字（旧实现只有一个常量 `code=?`）", () => {
    expect(describeExit(null, "SIGKILL")).toBe("code=null signal=SIGKILL");
    expect(describeExit(137, null)).toBe("code=137 signal=null");
    expect(describeExit(0, null)).toBe("code=0 signal=null"); // 0 是真值，不能被 ?? 吞成 null
    expect(describeExit(undefined, undefined)).toBe("code=null signal=null");
    expect(describeExit(null, "SIGKILL")).not.toContain("?");
  });
});

describe("B. 退出方式像不像内存不足", () => {
  it("SIGKILL（OOM killer / jetsam）、SIGABRT（V8 堆耗尽走 abort）、137 / 134（128+信号号）算像", () => {
    expect(looksLikeOutOfMemory(null, "SIGKILL")).toBe(true);
    expect(looksLikeOutOfMemory(null, "SIGABRT")).toBe(true);
    expect(looksLikeOutOfMemory(137, null)).toBe(true);
    expect(looksLikeOutOfMemory(134, null)).toBe(true);
  });

  it("别的退出方式不算：普通错误码 / 正常退出 / SIGTERM / SIGSEGV / Windows 的大整数退出码（形状要在真机上量，不推断）", () => {
    expect(looksLikeOutOfMemory(1, null)).toBe(false);
    expect(looksLikeOutOfMemory(0, null)).toBe(false);
    expect(looksLikeOutOfMemory(null, "SIGTERM")).toBe(false);
    expect(looksLikeOutOfMemory(null, "SIGSEGV")).toBe(false);
    expect(looksLikeOutOfMemory(3221226505, null)).toBe(false);
    expect(looksLikeOutOfMemory(null, null)).toBe(false);
    expect(looksLikeOutOfMemory(undefined, undefined)).toBe(false);
  });
});

describe("C. server 退出后怎么办", () => {
  const base = { stale: false, quitting: false, uptimeMs: 10 * 60_000, autoRestarts: 0 };

  it("旧进程迟来的 exit（stale）或用户主动退出（quitting）：忽略——不是崩溃，哪怕跑了很久", () => {
    expect(decideServerExit({ ...base, stale: true })).toBe("ignore");
    expect(decideServerExit({ ...base, quitting: true })).toBe("ignore");
    expect(decideServerExit({ ...base, stale: true, quitting: true })).toBe("ignore");
  });

  it("稳定运行 ≥ 60s 且还没自动重启过：重启；差 1ms 不重启（启动就崩 = 配置 / 环境问题，重启只会循环）", () => {
    expect(AUTO_RESTART_MIN_UPTIME_MS).toBe(60_000);
    expect(decideServerExit({ ...base, uptimeMs: AUTO_RESTART_MIN_UPTIME_MS })).toBe("restart");
    expect(decideServerExit({ ...base, uptimeMs: AUTO_RESTART_MIN_UPTIME_MS - 1 })).toBe("prompt");
    expect(decideServerExit({ ...base, uptimeMs: 0 })).toBe("prompt");
  });

  it("整个 App 进程生命周期内只重启一次：已重启过就弹窗，哪怕又跑了很久", () => {
    expect(MAX_AUTO_RESTARTS).toBe(1);
    expect(decideServerExit({ ...base, autoRestarts: 1 })).toBe("prompt");
    expect(decideServerExit({ ...base, autoRestarts: 5 })).toBe("prompt");
  });

  it("运行时长不是有效数字（NaN / undefined / 负数）：按 0 处理、弹窗，不重启", () => {
    for (const uptimeMs of [Number.NaN, undefined, -5, Number.POSITIVE_INFINITY * 0]) {
      expect(decideServerExit({ ...base, uptimeMs: uptimeMs as number })).toBe("prompt");
    }
  });
});

describe("D. 崩溃弹窗的文案与按钮", () => {
  const crash = { code: null, signal: "SIGKILL", uptimeMs: 3 * 60_000 };

  it("正文带 (code, signal) 与已运行多久；不再出现常量 `code=?`", () => {
    const n = buildServerCrashNotice(crash);
    expect(n.title).toBe("服务异常退出");
    expect(n.message).toContain("code=null signal=SIGKILL");
    expect(n.message).toContain("已运行 3 分钟");
    expect(n.message).not.toContain("code=?");
  });

  it("按钮：「打开日志目录」「退出」；没有本次的取证报告就不出现报告按钮和报告那句话", () => {
    const n = buildServerCrashNotice(crash);
    expect(n.buttons).toEqual([BUTTON_OPEN_LOGS, BUTTON_QUIT]);
    expect(n.message).not.toContain("取证报告");
    expect(n.message).toContain("main.log");
  });

  it("本次崩溃之后生成了取证报告：多一个「打开崩溃报告目录」，正文告知", () => {
    const n = buildServerCrashNotice({ ...crash, hasFreshReports: true });
    expect(n.buttons).toEqual([BUTTON_OPEN_LOGS, BUTTON_OPEN_REPORTS, BUTTON_QUIT]);
    expect(n.message).toContain("取证报告");
  });

  it("像内存不足才提示内存（SIGKILL / SIGABRT）；普通错误码不提", () => {
    expect(buildServerCrashNotice(crash).message).toContain("内存");
    expect(buildServerCrashNotice({ ...crash, signal: "SIGABRT" }).message).toContain("内存");
    expect(buildServerCrashNotice({ code: 1, signal: null, uptimeMs: 5000 }).message).not.toContain("内存");
  });

  it("自动重启没能恢复时，正文说明「已自动重启过一次」", () => {
    expect(buildServerCrashNotice({ ...crash, restartFailed: true }).message).toContain("已自动重启过一次");
    expect(buildServerCrashNotice(crash).message).not.toContain("自动重启");
  });
});

describe("E. 本次崩溃之后才生成的取证报告", () => {
  const since = 1_000_000;
  const f = (name: string, mtimeMs: number) => ({ name, mtimeMs });

  it("只认 .json、且 mtime 不早于 server 本次启动（留 2s 吸收时间戳粒度）；旧崩溃留下的报告不算", () => {
    const files = [
      f("report.20260101.json", since - 5000), // 上一次崩溃留下的
      f("report.20260102.json", since - 2000), // 恰在容差边界
      f("report.20260103.json", since + 500),
      f("notes.txt", since + 500), // 不是 .json
    ];
    expect(pickFreshReports(files, since).map((x) => x.name)).toEqual(["report.20260102.json", "report.20260103.json"]);
  });

  it("空目录 / 脏数据（没有 name、mtime 不是数字）不抛", () => {
    expect(pickFreshReports([], since)).toEqual([]);
    expect(pickFreshReports([{ name: 123, mtimeMs: since }, { name: "a.json", mtimeMs: Number.NaN }, null] as never, since)).toEqual([]);
  });
});

describe("F. 渲染进程退出后怎么办", () => {
  const t0 = 10_000_000;

  it("崩溃 / 内存不足 / 被结束 / 异常退出：首次 → 刷新，并记下这次的时刻", () => {
    for (const reason of ["crashed", "oom", "killed", "abnormal-exit"]) {
      expect(decideRenderGone({ reason, nowMs: t0, reloadTimes: [] })).toEqual({ action: "reload", reloadTimes: [t0] });
    }
  });

  it("刚刷新过（窗口期内）又崩 → 放弃自动刷新，记录不变；恰好满窗口期算窗口外", () => {
    expect(RENDER_RELOAD_WINDOW_MS).toBe(60_000);
    expect(decideRenderGone({ reason: "crashed", nowMs: t0 + 30_000, reloadTimes: [t0] })).toEqual({
      action: "give-up",
      reloadTimes: [t0],
    });
    expect(decideRenderGone({ reason: "crashed", nowMs: t0 + RENDER_RELOAD_WINDOW_MS - 1, reloadTimes: [t0] }).action).toBe("give-up");
    expect(decideRenderGone({ reason: "crashed", nowMs: t0 + RENDER_RELOAD_WINDOW_MS, reloadTimes: [t0] })).toEqual({
      action: "reload",
      reloadTimes: [t0, t0 + RENDER_RELOAD_WINDOW_MS],
    });
  });

  it("累计刷新到上限（3 次）后不再自动刷新，哪怕每次间隔很久", () => {
    expect(RENDER_RELOAD_MAX_TOTAL).toBe(3);
    const times = [t0, t0 + 100_000, t0 + 200_000];
    expect(decideRenderGone({ reason: "crashed", nowMs: t0 + 900_000, reloadTimes: times }).action).toBe("give-up");
    expect(decideRenderGone({ reason: "crashed", nowMs: t0 + 900_000, reloadTimes: times.slice(0, 2) }).action).toBe("reload");
  });

  it("不是需要刷新的原因（clean-exit = 正常关窗 / launch-failed / integrity-failure / 未知）→ 只记日志", () => {
    for (const reason of ["clean-exit", "launch-failed", "integrity-failure", "whatever", undefined]) {
      expect(decideRenderGone({ reason: reason as string, nowMs: t0, reloadTimes: [] })).toEqual({ action: "log-only", reloadTimes: [] });
    }
  });

  it("不修改传入的数组（不可变）", () => {
    const times = [t0];
    decideRenderGone({ reason: "crashed", nowMs: t0 + 1_000_000, reloadTimes: times });
    expect(times).toEqual([t0]);
  });
});

describe("G. 渲染 / 子进程的日志行与提示", () => {
  it("render-process-gone 日志带 reason 与 exitCode；details 缺字段不抛", () => {
    expect(describeRenderGone({ reason: "oom", exitCode: 9 })).toBe("[main] render-process-gone reason=oom exitCode=9");
    expect(describeRenderGone({ reason: "crashed" })).toContain("exitCode=null");
    expect(() => describeRenderGone(undefined)).not.toThrow();
    expect(describeRenderGone(undefined)).toContain("reason=unknown");
  });

  it("child-process-gone 日志带 type / reason / exitCode，有 name / serviceName 时一并带上", () => {
    expect(describeChildGone({ type: "GPU", reason: "crashed", exitCode: 139 })).toBe(
      "[main] child-process-gone type=GPU reason=crashed exitCode=139",
    );
    expect(describeChildGone({ type: "Utility", reason: "killed", exitCode: 9, name: "network", serviceName: "network.mojom" })).toBe(
      "[main] child-process-gone type=Utility reason=killed exitCode=9 name=network service=network.mojom",
    );
    expect(() => describeChildGone(null)).not.toThrow();
  });

  it("页面反复崩溃的提示：按钮顺序「重新加载页面 / 打开日志目录 / 退出」，原因用中文", () => {
    const n = buildRenderGoneNotice({ reason: "oom" });
    expect(n.buttons).toEqual([BUTTON_RELOAD, BUTTON_OPEN_LOGS, BUTTON_QUIT]);
    expect(n.message).toContain("内存不足");
    expect(n.message).toContain("已停止自动刷新");
    // 进入这个提示有两条路：窗口期内刚刷新过又崩，或累计到上限（间隔再长也算）——所以不能说「在短时间内」（B2-4b 终审 P3-6）
    expect(n.message).not.toContain("短时间");
    expect(n.message).toContain("多次异常退出（最近一次：内存不足）");
    expect(renderReasonLabel("crashed")).toBe("崩溃");
    expect(renderReasonLabel("killed")).toBe("被结束");
    expect(renderReasonLabel("abnormal-exit")).toBe("异常退出");
    expect(renderReasonLabel("some-new-reason")).toBe("some-new-reason"); // 未知原因原样回显
    expect(renderReasonLabel(undefined)).toBe("未知原因");
  });
});

describe("H. 运行时长的人话", () => {
  it("秒 / 分钟 / 小时 + 分钟；整小时不带「0 分钟」；负数 / 非数字按 0", () => {
    expect(formatUptime(42_000)).toBe("42 秒");
    expect(formatUptime(59_400)).toBe("59 秒");
    expect(formatUptime(60_000)).toBe("1 分钟");
    expect(formatUptime(3 * 60_000)).toBe("3 分钟");
    expect(formatUptime(2 * 3_600_000)).toBe("2 小时");
    expect(formatUptime(2 * 3_600_000 + 5 * 60_000)).toBe("2 小时 5 分钟");
    expect(formatUptime(-1)).toBe("0 秒");
    expect(formatUptime(-5_000)).toBe("0 秒"); // 负值夹到 0（-1ms 四舍五入后本来就是 0，测不出）
    expect(formatUptime(3_599_000)).toBe("59 分钟");
    expect(formatUptime(3_600_000)).toBe("1 小时"); // 恰好 60 分钟进小时档，不是「60 分钟」
    expect(formatUptime(Number.NaN)).toBe("0 秒");
  });
});
