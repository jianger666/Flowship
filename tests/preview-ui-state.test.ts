/**
 * 预览控件（2026-11-12 重做：6 个小图标 → 一个状态胶囊 + 菜单 + 日志弹窗）
 *
 * ① 纯逻辑（lib/preview-ui-state）：状态推导 / 端口标签 / 轮询节奏 / 文案——边界值逐个钉
 * ② 组件 SSR 冒烟：各状态走对分支、关键文案与可访问名在
 *
 * 诚实声明：node 环境没有 DOM——菜单展开、弹窗开合、日志贴底滚动、点击行为都**没有**在这里验证（需要真机肉眼过）。
 * 这里只证明：每个状态渲染出对的骨架、桌面端 / 网页版走对「打开」分支、没有预览位时不会残留弹窗。
 */
import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PreviewControl } from "@/components/tasks/preview-control";
import {
  PREVIEW_LOG_TAIL_LINES,
  PREVIEW_POLL_FAST_MS,
  PREVIEW_POLL_IDLE_MS,
  PREVIEW_URL_PROBE_GRACE_MS,
  derivePreviewPhase,
  describePreviewExit,
  formatPreviewUptime,
  isPreviewAlive,
  mergePreviewSnapshot,
  previewOccupiedHint,
  previewPollInterval,
  previewPortLabel,
  previewStatusText,
} from "@/lib/preview-ui-state";
import type { PreviewSlotStatus } from "@/lib/types";

const T0 = 1_800_000_000_000;

const slot = (over: Partial<PreviewSlotStatus> = {}): PreviewSlotStatus => ({
  taskId: "t1",
  taskTitle: "任务一",
  repoPath: "/repo/a",
  workDir: "/repo/a",
  command: "yarn custom",
  startedAt: T0,
  url: null,
  exited: false,
  exitCode: null,
  logTail: [],
  ...over,
});

describe("derivePreviewPhase", () => {
  it("没有预览位 → idle", () => {
    expect(derivePreviewPhase(undefined, T0)).toBe("idle");
  });

  it("已退出优先于一切（即便还留着 url）", () => {
    expect(derivePreviewPhase(slot({ exited: true, url: "http://localhost:8000" }), T0)).toBe("exited");
  });

  it("有地址 → ready（不管跑了多久）", () => {
    expect(derivePreviewPhase(slot({ url: "http://localhost:8000" }), T0 + 10 * 60_000)).toBe("ready");
  });

  it("没地址：宽限期内 starting，边界值 = 宽限期整点起算 running", () => {
    expect(derivePreviewPhase(slot(), T0)).toBe("starting");
    expect(derivePreviewPhase(slot(), T0 + PREVIEW_URL_PROBE_GRACE_MS - 1)).toBe("starting");
    expect(derivePreviewPhase(slot(), T0 + PREVIEW_URL_PROBE_GRACE_MS)).toBe("running");
  });

  it("isPreviewAlive：starting / ready / running 算活着，idle / exited 不算", () => {
    expect(
      (["idle", "starting", "ready", "running", "exited"] as const).map((p) => isPreviewAlive(p)),
    ).toEqual([false, true, true, true, false]);
  });
});

describe("previewPortLabel", () => {
  it.each([
    ["http://localhost:8000", ":8000"],
    ["http://127.0.0.1:5173/app/#/x", ":5173"],
    ["https://0.0.0.0:3000/", ":3000"],
  ])("%s → %s", (url, expected) => {
    expect(previewPortLabel(url)).toBe(expected);
  });

  it("没有端口退回 host；没地址 / 解析不了返回 null", () => {
    expect(previewPortLabel("http://localhost/")).toBe("localhost");
    expect(previewPortLabel(null)).toBeNull();
    expect(previewPortLabel("not a url")).toBeNull();
  });
});

describe("previewPollInterval", () => {
  it("有预览在启动 / 日志弹窗开着 → 快；否则慢", () => {
    expect(previewPollInterval({ anyStarting: false })).toBe(PREVIEW_POLL_IDLE_MS);
    expect(previewPollInterval({ anyStarting: true })).toBe(PREVIEW_POLL_FAST_MS);
    expect(previewPollInterval({ anyStarting: false, logOpen: true })).toBe(PREVIEW_POLL_FAST_MS);
    expect(PREVIEW_POLL_FAST_MS).toBeLessThan(PREVIEW_POLL_IDLE_MS);
  });
});

describe("文案", () => {
  it("formatPreviewUptime 分档：刚刚 / 秒 / 分 / 时 / 时+分，时钟回拨不出负数", () => {
    expect(formatPreviewUptime(T0, T0 + 4_000)).toBe("刚刚启动");
    expect(formatPreviewUptime(T0, T0 + 5_000)).toBe("已运行 5 秒");
    expect(formatPreviewUptime(T0, T0 + 59_999)).toBe("已运行 59 秒");
    expect(formatPreviewUptime(T0, T0 + 60_000)).toBe("已运行 1 分钟");
    expect(formatPreviewUptime(T0, T0 + 59 * 60_000)).toBe("已运行 59 分钟");
    expect(formatPreviewUptime(T0, T0 + 3_600_000)).toBe("已运行 1 小时");
    expect(formatPreviewUptime(T0, T0 + 3_600_000 + 5 * 60_000)).toBe("已运行 1 小时 5 分钟");
    expect(formatPreviewUptime(T0, T0 - 10_000)).toBe("刚刚启动");
  });

  it("describePreviewExit：退出码 / 被终止 / 正常退出", () => {
    expect(describePreviewExit({ exitCode: 1 })).toBe("已退出（退出码 1）");
    expect(describePreviewExit({ exitCode: null })).toBe("已退出（被终止）");
    expect(describePreviewExit({ exitCode: 0 })).toBe("已正常退出");
  });

  it("previewStatusText：各状态一句话", () => {
    expect(previewStatusText("idle", undefined, T0)).toBe("未启动");
    expect(previewStatusText("starting", slot(), T0 + 8_000)).toContain("启动中");
    expect(previewStatusText("ready", slot({ url: "http://localhost:8000" }), T0 + 70_000)).toBe(
      "运行中 · http://localhost:8000（已运行 1 分钟）",
    );
    expect(previewStatusText("running", slot(), T0 + 90_000)).toContain("没从输出里探测到访问地址");
    expect(previewStatusText("exited", slot({ exited: true, exitCode: 2 }), T0)).toBe("已退出（退出码 2）");
  });

  it("previewOccupiedHint：只有别的任务还活着的占用才提醒", () => {
    expect(previewOccupiedHint(undefined)).toBeNull();
    expect(previewOccupiedHint({ taskTitle: "别的任务", exited: true })).toBeNull();
    expect(previewOccupiedHint({ taskTitle: "别的任务", exited: false })).toBe(
      "该仓预览正被「别的任务」占用，启动会替换它",
    );
  });
});

describe("PreviewControl SSR 冒烟", () => {
  const render = (
    over: Partial<{
      slot: PreviewSlotStatus | undefined;
      occupiedBy: PreviewSlotStatus | undefined;
      now: number;
      pending: boolean;
      browserAvailable: boolean;
    }> = {},
  ): string =>
    renderToStaticMarkup(
      createElement(PreviewControl, {
        repoName: "web-app",
        command: "yarn custom",
        slot: undefined,
        occupiedBy: undefined,
        now: T0,
        pending: false,
        browserAvailable: true,
        onStart: () => {},
        onStop: () => {},
        onOpenInBrowserPanel: () => {},
        onRefresh: () => {},
        ...over,
      }),
    );

  it("未启动：一个带字的启动钮，名字带命令和仓名，没有菜单触发器", () => {
    const html = render();
    expect(html).toContain("预览");
    expect(html).toContain('aria-label="启动预览:yarn custom（web-app）"');
    expect(html).not.toContain("预览更多操作");
    // 注意不能直接搜 "disabled"：按钮 class 里本来就有 disabled:opacity-50 之类的变体前缀
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""/);
  });

  it("未启动 + 请求进行中：启动钮禁用（防双击）", () => {
    expect(render({ pending: true })).toMatch(/<button[^>]*\sdisabled=""/);
  });

  it("启动中：显示「启动中」+ 菜单触发器；点胶囊是看日志", () => {
    const html = render({ slot: slot(), now: T0 + 3_000 });
    expect(html).toContain("启动中");
    expect(html).toContain("预览更多操作（web-app）");
    expect(html).toContain("查看预览状态与日志（启动中）（web-app）");
  });

  it("已就绪 + 桌面端：胶囊显示端口，点它进内置浏览器（button，不是外链）", () => {
    const html = render({ slot: slot({ url: "http://localhost:8000/" }), browserAvailable: true });
    expect(html).toContain(":8000");
    expect(html).toContain('aria-label="在内置浏览器打开 http://localhost:8000/（web-app）"');
    expect(html).not.toContain('href="http://localhost:8000/"');
  });

  it("已就绪 + 网页版：胶囊是新标签页外链（noopener）", () => {
    const html = render({ slot: slot({ url: "http://localhost:8000/" }), browserAvailable: false });
    expect(html).toContain(":8000");
    expect(html).toContain('href="http://localhost:8000/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("noopener");
    expect(html).not.toContain("在内置浏览器打开");
  });

  it("超过宽限期仍没地址：显示「运行中」，不再假装「启动中」", () => {
    const html = render({ slot: slot(), now: T0 + PREVIEW_URL_PROBE_GRACE_MS + 1 });
    expect(html).toContain("运行中");
    expect(html).not.toContain("启动中");
  });

  it("已退出：红字「已退出」，点胶囊看日志（排查失败原因）", () => {
    const html = render({ slot: slot({ exited: true, exitCode: 1 }) });
    expect(html).toContain("已退出");
    expect(html).toContain("text-destructive");
    expect(html).toContain("查看预览状态与日志（已退出）（web-app）");
  });

  it("预览位没了（idle）时不渲染日志弹窗骨架——不会残留一个开着的弹窗", () => {
    const html = render({ slot: undefined });
    expect(html).not.toContain("预览日志");
    expect(html).not.toContain('role="dialog"');
  });
});

describe("PreviewControl 源码契约（SSR 看不到的交互接线）", () => {
  // 菜单 / 弹窗里的条目在 SSR 里不渲染（关闭态），这里钉住接线本身，防重构时悄悄丢功能
  const src = readFileSync(
    new URL("../src/components/tasks/preview-control.tsx", import.meta.url),
    "utf8",
  );

  it("菜单条目齐全：内置浏览器 / 浏览器 / 复制地址 / 日志 / 重启 / 停止（已退出时：重新启动 / 清除状态）", () => {
    for (const label of ["在内置浏览器打开", "在浏览器中打开", "复制地址", "查看日志", '"重启" : "重新启动"', '"停止" : "清除状态"']) {
      expect(src, label).toContain(label);
    }
  });

  it("日志弹窗：可复制、可重启 / 停止，打开期间加快刷新", () => {
    expect(src).toContain("复制日志");
    // 回调走 ref、effect 只依赖 logOpen：父组件每次渲染换新回调引用时，定时器不会被清掉重建（R15-08）
    expect(src).toContain("setInterval(() => onRefreshRef.current(), PREVIEW_POLL_FAST_MS)");
    expect(src).toMatch(/\}, \[logOpen\]\);/);
    expect(src).not.toMatch(/\[logOpen, onRefresh\]/);
    expect(src).not.toContain("setInterval(onRefresh,");
  });

  it("预览位消失时在渲染期复位弹窗开关（防止下次启动无故弹出）；请求在途时的 idle 不算数（重启空窗，R15-09）", () => {
    expect(src).toMatch(/if \(phase === "idle" && logOpen && !pending\) setLogOpen\(false\)/);
  });

  it("菜单里「打开 / 复制地址」只在进程还活着时出现（已退出后 slot.url 还在、但地址已失效，R15-14）", () => {
    expect(src).toContain("const liveUrl = alive ? url : null;");
    // 菜单里三条地址相关条目都吃 liveUrl，不再吃裸的 url
    expect(src).not.toMatch(/\{url && browserAvailable &&/);
    expect(src).not.toMatch(/\{url && \(/);
    expect(src.match(/\{liveUrl &&/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("复制日志：整个放进 async 的 try 里（navigator.clipboard 可能是 undefined）、没有日志时禁用且不报「已复制」（R15-15）", () => {
    expect(src).toMatch(/const copyLog = async \(\) => \{\s*if \(logLines\.length === 0\) return;\s*try \{\s*await navigator\.clipboard\.writeText\(logLines\.join/);
    expect(src).toContain("disabled={logLines.length === 0}");
    // 不再有「同步取 navigator.clipboard、再 .then」的写法
    expect(src).not.toMatch(/void navigator\.clipboard/);
  });

  it("弹窗标题写明只有最近 N 行（server 只回这么多）", () => {
    expect(src).toContain("最近 {PREVIEW_LOG_TAIL_LINES} 行");
    expect(PREVIEW_LOG_TAIL_LINES).toBe(50);
  });

  it("组件自己不读时钟（now 由父组件随轮询传入）", () => {
    expect(src).not.toMatch(/Date\.now\(\)/);
  });
});

describe("mergePreviewSnapshot：轮询快照并进本地 slots（请求在途的仓以本地为准）", () => {
  const A = slot({ repoPath: "/repo/a", taskId: "t1" });
  const B = slot({ repoPath: "/repo/b", taskId: "t1" });
  const none = new Set<string>();

  it("没有在途请求：整表以快照为准（包括快照里没有的仓被摘掉）", () => {
    expect(mergePreviewSnapshot([A, B], [B], none)).toEqual([B]);
    expect(mergePreviewSnapshot([], [A], none)).toEqual([A]);
  });

  it("返回的是新数组，不是快照引用（避免后续就地修改污染）", () => {
    const snap = [A];
    expect(mergePreviewSnapshot([], snap, none)).not.toBe(snap);
  });

  it("重启空窗：快照里暂时没有 A，但 A 请求在途 → 保留本地的 A（胶囊不闪回「▶ 预览」）", () => {
    const merged = mergePreviewSnapshot([A, B], [B], new Set(["/repo/a"]));
    expect(merged.map((s) => s.repoPath).sort()).toEqual(["/repo/a", "/repo/b"]);
    expect(merged.find((s) => s.repoPath === "/repo/a")).toBe(A);
  });

  it("停止在途：快照里还带着 A（在途轮询回来的旧数据）→ 以本地为准，不拿快照覆盖", () => {
    const localA = slot({ repoPath: "/repo/a", url: "http://localhost:1/" });
    const staleA = slot({ repoPath: "/repo/a", url: null });
    const merged = mergePreviewSnapshot([localA], [staleA], new Set(["/repo/a"]));
    expect(merged).toEqual([localA]);
    expect(merged[0]).toBe(localA);
  });

  it("在途仓本地本来就没有槽位（首次启动）：快照里关于它的说法被忽略，不凭空出现", () => {
    expect(mergePreviewSnapshot([], [A], new Set(["/repo/a"]))).toEqual([]);
  });

  it("只有在途的仓受保护：别的仓照常采信快照（含新出现的 / 被摘掉的）", () => {
    const C = slot({ repoPath: "/repo/c" });
    const merged = mergePreviewSnapshot([A, B], [C], new Set(["/repo/a"]));
    expect(merged.map((s) => s.repoPath).sort()).toEqual(["/repo/a", "/repo/c"]);
  });
});

describe("WorkspaceActions 源码契约（轮询 / 紧凑态接线）", () => {
  const src = readFileSync(new URL("../src/components/tasks/workspace-actions.tsx", import.meta.url), "utf8");

  it("onRefresh 传稳定的 refreshSlots，不是每次渲染新建的内联箭头", () => {
    expect(src).toMatch(/onRefresh=\{refreshSlots\}/);
    expect(src).not.toMatch(/onRefresh=\{\(\) =>/);
  });

  it("轮询结果走 mergePreviewSnapshot（不再整表 setSlots(await fetch…)）", () => {
    expect(src).toContain("mergePreviewSnapshot(prev, snapshot, pending)");
    expect(src).not.toMatch(/setSlots\(await fetchPreviewStatus\(\)\)/);
  });

  it("请求在途的仓有同步镜像 ref；启动 / 停止每完成一次 epoch+1，轮询响应回来发现 epoch 变了就丢弃快照", () => {
    expect(src).toContain("const pendingRef = useRef<ReadonlySet<string>>(new Set());");
    expect(src).toMatch(/const epoch = mutationEpochRef\.current;/);
    expect(src).toMatch(/if \(mutationEpochRef\.current !== epoch\) return;/);
    // start / stop 的 finally 里各加一次
    expect(src.match(/mutationEpochRef\.current \+= 1;/g)).toHaveLength(2);
  });

  it("紧凑态：compact 只收起（hidden），不换渲染树——BranchSwitcher 等不卸载", () => {
    expect(src).toContain("compact?: boolean;");
    expect(src).toMatch(/compact && \(isLiveRepo\(repoPath\) \? "gap-1 border-transparent p-0" : "hidden"\)/);
    expect(src).toMatch(/compact && !anyLive && "hidden"/);
    // 没有「紧凑态提前 return 另一棵树」
    expect(src).not.toMatch(/if \(compact\) \{[\s\S]*?return \(/);
    // BranchSwitcher / IDE / 复制按钮在紧凑态被 hidden 包着，而不是条件渲染掉
    expect(src).not.toMatch(/!compact && \(?\s*<BranchSwitcher/);
    expect(src.match(/cn\("contents", compact && "hidden"\)/g)).toHaveLength(2);
  });
});
