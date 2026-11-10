/**
 * 增强包 E2 · B2 性能：纯逻辑（trace 事件流式切分与摘要、堆快照构造函数占用、覆盖率汇总、指标人话化）。
 *
 * 全部是不依赖 electron / fs 的纯函数 / 纯状态机，单测可直接喂构造数据：
 *  - {@link createTraceEventSplitter}：把 `{"traceEvents":[{...},{...}]...}` 的文本流**增量**切成单个事件对象，永远不需要整份 JSON.parse；
 *  - {@link createTraceAnalyzer}：逐事件累计（内存有界：长任务只留前 N、请求只留前 N、名字表有上限），`finish()` 出摘要；
 *  - {@link createHeapSummarizer}：增量解析 `.heapsnapshot`（nodes 数组按数字流解析，strings 数组只对「前 N 名」的下标做 JSON.parse）；
 *  - {@link summarizeJsCoverage} / {@link summarizeCssCoverage}：覆盖率按 URL 汇总；
 *  - {@link humanizeMetrics}：`Performance.getMetrics` 的人话版。
 *
 * 所有函数对畸形输入都不抛（跳过坏事件 / 坏字段）；页面来的字符串（URL / 函数名 / 构造函数名）在这里只做长度限制与控制字符剥离，
 * 真正的脱敏（URL 查询参数 / 文本里的密钥）由 ops/perf.mjs 调 net-detail / text-redact 完成，server 侧再做不可信包装。
 */

// ───────────────────────── 常量 ─────────────────────────

/** trace 类别预设：不接受任意类别串（防止 AI 开出超大 / 含敏感的 disabled-by-default 类别） */
export const TRACE_PRESETS = Object.freeze({
  default: Object.freeze([
    "devtools.timeline",
    "disabled-by-default-devtools.timeline",
    "disabled-by-default-devtools.timeline.frame",
    "blink.user_timing",
    "loading",
    "latencyInfo",
    "v8.execute",
  ]),
  loading: Object.freeze(["devtools.timeline", "disabled-by-default-devtools.timeline", "blink.user_timing", "loading", "navigation", "loading,rail"]),
  runtime: Object.freeze(["devtools.timeline", "disabled-by-default-devtools.timeline", "v8.execute", "blink.user_timing", "latencyInfo", "v8"]),
});
export const TRACE_PRESET_NAMES = Object.freeze(Object.keys(TRACE_PRESETS));

export const LONG_TASK_US = 50_000;
export const TOP_LONG_TASKS = 5;
export const TOP_REQUESTS = 8;
export const TOP_COSTS = 8;
/** 内存有界：同时追踪的请求 / 名字 / 线程数上限（超出只丢弃新的，不报错） */
const MAX_TRACKED_REQUESTS = 6000;
const MAX_NAME_KEYS = 400;
const MAX_THREADS = 64;
const MAX_INTERACTIONS = 4000;
const MAX_SHIFTS = 20_000;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const cleanStr = (v, max) => {
  if (typeof v !== "string") return "";
  // 剥控制字符 / 格式字符（页面可控的字符串不能带换行 / 方向控制符进文案）
  const s = v.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
export const fmtMs = (ms) => (ms >= 100 ? Math.round(ms) : Math.round(ms * 10) / 10);

// ───────────────────────── trace 事件切分 ─────────────────────────

/**
 * 增量切分器：`feed(text)` 返回本次文本里**完整**事件的个数，并通过 `onEvent(obj)` 回调；`lastEventEnd` = 迄今最后一个完整事件的结束位置（累计字符偏移，
 * 含该事件的 `}`），调用方据此在超限时把文件截断到事件边界再补 `]}`，得到仍然合法的 trace JSON。
 * 只处理顶层 `"traceEvents":[` 数组；数组结束（`]`）后的 metadata 等内容一律忽略。
 * 状态机逐字符扫描、仅在一个事件对象内才累积文本，所以内存 = 最大单个事件，不随 trace 大小增长。
 *
 * @param {(ev: any) => void} onEvent
 */
export const createTraceEventSplitter = (onEvent) => {
  const KEY = '"traceEvents"';
  let phase = "head"; // head → array → done
  let headBuf = "";
  let offset = 0; // 已消费的累计字符数
  let depth = 0;
  let inStr = false;
  let esc = false;
  let acc = "";
  let lastEventEnd = -1;
  let events = 0;
  let bad = 0;

  const feed = (text) => {
    if (typeof text !== "string" || text === "" || phase === "done") {
      offset += typeof text === "string" ? text.length : 0;
      return 0;
    }
    let count = 0;
    let i = 0;
    const base = offset;
    if (phase === "head") {
      headBuf += text;
      const k = headBuf.indexOf(KEY);
      if (k < 0) {
        if (offset + text.length > 2_000_000) {
          phase = "done"; // 前 2MB 都没有 traceEvents：不是预期格式，放弃解析（文件照存）
          headBuf = "";
        } else if (headBuf.length > 64) {
          headBuf = headBuf.slice(-64); // 只留能拼出半个 key 的尾巴：内存不随输入增长
        }
        offset += text.length;
        return 0;
      }
      const bracket = headBuf.indexOf("[", k + KEY.length);
      if (bracket < 0) {
        headBuf = headBuf.slice(k);
        offset += text.length;
        return 0;
      }
      // headBuf 末尾 = 当前文本的一部分；算出 `[` 之后在 text 里的起点
      const tailLen = headBuf.length - (bracket + 1);
      i = text.length - tailLen;
      if (i < 0) i = 0;
      phase = "array";
      headBuf = "";
    }
    // 事件内部的文本用「起点 + 切片」累积（逐字符拼接对大事件很慢）；事件跨 chunk 时下一块从 0 接着切
    let segStart = depth > 0 ? 0 : -1;
    for (; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === 92) esc = true;
        else if (c === 34) inStr = false;
        continue;
      }
      if (c === 34) {
        inStr = true;
        continue;
      }
      if (c === 123) {
        if (depth === 0) {
          acc = "";
          segStart = i;
        }
        depth += 1;
        continue;
      }
      if (c === 125) {
        if (depth > 0) {
          depth -= 1;
          if (depth === 0) {
            acc += text.slice(segStart, i + 1);
            segStart = -1;
            try {
              onEvent(JSON.parse(acc));
              events += 1;
              count += 1;
            } catch {
              bad += 1;
            }
            lastEventEnd = base + i;
            acc = "";
          }
        }
        continue;
      }
      if (c === 93 && depth === 0) {
        phase = "done"; // traceEvents 数组结束
        break;
      }
    }
    if (depth > 0 && segStart >= 0) {
      acc += text.slice(segStart);
      // 单个事件异常巨大（畸形 / 恶意）：放弃这个事件，不让 acc 无限长
      if (acc.length > 4_000_000) {
        acc = "";
        depth = 0;
        inStr = false;
        esc = false;
        bad += 1;
      }
    }
    offset += text.length;
    return count;
  };

  return {
    feed,
    get lastEventEnd() {
      return lastEventEnd;
    },
    get events() {
      return events;
    },
    get badEvents() {
      return bad;
    },
    get done() {
      return phase === "done";
    },
  };
};

// ───────────────────────── trace 摘要 ─────────────────────────

const argsData = (ev) => (ev && typeof ev.args === "object" && ev.args !== null ? (typeof ev.args.data === "object" && ev.args.data !== null ? ev.args.data : ev.args) : {});

/**
 * 逐事件累计的 trace 分析器。口径（都是近似，摘要里会注明）：
 *  - 范围：优先只看目标页所在渲染进程（`TracingStartedInBrowser` 的 frames + 带主 frame id 的事件所在 pid）；认不出来才退回全部进程；
 *  - LCP = 最后一个 `largestContentfulPaint::Candidate` 距 `navigationStart`；FCP = `firstContentfulPaint`；
 *  - CLS = 无近期输入的 `LayoutShift` 的 score 之和（未做 session window 分窗，是整段录制的总和）；
 *  - INP = `EventTiming` 里 interactionId>0 的交互耗时：≤50 个取最大，否则取 p98（近似）；
 *  - TTFB = 导航后第一个主资源请求的 `receiveHeadersEnd`；
 *  - 长任务 = 主线程 `RunTask` dur > 50ms；主线程耗时榜 = 各事件类型（inclusive 总时长，不是 self time）+ FunctionCall 按函数。
 */
export const createTraceAnalyzer = () => {
  let events = 0;
  let mainFrame = "";
  const pagePids = new Set();
  let navStart = null; // { ts, pid }
  let firstTs = Infinity;
  let lastTs = -Infinity;
  let lcp = null; // { ts, size, pid, url? }
  let fcp = null;
  const fcpByPid = new Map();
  const lcpByPid = new Map();
  const shifts = []; // { pid, score }
  const interactions = []; // { pid, ms }
  const threadNames = new Map(); // "pid:tid" → name
  const threads = new Map(); // "pid:tid" → { pid, tid, longCount, longTotalUs, longest: [], busyUs, names: Map, funcs: Map }
  const reqs = new Map(); // requestId → { url, ts, pid }
  let reqDropped = 0;
  const finished = []; // { url, ms, pid, status?, bytes?, failed? } 保留前若干
  const firstReq = new Map(); // pid → { id, ts }
  const respTtfb = new Map(); // requestId → ms
  const FINISHED_KEEP = 60;

  const thread = (pid, tid) => {
    const k = `${pid}:${tid}`;
    let t = threads.get(k);
    if (!t) {
      if (threads.size >= MAX_THREADS) return null;
      t = { pid, tid, longCount: 0, longTotalUs: 0, longest: [], busyUs: 0, names: new Map(), funcs: new Map() };
      threads.set(k, t);
    }
    return t;
  };
  const bump = (map, key, dur, cap) => {
    const cur = map.get(key);
    if (cur) {
      cur.us += dur;
      cur.n += 1;
    } else if (map.size < cap) map.set(key, { us: dur, n: 1 });
  };

  const onEvent = (ev) => {
    if (!ev || typeof ev !== "object") return;
    events += 1;
    const name = typeof ev.name === "string" ? ev.name : "";
    const ph = typeof ev.ph === "string" ? ev.ph : "";
    const ts = num(ev.ts);
    const pid = num(ev.pid) ?? -1;
    const tid = num(ev.tid) ?? -1;
    if (ts !== undefined && ph !== "M") {
      if (ts < firstTs) firstTs = ts;
      const end = ts + (num(ev.dur) ?? 0);
      if (end > lastTs) lastTs = end;
    }
    if (ph === "M") {
      if (name === "thread_name" && ev.args && typeof ev.args.name === "string") threadNames.set(`${pid}:${tid}`, ev.args.name.slice(0, 60));
      return;
    }
    const data = argsData(ev);
    const frame = typeof ev.args?.frame === "string" ? ev.args.frame : typeof data.frame === "string" ? data.frame : "";

    switch (name) {
      case "TracingStartedInBrowser": {
        const frames = Array.isArray(data.frames) ? data.frames : [];
        const primary = frames.filter((f) => f && typeof f === "object" && (f.isInPrimaryMainFrame === true || (!f.parent && f.isOutermostMainFrame !== false)));
        for (const f of primary.length > 0 ? primary : frames.slice(0, 1)) {
          if (typeof f.frame === "string" && !mainFrame) mainFrame = f.frame;
          if (num(f.processId) !== undefined) pagePids.add(f.processId);
        }
        return;
      }
      case "navigationStart":
        if ((!mainFrame || frame === mainFrame) && ts !== undefined && data.isLoadingMainFrame !== false) {
          if (!navStart || ts >= navStart.ts) navStart = { ts, pid };
          if (frame && !mainFrame) mainFrame = frame;
          pagePids.add(pid);
        }
        return;
      case "firstContentfulPaint":
        if (ts !== undefined && (!mainFrame || frame === mainFrame)) {
          pagePids.add(pid);
          fcpByPid.set(pid, ts);
          if (!fcp || ts < fcp.ts) fcp = { ts, pid };
        }
        return;
      case "largestContentfulPaint::Candidate":
        if (ts !== undefined && (!mainFrame || frame === mainFrame)) {
          pagePids.add(pid);
          const size = num(data.size) ?? 0;
          const cur = lcpByPid.get(pid);
          if (!cur || ts >= cur.ts) lcpByPid.set(pid, { ts, size, type: cleanStr(data.type, 20), nodeName: cleanStr(data.nodeName, 40) });
          if (!lcp || ts >= lcp.ts) lcp = { ts, size, pid, type: cleanStr(data.type, 20), nodeName: cleanStr(data.nodeName, 40) };
        }
        return;
      case "LayoutShift":
        if (shifts.length < MAX_SHIFTS && data.had_recent_input !== true && data.is_main_frame !== false) {
          const score = num(data.score);
          if (score !== undefined && score >= 0) shifts.push({ pid, score });
        }
        return;
      case "EventTiming": {
        // 新版 trace：ph b 带 data.duration（毫秒）；旧版 / 个别实现是 ph X。interactionId=0 的不是离散交互
        const dur = num(data.duration);
        if ((ph === "b" || ph === "X") && dur !== undefined && (num(data.interactionId) ?? 0) > 0 && interactions.length < MAX_INTERACTIONS) {
          interactions.push({ pid, ms: dur });
        }
        return;
      }
      case "ResourceSendRequest": {
        const id = typeof data.requestId === "string" ? data.requestId : "";
        const url = typeof data.url === "string" ? data.url : "";
        if (!id || !url || ts === undefined) return;
        if (reqs.size >= MAX_TRACKED_REQUESTS) {
          reqDropped += 1;
          return;
        }
        reqs.set(id, { url: url.slice(0, 600), ts, pid });
        if (navStart && ts >= navStart.ts && !firstReq.has(pid)) firstReq.set(pid, { id, ts });
        return;
      }
      case "ResourceReceiveResponse": {
        const id = typeof data.requestId === "string" ? data.requestId : "";
        const timing = data.timing && typeof data.timing === "object" ? data.timing : null;
        const hdr = timing ? num(timing.receiveHeadersEnd) : undefined;
        if (id && hdr !== undefined && hdr >= 0) respTtfb.set(id, hdr);
        const r = reqs.get(id);
        if (r) r.status = num(data.statusCode);
        return;
      }
      case "ResourceFinish": {
        const id = typeof data.requestId === "string" ? data.requestId : "";
        const r = reqs.get(id);
        if (!r || ts === undefined) return;
        reqs.delete(id);
        const ms = (ts - r.ts) / 1000;
        if (ms < 0) return;
        const item = { url: r.url, ms, pid: r.pid, status: r.status, bytes: num(data.encodedDataLength), failed: data.didFail === true };
        // 有界：保留最慢的 FINISHED_KEEP 条
        if (finished.length < FINISHED_KEEP) finished.push(item);
        else {
          let minI = 0;
          for (let i = 1; i < finished.length; i += 1) if (finished[i].ms < finished[minI].ms) minI = i;
          if (finished[minI].ms < ms) finished[minI] = item;
        }
        return;
      }
      default:
    }

    if (ph !== "X" || typeof ev.dur !== "number" || !(ev.dur >= 0)) return;
    const t = thread(pid, tid);
    if (!t) return;
    if (name === "RunTask") {
      t.busyUs += ev.dur;
      if (ev.dur > LONG_TASK_US) {
        t.longCount += 1;
        t.longTotalUs += ev.dur;
        t.longest.push({ ms: ev.dur / 1000, ts: ts ?? 0 });
        if (t.longest.length > TOP_LONG_TASKS * 3) {
          t.longest.sort((a, b) => b.ms - a.ms);
          t.longest.length = TOP_LONG_TASKS;
        }
      }
      return;
    }
    // 其它 X 事件：按类型累计 inclusive 时长（只挑信息量大的，免得名字表被琐碎事件填满）
    if (COST_EVENT_NAMES.has(name)) bump(t.names, name, ev.dur, MAX_NAME_KEYS);
    if (name === "FunctionCall" || name === "EvaluateScript" || name === "v8.compile" || name === "v8.run") {
      const fn = cleanStr(data.functionName, 80) || (name === "FunctionCall" ? "(anonymous)" : name);
      const url = cleanStr(data.url, 300);
      const line = num(data.lineNumber);
      bump(t.funcs, `${fn}\u0000${url}\u0000${line ?? ""}`, ev.dur, MAX_NAME_KEYS);
    }
  };

  const percentile = (arr, p) => {
    const s = arr.slice().sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
    return s[idx];
  };

  const finish = (fin = {}) => {
    const isAppUrl = typeof fin.isAppUrl === "function" ? fin.isAppUrl : () => false;
    const redactUrl = typeof fin.redactUrl === "function" ? fin.redactUrl : (u) => u;
    const scopedPids = pagePids.size > 0 ? new Set(pagePids) : null;
    const inScope = (pid) => !scopedPids || scopedPids.has(pid);
    const t0 = navStart?.ts ?? (Number.isFinite(firstTs) ? firstTs : 0);
    const rel = (ts) => (ts - t0) / 1000;

    // 指标：取目标进程里时间最晚的候选（LCP）/ 最早的 FCP
    let lcpC = null;
    for (const [pid, c] of lcpByPid) if (inScope(pid) && (!lcpC || c.ts >= lcpC.ts)) lcpC = c;
    let fcpTs = null;
    for (const [pid, ts] of fcpByPid) if (inScope(pid) && (fcpTs === null || ts < fcpTs)) fcpTs = ts;
    const cls = shifts.filter((s) => inScope(s.pid)).reduce((a, s) => a + s.score, 0);
    const shiftCount = shifts.filter((s) => inScope(s.pid)).length;
    const ints = interactions.filter((x) => inScope(x.pid)).map((x) => x.ms);
    let inp = null;
    if (ints.length > 0) inp = ints.length <= 50 ? Math.max(...ints) : percentile(ints, 0.98);

    // TTFB：目标进程里导航后第一个请求的 receiveHeadersEnd
    let ttfb = null;
    for (const [pid, r] of firstReq) {
      if (!inScope(pid)) continue;
      const v = respTtfb.get(r.id);
      if (v !== undefined && (ttfb === null || v < ttfb)) ttfb = v;
    }

    // 主线程：优先 CrRendererMain 且在目标进程；没有线程名元数据就取目标进程里 busy 最大的线程
    const cand = [...threads.values()].filter((t) => inScope(t.pid));
    const mains = cand.filter((t) => /CrRendererMain/i.test(threadNames.get(`${t.pid}:${t.tid}`) ?? ""));
    const pool = mains.length > 0 ? mains : cand.slice().sort((a, b) => b.busyUs - a.busyUs).slice(0, 1);
    let longCount = 0;
    let longTotal = 0;
    let longest = [];
    const nameAgg = new Map();
    const funcAgg = new Map();
    let busy = 0;
    for (const t of pool) {
      longCount += t.longCount;
      longTotal += t.longTotalUs;
      longest = longest.concat(t.longest);
      busy += t.busyUs;
      for (const [k, v] of t.names) bump(nameAgg, k, v.us, 1000);
      for (const [k, v] of t.funcs) {
        const c = funcAgg.get(k);
        if (c) c.us += v.us;
        else funcAgg.set(k, { us: v.us, n: v.n });
      }
    }
    longest.sort((a, b) => b.ms - a.ms);
    longest = longest.slice(0, TOP_LONG_TASKS).map((x) => ({ ms: fmtMs(x.ms), atMs: fmtMs(rel(x.ts)) }));

    const slow = finished
      .filter((r) => inScope(r.pid) && !isAppUrl(r.url))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, TOP_REQUESTS)
      .map((r) => ({ url: cleanStr(redactUrl(r.url), 300), ms: fmtMs(r.ms), ...(r.status !== undefined ? { status: r.status } : {}), ...(r.bytes !== undefined ? { bytes: r.bytes } : {}), ...(r.failed ? { failed: true } : {}) }));

    const costs = [...nameAgg.entries()]
      .sort((a, b) => b[1].us - a[1].us)
      .slice(0, TOP_COSTS)
      .map(([n, v]) => ({ name: n, ms: fmtMs(v.us / 1000), count: v.n }));
    const funcs = [...funcAgg.entries()]
      .map(([k, v]) => {
        const [fn, url, line] = k.split("\u0000");
        return { fn, url, line, us: v.us, n: v.n };
      })
      .filter((f) => !(f.url && isAppUrl(f.url)))
      .sort((a, b) => b.us - a.us)
      .slice(0, TOP_COSTS)
      .map((f) => ({ fn: f.fn, ...(f.url ? { url: cleanStr(redactUrl(f.url), 200) } : {}), ...(f.line ? { line: Number(f.line) } : {}), ms: fmtMs(f.us / 1000), count: f.n }));

    return {
      events,
      scope: scopedPids ? "page" : "all",
      durationMs: Number.isFinite(firstTs) && Number.isFinite(lastTs) && lastTs >= firstTs ? fmtMs((lastTs - firstTs) / 1000) : null,
      metrics: {
        lcpMs: lcpC ? fmtMs(rel(lcpC.ts)) : null,
        lcpElement: lcpC ? { type: lcpC.type, nodeName: lcpC.nodeName, size: lcpC.size } : null,
        fcpMs: fcpTs !== null ? fmtMs(rel(fcpTs)) : null,
        cls: Math.round(cls * 1000) / 1000,
        layoutShifts: shiftCount,
        inpMs: inp !== null ? fmtMs(inp) : null,
        interactions: ints.length,
        ttfbMs: ttfb !== null ? fmtMs(ttfb) : null,
      },
      longTasks: { count: longCount, totalMs: fmtMs(longTotal / 1000), longest },
      mainThreadBusyMs: fmtMs(busy / 1000),
      slowRequests: slow,
      requestsDropped: reqDropped,
      topEvents: costs,
      topFunctions: funcs,
    };
  };

  return { onEvent, finish, get events() { return events; } };
};

/** 事件类型白名单：渲染 / 脚本 / 解析 / 绘制里最能说明「主线程在忙什么」的几类 */
const COST_EVENT_NAMES = new Set([
  "FunctionCall",
  "EvaluateScript",
  "v8.compile",
  "v8.run",
  "Layout",
  "UpdateLayoutTree",
  "RecalculateStyles",
  "Paint",
  "PrePaint",
  "Layerize",
  "Commit",
  "ParseHTML",
  "ParseAuthorStyleSheet",
  "EventDispatch",
  "TimerFire",
  "FireAnimationFrame",
  "RunMicrotasks",
  "XHRReadyStateChange",
  "MinorGC",
  "MajorGC",
  "V8.GC_MC_BACKGROUND_MARKING",
  "HitTest",
  "ScheduleStyleRecalculation",
  "UpdateLayer",
  "CompositeLayers",
  "ImageDecodeTask",
  "ResourceFinish",
]);
// ResourceFinish 是瞬时事件（不是 X），留在白名单里无害；删掉避免误导
COST_EVENT_NAMES.delete("ResourceFinish");

// ───────────────────────── 堆快照 ─────────────────────────

export const HEAP_SUMMARY_MAX_BYTES = 100 * 1024 * 1024;
export const HEAP_TOP_N_DEFAULT = 15;

/**
 * 增量解析 `.heapsnapshot`（V8 格式：`{"snapshot":{meta..},"nodes":[ints],"edges":[ints],...,"strings":["..",..]}`），
 * 按「构造函数」汇总 self_size：type 为 object / native → 用 name 字符串；其它类型用 `(type)` 作组名（与 DevTools Summary 一致）。
 * 内存 = 一个 Map<name 下标, {c, s}>（≤ 节点种类数）；strings 数组只对前 N 名的下标做 JSON.parse。
 * 简化（写进报告）：不解析 edges / retained size / 支配树，所以只有 self size 与个数，不是 retained size。
 *
 * 用法：`feed(text)` 逐块喂（返回 void，格式错误只置 `error`）；`finish(topN)` 出 `{nodeCount, totalSelfSize, top}`。
 */
export const createHeapSummarizer = () => {
  let stage = "head"; // head → nodes → seek → strings → done
  let headBuf = "";
  let fields = null; // { n, type, name, self }
  let typeNames = [];
  let fi = 0;
  let cur = 0;
  let inNum = false;
  let curType = 0;
  let curName = 0;
  let curSelf = 0;
  const byName = new Map(); // name 下标 → { c, s }
  const byType = new Map(); // type 名 → { c, s }
  let nodeCount = 0;
  let totalSelf = 0;
  let error = "";
  // seek
  let seekTail = "";
  // strings
  let wanted = null; // Map<下标, topN 序号>
  let strIdx = 0;
  let inStr = false;
  let esc = false;
  let capture = false;
  let acc = "";
  const names = new Map(); // 下标 → 字符串

  const fail = (m) => {
    error = m;
    stage = "done";
  };

  const parseHead = (prefix) => {
    // prefix = `{"snapshot":{...},` → 补 `}` 后 JSON.parse
    const trimmed = prefix.replace(/,\s*$/, "");
    let obj;
    try {
      obj = JSON.parse(`${trimmed}}`);
    } catch {
      return fail("堆快照头部不是合法 JSON");
    }
    const meta = obj?.snapshot?.meta;
    const nf = Array.isArray(meta?.node_fields) ? meta.node_fields : null;
    if (!nf) return fail("堆快照缺少 meta.node_fields（格式不受支持）");
    const idx = (n) => nf.indexOf(n);
    fields = { n: nf.length, type: idx("type"), name: idx("name"), self: idx("self_size") };
    if (fields.type < 0 || fields.name < 0 || fields.self < 0) return fail("堆快照节点字段缺少 type / name / self_size");
    const types = Array.isArray(meta?.node_types) ? meta.node_types[0] : null;
    typeNames = Array.isArray(types) ? types.map((t) => String(t).slice(0, 40)) : [];
    stage = "nodes";
    return undefined;
  };

  const commitNode = () => {
    nodeCount += 1;
    totalSelf += curSelf;
    const tn = typeNames[curType] ?? "unknown";
    if (tn === "object" || tn === "native") {
      const e = byName.get(curName);
      if (e) {
        e.c += 1;
        e.s += curSelf;
      } else byName.set(curName, { c: 1, s: curSelf });
    } else {
      const e = byType.get(tn);
      if (e) {
        e.c += 1;
        e.s += curSelf;
      } else byType.set(tn, { c: 1, s: curSelf });
    }
  };

  /** nodes 结束后：确定要取名字的下标集合（前 N 名 by self + 前 N 名 by count 的并集，N 在 finish 之前未知 → 取 topN 上限 40） */
  const prepareWanted = (limit) => {
    const bySize = [...byName.entries()].sort((a, b) => b[1].s - a[1].s).slice(0, limit);
    const byCount = [...byName.entries()].sort((a, b) => b[1].c - a[1].c).slice(0, limit);
    wanted = new Set([...bySize, ...byCount].map(([k]) => k));
  };

  const feed = (text, topLimit = 40) => {
    if (stage === "done" || typeof text !== "string") return;
    let i = 0;
    if (stage === "head") {
      headBuf += text;
      const k = headBuf.indexOf('"nodes":[');
      if (k < 0) {
        if (headBuf.length > 8_000_000) fail("堆快照 8MB 内没有找到 nodes 数组");
        return;
      }
      const prefix = headBuf.slice(0, k);
      const rest = headBuf.slice(k + '"nodes":['.length);
      headBuf = "";
      parseHead(prefix);
      if (stage !== "nodes") return;
      text = rest;
    }
    if (stage === "nodes") {
      const f = fields;
      for (; i < text.length; i += 1) {
        const c = text.charCodeAt(i);
        if (c >= 48 && c <= 57) {
          cur = cur * 10 + (c - 48);
          inNum = true;
          continue;
        }
        if (inNum) {
          if (fi === f.type) curType = cur;
          else if (fi === f.name) curName = cur;
          else if (fi === f.self) curSelf = cur;
          fi += 1;
          if (fi >= f.n) {
            commitNode();
            fi = 0;
          }
          cur = 0;
          inNum = false;
        }
        if (c === 93) {
          // ]
          stage = "seek";
          prepareWanted(topLimit);
          i += 1;
          break;
        }
      }
      if (stage === "nodes") return;
      text = text.slice(i);
      i = 0;
    }
    if (stage === "seek") {
      const buf = seekTail + text;
      const k = buf.indexOf('"strings":[');
      if (k < 0) {
        seekTail = buf.slice(-12);
        return;
      }
      seekTail = "";
      text = buf.slice(k + '"strings":['.length);
      stage = "strings";
    }
    if (stage === "strings") {
      let segStart = capture ? 0 : -1;
      for (i = 0; i < text.length; i += 1) {
        const c = text.charCodeAt(i);
        if (inStr) {
          if (esc) esc = false;
          else if (c === 92) esc = true;
          else if (c === 34) {
            inStr = false;
            if (capture) {
              acc += text.slice(segStart, i + 1);
              if (acc.length <= 4000) {
                try {
                  names.set(strIdx, JSON.parse(acc));
                } catch {
                  /* 坏字符串：用占位 */
                }
              }
              acc = "";
              capture = false;
              segStart = -1;
            }
            strIdx += 1;
          }
          continue;
        }
        if (c === 34) {
          inStr = true;
          capture = wanted?.has(strIdx) === true;
          segStart = capture ? i : -1;
        } else if (c === 93) {
          stage = "done";
          return;
        }
      }
      if (inStr && capture) {
        acc += text.slice(segStart);
        if (acc.length > 4000) {
          // 超长名字：放弃这条（不让 acc 无限长）
          acc = "";
          capture = false;
        }
      }
    }
  };

  const finish = (topN = HEAP_TOP_N_DEFAULT) => {
    const n = Math.max(1, Math.min(50, Math.floor(topN) || HEAP_TOP_N_DEFAULT));
    const rows = [];
    for (const [idx, v] of byName) rows.push({ name: names.has(idx) ? cleanStr(String(names.get(idx)), 80) : `(string #${idx})`, count: v.c, selfSize: v.s, idx });
    for (const [t, v] of byType) rows.push({ name: `(${t})`, count: v.c, selfSize: v.s, idx: -1 });
    rows.sort((a, b) => b.selfSize - a.selfSize);
    return {
      ok: !error && nodeCount > 0,
      error: error || (nodeCount === 0 ? "堆快照里没有解析到节点" : ""),
      nodeCount,
      totalSelfSize: totalSelf,
      complete: stage === "done" && !error,
      top: rows.slice(0, n).map((r) => ({ name: r.name, count: r.count, selfSize: r.selfSize, percent: totalSelf > 0 ? Math.round((r.selfSize / totalSelf) * 1000) / 10 : 0 })),
    };
  };

  return { feed, finish, get error() { return error; }, get stage() { return stage; } };
};

// ───────────────────────── 覆盖率 ─────────────────────────

const mergeLen = (ranges) => {
  const rs = ranges.filter((r) => r[1] > r[0]).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curS = -1;
  let curE = -1;
  for (const [s, e] of rs) {
    if (s > curE) {
      if (curE > curS) total += curE - curS;
      curS = s;
      curE = e;
    } else if (e > curE) curE = e;
  }
  if (curE > curS) total += curE - curS;
  return total;
};

const rowsFrom = (map, topN, label) => {
  const rows = [...map.entries()].map(([url, v]) => {
    const unused = Math.max(0, v.total - v.used);
    return { url, total: v.total, used: v.used, unused, usedPercent: v.total > 0 ? Math.round((v.used / v.total) * 1000) / 10 : 100, scripts: v.scripts };
  });
  const total = rows.reduce((a, r) => a + r.total, 0);
  const used = rows.reduce((a, r) => a + r.used, 0);
  rows.sort((a, b) => b.unused - a.unused);
  return { kind: label, total, used, unused: Math.max(0, total - used), usedPercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 100, files: rows.length, top: rows.slice(0, topN) };
};

/**
 * JS 覆盖率：`Profiler.takePreciseCoverage` 的 result → 按 URL 汇总。
 * 脚本总长取「覆盖了整个脚本的最外层函数范围」的 endOffset（与 DevTools Coverage 同法）；已用 = 总长 − count==0 的范围并集。
 * 没有 URL 的脚本（eval / new Function / 内联 ）归到 `(无 URL 的脚本)`；Flowship 自身 origin 的脚本整条丢弃（红线 1）。
 */
/** @param {any} result @param {{ topN?: number, isAppUrl?: (u: string) => boolean }} [opts] */
export const summarizeJsCoverage = (result, { topN = 10, isAppUrl = () => false } = {}) => {
  const map = new Map();
  for (const s of Array.isArray(result) ? result : []) {
    if (!s || typeof s !== "object") continue;
    const url = typeof s.url === "string" && s.url !== "" ? s.url : "(无 URL 的脚本)";
    if (url.startsWith("extensions::") || url.startsWith("chrome-extension:") || url.startsWith("devtools:")) continue;
    if (isAppUrl(url)) continue;
    const fns = Array.isArray(s.functions) ? s.functions : [];
    let len = 0;
    const zero = [];
    for (const f of fns) {
      const ranges = Array.isArray(f?.ranges) ? f.ranges : [];
      for (const r of ranges) {
        const a = num(r?.startOffset);
        const b = num(r?.endOffset);
        if (a === undefined || b === undefined || b < a) continue;
        if (b > len) len = b;
        if (r.count === 0) zero.push([a, b]);
      }
    }
    if (len <= 0) continue;
    const used = Math.max(0, len - Math.min(len, mergeLen(zero)));
    const e = map.get(url);
    if (e) {
      e.total += len;
      e.used += used;
      e.scripts += 1;
    } else map.set(url, { total: len, used, scripts: 1 });
  }
  return rowsFrom(map, topN, "js");
};

/**
 * CSS 覆盖率：`stylesheets` = `CSS.styleSheetAdded` 收集的 `[{styleSheetId, url, length}]`，`usage` = `CSS.stopRuleUsageTracking` 的 ruleUsage。
 * 总长 = 样式表文本长度；已用 = used:true 的规则范围并集（注释 / 空白算未用，与 DevTools 一致）。内联 `<style>` 的 url 为空 → `(内联样式)`。
 */
/** @param {any} stylesheets @param {any} usage @param {{ topN?: number, isAppUrl?: (u: string) => boolean }} [opts] */
export const summarizeCssCoverage = (stylesheets, usage, { topN = 10, isAppUrl = () => false } = {}) => {
  const sheets = new Map();
  for (const s of Array.isArray(stylesheets) ? stylesheets : []) {
    if (s && typeof s.styleSheetId === "string") sheets.set(s.styleSheetId, s);
  }
  const usedBy = new Map();
  for (const u of Array.isArray(usage) ? usage : []) {
    const a = num(u?.startOffset);
    const b = num(u?.endOffset);
    if (!u || typeof u.styleSheetId !== "string" || a === undefined || b === undefined || b < a || u.used !== true) continue;
    const list = usedBy.get(u.styleSheetId) ?? [];
    list.push([a, b]);
    usedBy.set(u.styleSheetId, list);
  }
  const map = new Map();
  for (const [id, s] of sheets) {
    const url = typeof s.url === "string" && s.url !== "" ? s.url : "(内联样式)";
    if (isAppUrl(url)) continue;
    const len = num(s.length);
    if (!len || len <= 0) continue;
    const used = Math.min(len, mergeLen(usedBy.get(id) ?? []));
    const e = map.get(url);
    if (e) {
      e.total += len;
      e.used += used;
      e.scripts += 1;
    } else map.set(url, { total: len, used, scripts: 1 });
  }
  return rowsFrom(map, topN, "css");
};

// ───────────────────────── Performance.getMetrics ─────────────────────────

/** CDP 指标名 → 人话字段；未知名字忽略。时长（秒）转毫秒，字节转 MB（保留 1 位）；不是有限数的丢弃 */
export const humanizeMetrics = (metrics) => {
  const m = new Map();
  for (const x of Array.isArray(metrics) ? metrics : []) {
    if (x && typeof x.name === "string" && num(x.value) !== undefined) m.set(x.name, x.value);
  }
  const ms = (k) => (m.has(k) ? fmtMs(m.get(k) * 1000) : undefined);
  const mb = (k) => (m.has(k) ? Math.round((m.get(k) / 1048576) * 10) / 10 : undefined);
  const int = (k) => (m.has(k) ? Math.round(m.get(k)) : undefined);
  const out = {
    jsHeapUsedMB: mb("JSHeapUsedSize"),
    jsHeapTotalMB: mb("JSHeapTotalSize"),
    domNodes: int("Nodes"),
    documents: int("Documents"),
    frames: int("Frames"),
    jsEventListeners: int("JSEventListeners"),
    layoutCount: int("LayoutCount"),
    styleRecalcCount: int("RecalcStyleCount"),
    layoutDurationMs: ms("LayoutDuration"),
    styleRecalcDurationMs: ms("RecalcStyleDuration"),
    scriptDurationMs: ms("ScriptDuration"),
    taskDurationMs: ms("TaskDuration"),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
};
