/**
 * 增强包 E2 · B2 browser_perf（server 工具定义）：性能录制 / 指标 / 堆快照 / 覆盖率（高级调试组，`browserAdvancedTools` 控制注册）。
 * 主进程实现在 electron-app/browser/ops/perf.mjs，纯逻辑（trace 摘要 / 堆快照解析 / 覆盖率汇总）在 electron-app/browser/perf-summary.mjs。
 *
 * # 文案分层
 * 可信行里只有固定话术与「形状受限」的数字 / 枚举；URL、函数名、构造函数名、事件类型这类来自页面 / trace 的字符串
 * 一律先脱敏再截断，放进 untrusted 块。文件路径由主进程生成，仍按形状校验（无控制字符、限长）后才展示。
 *
 * 积木从 `kit` 取（见 tools.ts 的 buildToolKit）；不要 import "./tools"（成环），类型用 `import type`。
 */
import { Boolean as TBBoolean, Enum as TBEnum, Number as TBNumber, Object as TBObject, Optional as TBOptional, String as TBString } from "typebox/type";
import type { FlowshipToolDef } from "../flowship-tools";
import { approvalAwareTimeoutMs, HEAP_SNAPSHOT_ACTION_BUDGET_MS } from "./approval-timeout";
import type { ToolResultBuilder } from "./content";
import type { BrowserToolKit } from "./tools";

export const PERF_TOOL_ACTIONS = ["start_trace", "stop_trace", "metrics", "heap_snapshot", "coverage_start", "coverage_stop"] as const;
export type PerfToolAction = (typeof PERF_TOOL_ACTIONS)[number];
/** 与主进程 perf-summary.mjs 的 TRACE_PRESET_NAMES 逐项一致（测试对账） */
export const PERF_TRACE_PRESETS = ["default", "loading", "runtime"] as const;

interface TraceSummary {
  durationMs?: number | null;
  scope?: string;
  metrics?: {
    lcpMs?: number | null;
    lcpElement?: { type?: string; nodeName?: string; size?: number } | null;
    fcpMs?: number | null;
    cls?: number;
    layoutShifts?: number;
    inpMs?: number | null;
    interactions?: number;
    ttfbMs?: number | null;
  };
  longTasks?: { count?: number; totalMs?: number; longest?: Array<{ ms?: number; atMs?: number }> };
  mainThreadBusyMs?: number;
  slowRequests?: Array<{ url?: string; ms?: number; status?: number; bytes?: number; failed?: boolean }>;
  requestsDropped?: number;
  topEvents?: Array<{ name?: string; ms?: number; count?: number }>;
  topFunctions?: Array<{ fn?: string; url?: string; line?: number; ms?: number; count?: number }>;
}

interface CoverageSummary {
  total?: number;
  used?: number;
  unused?: number;
  usedPercent?: number;
  files?: number;
  top?: Array<{ url?: string; total?: number; used?: number; unused?: number; usedPercent?: number; scripts?: number }>;
}

interface PerfResult {
  action?: string;
  tabId?: string;
  first?: boolean;
  preset?: string;
  maxSeconds?: number;
  maxMB?: number;
  file?: string;
  /** 任务目录里的子目录名（不是绝对路径；R6-02） */
  dir?: string;
  bytes?: number;
  truncated?: boolean;
  summaryDegraded?: boolean;
  summary?: (TraceSummary & HeapSummary) | null;
  summaryNote?: string;
  auto?: boolean;
  dataLoss?: boolean;
  recordedMs?: number;
  metrics?: Record<string, number>;
  js?: CoverageSummary | boolean;
  css?: CoverageSummary | boolean;
  warnings?: string[];
}

interface HeapSummary {
  nodeCount?: number;
  totalSelfSize?: number;
  top?: Array<{ name?: string; count?: number; selfSize?: number; percent?: number }>;
}

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const int = (v: unknown): number => Math.max(0, Math.round(finite(v) ?? 0));
const fmtBytes = (v: unknown): string => {
  const n = finite(v) ?? 0;
  if (n >= 1048576) return `${Math.round((n / 1048576) * 10) / 10}MB`;
  if (n >= 1024) return `${Math.round((n / 1024) * 10) / 10}KB`;
  return `${Math.round(n)}B`;
};
const fmtNum = (v: unknown): string => String(Math.round((finite(v) ?? 0) * 1000) / 1000);
const metricOrNA = (v: unknown, unit: string): string => (finite(v) === undefined || v === null ? "未采到" : `${fmtNum(v)}${unit}`);
/**
 * 文件展示名（R6-02）：只给「任务目录里的子目录名 / 主进程生成的文件名」，**绝不回显绝对路径**——
 * Flowship 的 agent 自带 shell / 读文件工具，给了路径就等于给了读整页堆 / 带令牌 URL 的入口；绝对路径只在用户可见的活动日志里。
 * 文件名形状校验（字母数字 . _ -，限长）不过就不展示；`path` 字段（旧版 / 异常主进程可能带）一律忽略。
 */
const safeFileRef = (file: unknown, dir: unknown): string | undefined => {
  if (typeof file !== "string" || !/^[\w.-]{1,120}$/.test(file)) return undefined;
  const d = typeof dir === "string" && /^[\w.-]{1,60}$/.test(dir) ? dir : "browser-traces";
  return `${d}/${file}`;
};
const COVER_UNIT: Record<string, string> = { js: "JS", css: "CSS" };

export const createPerfTools = (kit: BrowserToolKit): FlowshipToolDef[] => {
  const { run, guarded, BadArgs, argStr, argNum, argBool, argEnum, clipRedacted, getSettings } = kit;

  const renderTrace = (r: PerfResult, b: ToolResultBuilder): void => {
    const s = (r.summary ?? null) as TraceSummary | null;
    const ref = safeFileRef(r.file, r.dir);
    b.trusted(
      `性能录制已${r.auto ? "自动结束（到 60 秒上限）" : "结束"}并保存：${int(r.bytes) > 0 ? fmtBytes(r.bytes) : "未知大小"}${ref ? `，文件 ${ref}（在本任务数据目录内，标准 Chrome trace JSON，用户可在 DevTools Performance 面板打开；` : "（"}原文件含未脱敏的页面 URL，仅供用户打开，请基于摘要分析、不要读取文件内容）。` +
        (r.truncated ? "trace 超过大小上限，已在最后一个完整事件处截断（文件仍是合法 JSON，后半段没有记录）。" : "") +
        (r.dataLoss ? "浏览器报告有数据丢失（缓冲写满），后段事件可能不全。" : "") +
        (r.summaryDegraded ? "文件太大，只保存了文件，没有生成摘要。" : ""),
    );
    if (!s) return;
    const m = s.metrics ?? {};
    const lines = [
      `LCP ${metricOrNA(m.lcpMs, "ms")} | FCP ${metricOrNA(m.fcpMs, "ms")} | TTFB ${metricOrNA(m.ttfbMs, "ms")}`,
      `CLS ${fmtNum(m.cls)}（${int(m.layoutShifts)} 次布局偏移）| INP ${metricOrNA(m.inpMs, "ms")}（${int(m.interactions)} 次交互，近似）`,
    ];
    const lt = s.longTasks ?? {};
    lines.push(
      `长任务（>50ms，主线程）${int(lt.count)} 个，累计 ${fmtNum(lt.totalMs)}ms；最长：${(lt.longest ?? []).map((x) => `${fmtNum(x.ms)}ms（录制第 ${fmtNum(x.atMs)}ms）`).join("、") || "无"}`,
    );
    lines.push(`录制时长 ${metricOrNA(s.durationMs, "ms")}，主线程忙碌 ${fmtNum(s.mainThreadBusyMs)}ms${s.scope === "all" ? "（没能识别目标页面进程，统计的是所有进程）" : ""}`);
    b.trusted(`摘要（近似值：CLS 未分窗、INP 取 EventTiming、主线程耗时是 inclusive 时长）：\n${lines.join("\n")}`);
    const items: string[] = [];
    // R6-28：LCP 元素名是页面可控的（自定义元素名可以是任意字符串）——不能进受信行，放进 untrusted 块（红线 2）
    if (m.lcpElement?.nodeName) items.push(`LCP 元素（页面提供的名字）：${clipRedacted(m.lcpElement.nodeName, 40)}`);
    const reqs = s.slowRequests ?? [];
    if (reqs.length > 0) {
      items.push("最慢的请求：");
      for (const q of reqs) items.push(`- ${fmtNum(q.ms)}ms ${finite(q.status) ? `HTTP ${int(q.status)} ` : ""}${q.failed ? "失败 " : ""}${finite(q.bytes) !== undefined ? `${fmtBytes(q.bytes)} ` : ""}${clipRedacted(q.url, 300)}`);
    }
    const evs = s.topEvents ?? [];
    if (evs.length > 0) {
      items.push("主线程耗时前几名（事件类型）：");
      for (const e of evs) items.push(`- ${clipRedacted(e.name, 40)} ${fmtNum(e.ms)}ms ×${int(e.count)}`);
    }
    const fns = s.topFunctions ?? [];
    if (fns.length > 0) {
      items.push("耗时前几名的函数：");
      for (const f of fns) items.push(`- ${clipRedacted(f.fn, 80)} ${fmtNum(f.ms)}ms ×${int(f.count)}${f.url ? ` ${clipRedacted(f.url, 200)}${finite(f.line) !== undefined ? `:${int(f.line)}` : ""}` : ""}`);
    }
    if (items.length > 0) b.untrusted(items.join("\n"));
    if (int(s.requestsDropped) > 0) b.trusted(`注意：请求太多，有 ${int(s.requestsDropped)} 个请求没有计入「最慢请求」。`);
  };

  const renderMetrics = (r: PerfResult, b: ToolResultBuilder): void => {
    const m = r.metrics ?? {};
    const rows: Array<[string, string, string]> = [
      ["jsHeapUsedMB", "JS 堆已用", "MB"],
      ["jsHeapTotalMB", "JS 堆总量", "MB"],
      ["domNodes", "DOM 节点", ""],
      ["documents", "文档数", ""],
      ["frames", "frame 数", ""],
      ["jsEventListeners", "事件监听器", ""],
      ["layoutCount", "布局次数", ""],
      ["styleRecalcCount", "样式重算次数", ""],
      ["layoutDurationMs", "布局累计耗时", "ms"],
      ["styleRecalcDurationMs", "样式重算累计耗时", "ms"],
      ["scriptDurationMs", "脚本累计耗时", "ms"],
      ["taskDurationMs", "主线程任务累计耗时", "ms"],
    ];
    const lines = rows.filter(([k]) => finite(m[k]) !== undefined).map(([k, zh, unit]) => `${zh}：${fmtNum(m[k])}${unit}`);
    b.trusted(
      lines.length > 0
        ? `页面性能指标：\n${lines.join("\n")}\n${r.first ? "布局 / 脚本耗时这类累计指标从这次调用开始计数：操作页面后再调一次 metrics，得到的就是两次调用之间的值。" : "布局次数 / 耗时等累计指标是自上次 metrics 调用以来的值。"}`
        : "没有读到性能指标（页面可能刚创建或不支持 Performance 域）。",
    );
  };

  const renderHeap = (r: PerfResult, b: ToolResultBuilder): void => {
    const ref = safeFileRef(r.file, r.dir);
    b.trusted(
      `堆快照已保存：${fmtBytes(r.bytes)}${ref ? `，文件 ${ref}（在本任务数据目录内，.heapsnapshot，用户可在 DevTools Memory 面板加载；` : "（"}原文件含页面内存里的全部数据，仅供用户打开，请基于摘要分析、不要读取文件内容）。` +
        (r.summaryNote ? clipRedacted(r.summaryNote, 200) : ""),
    );
    const h = (r.summary ?? null) as HeapSummary | null;
    if (!h) return;
    b.trusted(`快照共 ${int(h.nodeCount)} 个对象，自身大小合计 ${fmtBytes(h.totalSelfSize)}。下面按构造函数汇总自身大小（self size，不含被引用对象；不是 retained size）前 ${(h.top ?? []).length} 名：`);
    b.untrusted((h.top ?? []).map((t) => `${clipRedacted(t.name, 80)} | ${int(t.count)} 个 | ${fmtBytes(t.selfSize)} | ${fmtNum(t.percent)}%`).join("\n"));
  };

  const renderCoverage = (r: PerfResult, b: ToolResultBuilder): void => {
    const head: string[] = [];
    const lists: string[] = [];
    for (const key of ["js", "css"] as const) {
      const c = r[key];
      if (!c || typeof c !== "object") continue;
      head.push(`${COVER_UNIT[key]}：共 ${fmtBytes(c.total)}（${int(c.files)} 个文件），已用 ${fmtNum(c.usedPercent)}%，未使用 ${fmtBytes(c.unused)}`);
      const top = c.top ?? [];
      if (top.length > 0) {
        lists.push(`${COVER_UNIT[key]} 最浪费的文件：`);
        for (const t of top) lists.push(`- 未使用 ${fmtBytes(t.unused)} / 共 ${fmtBytes(t.total)}（已用 ${fmtNum(t.usedPercent)}%）${clipRedacted(t.url, 300)}`);
      }
    }
    b.trusted(`覆盖率统计结束：\n${head.join("\n") || "（没有数据）"}`);
    if (lists.length > 0) b.untrusted(lists.join("\n"));
    if (Array.isArray(r.warnings) && r.warnings.length > 0) b.trusted(`提示：${r.warnings.map((w) => clipRedacted(w, 200)).join("；")}`);
  };

  const render = (r: PerfResult, b: ToolResultBuilder): void => {
    switch (r?.action) {
      case "start_trace":
        b.trusted(
          `已开始性能录制（预设 ${(PERF_TRACE_PRESETS as readonly string[]).includes(String(r.preset)) ? r.preset : "default"}，标签页 ${/^[\w.:-]{1,40}$/.test(String(r.tabId)) ? r.tabId : "?"}），最长 ${int(r.maxSeconds) || 60} 秒 / ${int(r.maxMB) || 200}MB 后自动结束。` +
            "现在去操作页面（导航 / 点击 / 滚动 / 输入），然后调用 browser_perf stop_trace 取得摘要；录制期间不要再开第二个 trace。",
        );
        return;
      case "stop_trace":
        return renderTrace(r, b);
      case "metrics":
        return renderMetrics(r, b);
      case "heap_snapshot":
        return renderHeap(r, b);
      case "coverage_start":
        b.trusted(
          `已开始${r.js ? " JS" : ""}${r.css ? " CSS" : ""} 覆盖率统计。数据从现在起算：要统计完整加载过程，请现在再 browser_navigate（reload）并操作页面，最后 browser_perf coverage_stop。统计最多保持 10 分钟。`,
        );
        return;
      case "coverage_stop":
        return renderCoverage(r, b);
      default:
        b.trusted("操作完成。");
    }
  };

  const perfTool: FlowshipToolDef = {
    name: "browser_perf",
    label: "浏览器·性能",
    description:
      "性能分析（高级调试）：start_trace / stop_trace 录制并给出 LCP、CLS、INP、长任务、最慢请求摘要，metrics 看堆 / DOM / 布局指标，heap_snapshot 存堆快照并列构造函数占用前 N，coverage_start / coverage_stop 统计 JS / CSS 未使用比例。" +
      "原始数据写入任务目录、仅供用户在 DevTools 打开（含未脱敏 URL，勿读取），同一会话同时只能录一个 trace、最长 60 秒。",
    parameters: TBObject({
      action: TBEnum([...PERF_TOOL_ACTIONS]),
      preset: TBOptional(TBEnum([...PERF_TRACE_PRESETS], { description: "start_trace：类别预设 default（综合）/ loading（加载）/ runtime（脚本执行），默认 default" })),
      top_n: TBOptional(TBNumber({ description: "heap_snapshot / coverage_stop：列前几名，1–30" })),
      gc: TBOptional(TBBoolean({ description: "heap_snapshot：先强制 GC 再取快照，默认 false" })),
      js: TBOptional(TBBoolean({ description: "coverage_start：统计 JS，默认 true" })),
      css: TBOptional(TBBoolean({ description: "coverage_start：统计 CSS，默认 true" })),
      tab_id: TBOptional(TBString({ description: "start_trace / metrics / heap_snapshot / coverage_start 的目标标签页，默认当前" })),
    }),
    handler: guarded(async (args, ctx) => {
      const action = argEnum(args, "action", PERF_TOOL_ACTIONS);
      if (!action) throw new BadArgs(`缺少必填参数 action（${PERF_TOOL_ACTIONS.join(" / ")}）`);
      const opArgs: Record<string, unknown> = { action };
      const tabId = argStr(args, "tab_id");
      if (tabId !== undefined) opArgs.tabId = tabId;
      if (action === "start_trace") {
        // 类别只认预设名，不接受自由类别串（防止开出超大 / 敏感类别）；写错时给出可选项
        if (args.preset !== undefined && args.preset !== null && args.preset !== "" && argEnum(args, "preset", PERF_TRACE_PRESETS) === undefined) {
          throw new BadArgs(`preset 只能是 ${PERF_TRACE_PRESETS.join(" / ")}（不接受自定义类别串）`);
        }
        const preset = argEnum(args, "preset", PERF_TRACE_PRESETS);
        if (preset !== undefined) opArgs.preset = preset;
      }
      if (action === "heap_snapshot" || action === "coverage_stop") {
        const topN = argNum(args, "top_n");
        if (topN !== undefined) opArgs.topN = Math.min(30, Math.max(1, Math.floor(topN)));
      }
      if (action === "heap_snapshot") {
        const gc = argBool(args, "gc");
        if (gc !== undefined) opArgs.gc = gc;
      }
      if (action === "coverage_start") {
        const js = argBool(args, "js");
        const css = argBool(args, "css");
        if (js === false && css === false) throw new BadArgs("js 和 css 不能同时为 false");
        if (js !== undefined) opArgs.js = js;
        if (css !== undefined) opArgs.css = css;
      }
      // R6-33：heap_snapshot 在主进程会弹 evaluate 审批（最长等 120s），本地超时不能是默认的 60s（先到会把审批卡撤掉）。
      // 总闸开着一定免审批 → 保持默认；否则按「审批 120s + 取快照 180s + slack 15s」（≥300s）。其它 action 不弹审批，保持默认
      const timeoutMs = action === "heap_snapshot" ? approvalAwareTimeoutMs({ evaluateEnabled: getSettings().evaluateEnabled, actionBudgetMs: HEAP_SNAPSHOT_ACTION_BUDGET_MS }) : undefined;
      return run<PerfResult>(ctx, { op: "perf", args: opArgs, render, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
    }),
  };
  return [perfTool];
};
