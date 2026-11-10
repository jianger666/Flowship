/**
 * 增强包 E2 · B2 性能（start_trace / stop_trace / metrics / heap_snapshot / coverage_start / coverage_stop）
 *
 * 纯逻辑（trace 事件切分与摘要、堆快照构造函数占用、覆盖率汇总、指标人话化）在 ../perf-summary.mjs；本文件把它们接到 tab / session，并负责落盘：
 *
 *  - **全部走 `session.runAction`**（串行 / AI 归因 / 用户接管时 USER_CONTROL / 写活动日志）。例外是 trace 的 60 秒自动结束：它发生在没有任何
 *    动作的时刻，由定时器直接收尾，结果存进 `lastTrace`，下一次 `stop_trace` 取走；
 *  - **写盘红线（§15.3-8）**：目录 `<userData>/data/tasks/<taskId>/browser-traces`（0700），文件名由主进程生成（`trace-<时间戳>.json` /
 *    `heap-<时间戳>.heapsnapshot`），先写 `.tmp`（0600、`wx`）再 rename，所以任何失败 / 中止都不会在最终文件名下留半截文件；
 *    trace 200MB、堆快照 500MB 上限，目录里只留最近几个文件；
 *  - **trace 流式**：`Tracing.start` 用 ReturnAsStream，stop 后 `IO.read` 分块边读边写、边切事件边累计摘要，整份 trace 从不进内存；
 *    超过大小上限就在「最后一个完整事件」处截断并补 `]}`，文件仍是合法 trace JSON；超过摘要上限（100MB）只存文件、摘要降级；
 *  - **收尾**：trace / coverage 的状态挂在 `session.getExt("perf")`，会话销毁走 `dispose()`；tab 关闭走 `tab.addDestroyHook`。
 *    trace 进行中没有磁盘文件（stop 时才写），所以收尾就是「丢掉」，不会留半截文件；
 *  - **不用 Debugger 域**（不碰 debugger-hub）：JS 覆盖率用 Profiler，总长从覆盖范围推出；CSS 用 CSS 域的规则使用追踪。
 *  - **Flowship origin**：摘要里的请求 / 函数 / 脚本 URL 命中 `isAppUrl` 的整条丢弃（trace 是浏览器范围的，可能带到 Flowship 自己的渲染进程）。
 */
import nodeFs from "node:fs";
import nodePath from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ensureEvaluateApproval } from "../evaluate-approval.mjs";
import { redactUrlSecrets } from "../net-detail.mjs";
import { fsErrorText } from "../path-scrub.mjs";
import {
  createHeapSummarizer,
  createTraceAnalyzer,
  createTraceEventSplitter,
  HEAP_SUMMARY_MAX_BYTES,
  humanizeMetrics,
  summarizeCssCoverage,
  summarizeJsCoverage,
  TRACE_PRESET_NAMES,
  TRACE_PRESETS,
} from "../perf-summary.mjs";
import { ensureSafeDir } from "../safe-dir.mjs";
import { BrowserError } from "../server-channel.mjs";
import { redactAndClip } from "../text-redact.mjs";

export const OPS = Object.freeze(["perf"]);
export const PERF_ACTIONS = Object.freeze(["start_trace", "stop_trace", "metrics", "heap_snapshot", "coverage_start", "coverage_stop"]);

export const PERF_DIR_NAME = "browser-traces";
/**
 * 默认上限（测试可经 `deps.perfLimits` 缩小）
 * @type {Readonly<{ traceMaxBytes: number, traceMaxMs: number, heapMaxBytes: number, heapSummaryMaxBytes: number, coverageMaxMs: number, readChunk: number, keepFiles: number, maxAgeMs: number }>}
 */
export const PERF_LIMITS = Object.freeze({
  traceMaxBytes: 200 * 1024 * 1024,
  traceMaxMs: 60_000,
  heapMaxBytes: 500 * 1024 * 1024,
  heapSummaryMaxBytes: HEAP_SUMMARY_MAX_BYTES,
  coverageMaxMs: 10 * 60_000,
  readChunk: 1024 * 1024,
  keepFiles: 6,
  maxAgeMs: 3 * 24 * 60 * 60 * 1000,
});

/** 自 Performance.enable 起累计的指标（第一次 metrics 时没有意义，不返回） */
const COUNTER_KEYS = ["layoutCount", "styleRecalcCount", "layoutDurationMs", "styleRecalcDurationMs", "scriptDurationMs", "taskDurationMs"];
const TASK_ID_RE = /^[a-zA-Z0-9_-]{1,200}$/;
const unixMode = () => process.platform !== "win32";

export const normalize = (op, args, h) => {
  switch (op) {
    case "perf": {
      const action = h.reqEnum(args, "action", PERF_ACTIONS);
      const out = { action };
      if (action === "start_trace") {
        // 只认预设名：任意类别串可能开出超大 / 敏感的 disabled-by-default 类别
        const preset = h.optEnum(args, "preset", TRACE_PRESET_NAMES, undefined) ?? h.optEnum(args, "categories", TRACE_PRESET_NAMES, "default");
        out.preset = preset;
      }
      if (action === "heap_snapshot") {
        out.topN = h.optNum(args, "topN", { min: 1, max: 30, dflt: 12 });
        out.gc = h.optBool(args, "gc", false);
      }
      if (action === "coverage_start") {
        out.js = h.optBool(args, "js", true);
        out.css = h.optBool(args, "css", true);
        if (!out.js && !out.css) throw h.bad("coverage_start 的 js 和 css 不能同时关闭");
      }
      if (action === "coverage_stop") out.topN = h.optNum(args, "topN", { min: 1, max: 30, dflt: 10 });
      return h.withTab(args, out);
    }
    default:
      throw h.bad(`未实现的浏览器操作：${String(op).slice(0, 40)}`);
  }
};

// ───────────────────────── 落盘（纯 fs 注入，单测用临时目录） ─────────────────────────

/** 任务的 browser-traces 目录；taskId 不是安全字符 / userData 缺失 → null（绝不拼路径） */
export const perfDirFor = (userData, taskId) => {
  if (typeof userData !== "string" || userData === "" || !TASK_ID_RE.test(String(taskId ?? ""))) return null;
  return nodePath.join(userData, "data", "tasks", String(taskId), PERF_DIR_NAME);
};

const pad2 = (n) => String(n).padStart(2, "0");
export const perfStamp = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;

/** 只留最近 keep 个、且不超过 maxAge 的 trace-* / heap-* 文件；`.tmp`（进行中）不动 */
export const prunePerfDir = ({ fs = nodeFs, dir, now = Date.now(), keep = PERF_LIMITS.keepFiles, maxAgeMs = PERF_LIMITS.maxAgeMs }) => {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const files = [];
  for (const n of names) {
    if (!/^(trace|heap)-/.test(n)) continue;
    try {
      const st = fs.lstatSync(nodePath.join(dir, n));
      if (st.isFile()) files.push({ n, t: st.mtimeMs });
    } catch {
      /* 刚被删 */
    }
  }
  files.sort((a, b) => b.t - a.t);
  let removed = 0;
  files.forEach((f, i) => {
    if (i < keep && now - f.t <= maxAgeMs) return;
    try {
      fs.unlinkSync(nodePath.join(dir, f.n));
      removed += 1;
    } catch {
      /* 删不掉下次再说 */
    }
  });
  return removed;
};

/**
 * 带位置的写入器：`.tmp`（0600、wx）→ `commit()` rename 成最终名；`abort()` 删 tmp。
 * 写入用显式 position，所以 `truncate(n)` 之后继续写不会错位。
 */
export const createCappedWriter = ({ fs = nodeFs, dir, prefix, ext, now = new Date(), nowMs = Date.now(), keep = PERF_LIMITS.keepFiles, maxAgeMs = PERF_LIMITS.maxAgeMs }) => {
  // R6-15：lstat 逐级拒符号链接 / 校验属主与 0700（之前只 mkdir -p + chmod：目录被换成符号链接时 chmod / 写 / prune 删除都会落到链接目标上）
  ensureSafeDir(dir, { fs, label: "browser-traces" });
  prunePerfDir({ fs, dir, now: nowMs, keep, maxAgeMs });
  const base = `${prefix}-${perfStamp(now)}`;
  const tmp = nodePath.join(dir, `.${base}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  const fd = fs.openSync(tmp, "wx", 0o600);
  if (unixMode()) fs.fchmodSync(fd, 0o600);
  let bytes = 0;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      fs.closeSync(fd);
    } catch {
      /* 已关 */
    }
  };
  return {
    get bytes() {
      return bytes;
    },
    write(buf) {
      if (closed) throw new Error("写入器已关闭");
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), "utf8");
      let off = 0;
      while (off < b.length) off += fs.writeSync(fd, b, off, b.length - off, bytes + off);
      bytes += b.length;
    },
    truncate(n) {
      fs.ftruncateSync(fd, n);
      bytes = n;
    },
    commit() {
      close();
      let file = `${base}${ext}`;
      for (let i = 2; i < 100; i += 1) {
        try {
          fs.lstatSync(nodePath.join(dir, file));
        } catch {
          break;
        }
        file = `${base}-${i}${ext}`;
      }
      const finalPath = nodePath.join(dir, file);
      try {
        fs.renameSync(tmp, finalPath);
      } catch (err) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* 留给 prune */
        }
        throw err;
      }
      return { file, path: finalPath, bytes };
    },
    abort() {
      close();
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 清不掉留给下次 */
      }
    },
  };
};

// ───────────────────────── 小工具 ─────────────────────────

const yieldLoop = () => new Promise((r) => setImmediate(r));
const clipText = (s, n) => redactAndClip(String(s ?? ""), n).text;

/**
 * trace 结果对外（给模型）的形状：去掉绝对路径 `path`，只留文件名 `file` 与任务目录里的子目录名 `dir`（R6-02）。
 * 绝对路径只留在主进程内部——R6-34：活动日志 / 错误文案里同样不写（活动日志的 AI 条目会经录制 `stop` 的 ai-action 标记与 `export_activity` 回流给模型）。
 */
export const publicTraceResult = (res) => {
  const rest = { ...(res ?? {}) };
  delete rest.path;
  return { ...rest, dir: PERF_DIR_NAME };
};

/** 活动日志里的位置说明（R6-34）：只写「任务目录里的 browser-traces」+ 文件名，不写 userData 绝对路径 */
const savedAt = (file) => `${PERF_DIR_NAME}/${file}`;

/** 摘要里页面来的文字（函数名 / 构造函数名 / 元素名）过文本脱敏；URL 已在 analyzer 里过 redactUrlSecrets */
export const redactTraceSummary = (s) => {
  if (!s || typeof s !== "object") return s;
  return {
    ...s,
    topFunctions: (s.topFunctions ?? []).map((f) => ({ ...f, fn: clipText(f.fn, 80), ...(f.url ? { url: clipText(f.url, 200) } : {}) })),
    slowRequests: (s.slowRequests ?? []).map((r) => ({ ...r, url: clipText(r.url, 300) })),
  };
};

/**
 * 读完整个 trace 流：边读边写边分析。返回 { file, path, bytes, truncated, summaryDegraded, summary }。
 * 失败 / 取消一律删 tmp 后抛出。导出供单测用假 tab（只要有 `send`）直接驱动。
 */
export const readTraceStream = async ({ tab, handle, writer, limits, isCancelled = () => false, isAppUrl, onProgress }) => {
  const analyzer = createTraceAnalyzer();
  let analysisOn = true;
  let degraded = false;
  const splitter = createTraceEventSplitter((ev) => {
    if (analysisOn) analyzer.onEvent(ev);
  });
  const decoder = new StringDecoder("utf8");
  let chars = 0;
  let decodedBytes = 0;
  let lastEndByte = 0;
  let truncated = false;
  try {
    for (;;) {
      if (isCancelled()) throw new BrowserError("CANCELLED", "性能录制已取消（标签页关闭 / 会话结束），没有保存文件");
      const r = await tab.send("IO.read", { handle, size: limits.readChunk }, null, 30_000);
      const buf = r?.base64Encoded ? Buffer.from(String(r.data ?? ""), "base64") : Buffer.from(String(r?.data ?? ""), "utf8");
      if (buf.length > 0) {
        writer.write(buf);
        const text = decoder.write(buf);
        const prevEnd = splitter.lastEventEnd;
        const charsBefore = chars;
        splitter.feed(text);
        if (splitter.lastEventEnd !== prevEnd) {
          lastEndByte = decodedBytes + Buffer.byteLength(text.slice(0, splitter.lastEventEnd - charsBefore + 1), "utf8");
        }
        chars += text.length;
        decodedBytes += Buffer.byteLength(text, "utf8");
      }
      if (analysisOn && writer.bytes > limits.heapSummaryMaxBytes) {
        analysisOn = false;
        degraded = true;
      }
      onProgress?.(writer.bytes);
      if (writer.bytes > limits.traceMaxBytes) {
        truncated = true;
        break;
      }
      if (r?.eof || (buf.length === 0 && r?.eof !== false)) break;
      await yieldLoop(); // 单次同步处理不超过一个 chunk（1MB 扫描 + 解析，毫秒级），块间让出事件循环
    }
    if (truncated) {
      // 截到最后一个完整事件的边界再补 ]}：文件仍是合法 trace JSON，DevTools Performance 能打开
      if (lastEndByte > 0) {
        writer.truncate(lastEndByte);
        writer.write("]}");
      } else {
        writer.truncate(0);
        writer.write('{"traceEvents":[]}');
      }
    }
    const saved = writer.commit();
    const summary = degraded ? null : redactTraceSummary(analyzer.finish({ isAppUrl, redactUrl: redactUrlSecrets }));
    return { ...saved, truncated, summaryDegraded: degraded, summary, parsedEvents: splitter.events, badEvents: splitter.badEvents };
  } catch (err) {
    writer.abort();
    throw err;
  } finally {
    try {
      await tab.send("IO.close", { handle }, null, 5000);
    } catch {
      /* 流已关 / tab 已销毁 */
    }
  }
};

/** 读 .heapsnapshot 并增量汇总；分块 + 块间让出事件循环。文件由我们刚写完，路径可信 */
export const summarizeHeapFile = async ({ fs = nodeFs, filePath, topN, isCancelled = () => false, chunk = PERF_LIMITS.readChunk }) => {
  const sum = createHeapSummarizer();
  const fh = await fs.promises.open(filePath, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buf = Buffer.allocUnsafe(chunk);
    for (;;) {
      if (isCancelled()) throw new BrowserError("CANCELLED", "堆快照摘要已取消");
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      sum.feed(decoder.write(buf.subarray(0, bytesRead)), Math.max(40, topN * 2));
      if (sum.stage === "done") break;
      await yieldLoop();
    }
  } finally {
    await fh.close().catch(() => {});
  }
  return sum.finish(topN);
};

const redactHeapSummary = (s) => ({ ...s, top: (s.top ?? []).map((r) => ({ ...r, name: clipText(r.name, 80) })) });

const redactCoverage = (c) => (c ? { ...c, top: (c.top ?? []).map((r) => ({ ...r, url: clipText(redactUrlSecrets(r.url), 300) })) } : c);

// ───────────────────────── handlers ─────────────────────────

const EXT_KEY = "perf";

/**
 * @param {object} deps  index.mjs 的 createExtraHandlers 依赖（契约 §15.1）；测试可额外注入 `fs` / `now` / `perfLimits`
 */
export const createHandlers = (deps) => {
  const { requireSession, scheduleState } = deps;
  const fs = deps.fs ?? nodeFs;
  const limits = { ...PERF_LIMITS, ...(deps.perfLimits ?? {}) };
  const isAppUrl = (u) => {
    try {
      return deps.electron?.isAppUrl?.(u) === true;
    } catch {
      return false;
    }
  };
  const nowDate = () => {
    const v = typeof deps.now === "function" ? deps.now() : undefined;
    return v instanceof Date ? v : new Date(typeof v === "number" ? v : Date.now());
  };
  const userDataDir = () => {
    try {
      return deps.app?.getPath?.("userData") ?? "";
    } catch {
      return "";
    }
  };
  // R6-34：进错误文案 / 结果 / 日志的错误一律经此——fs 错误只留 errno 码 + 释义 + 系统调用 + 文件名，其它错误的 message 里的本机路径（userData / 家目录 / 常见绝对路径）被剔除
  const errMsg = (err) => fsErrorText(err, { roots: [userDataDir()], max: 160 });
  const schedule = (taskId) => {
    try {
      scheduleState?.(taskId);
    } catch {
      /* 状态推送失败不影响结果 */
    }
  };
  const logActivity = (session, tab, summary, kind = "select", maxChars = 150) => {
    try {
      session.activityLog.addAI({ kind, tabId: tab?.id ?? "", url: tab?.url ?? "", summary: clipText(summary, maxChars) });
      schedule(session.taskId);
    } catch (err) {
      deps.log?.(`[browser] 性能工具的活动日志写入失败：${err?.message || err}`);
    }
  };
  const newWriter = (session, prefix, ext) => {
    const dir = perfDirFor(userDataDir(), session.taskId);
    if (!dir) throw new BrowserError("INTERNAL", "无法确定任务目录（userData 或 taskId 不可用），不能保存性能数据");
    try {
      return createCappedWriter({ fs, dir, prefix, ext, now: nowDate(), nowMs: nowDate().getTime(), keep: limits.keepFiles, maxAgeMs: limits.maxAgeMs });
    } catch (err) {
      throw new BrowserError("INTERNAL", `无法创建性能数据文件：${errMsg(err)}`);
    }
  };

  /** 会话级私有状态：trace / coverage 各至多一个；dispose = 会话销毁时的收尾 */
  const stateOf = (session) =>
    session.getExt(EXT_KEY, () => {
      const st = {
        trace: null,
        lastTrace: null,
        coverage: null,
        heapBusy: false,
        heapWriter: null,
        perfTabs: new Map(),
        disposed: false,
        dispose() {
          st.disposed = true;
          for (const t of st.perfTabs.values()) void t.send("Performance.disable", {}, null, 3000).catch(() => {});
          st.perfTabs.clear();
          st.heapWriter?.abort();
          if (st.trace) abortTrace(st, "会话结束");
          if (st.coverage) abortCoverage(st, "会话结束");
        },
      };
      return st;
    });

  // ── trace ──

  const abortTrace = (st, why) => {
    const tr = st.trace;
    if (!tr || tr.aborted) return;
    tr.aborted = true;
    tr.abortReason = why;
    clearTimeout(tr.timer);
    // 正在读流落盘的：立刻同步关 fd 并删 tmp（读取循环下一轮会因 aborted / 写入器已关闭而退出），不等异步循环自己发现
    tr.writer?.abort();
    // 还没进入 stop 的 trace：浏览器里的缓冲丢掉就行（尽力 Tracing.end，tab 已销毁会失败，忽略）；磁盘上此时没有文件
    if (!tr.finalizing) {
      tr.off();
      st.trace = null;
      void tr.tab.send("Tracing.end", {}, null, 3000).catch(() => {});
    }
    // 已经在 finalize 的：读取循环每块检查 aborted，会 abort 写入器（删 tmp）并抛 CANCELLED，finally 里清状态
  };

  const finalizeTrace = (st, tr, auto) => {
    if (tr.finalizing) return tr.finalizing;
    clearTimeout(tr.timer);
    tr.finalizing = (async () => {
      const started = tr.startedAt;
      try {
        try {
          await tr.tab.send("Tracing.end", {}, null, 20_000);
        } catch (err) {
          throw new BrowserError("INTERNAL", `结束性能录制失败：${errMsg(err)}`);
        }
        const done = await Promise.race([
          tr.complete.promise,
          new Promise((_, rej) => {
            const t = setTimeout(() => rej(new BrowserError("TIMEOUT", "等待 trace 数据超时（60 秒）")), 60_000);
            t.unref?.();
            tr.complete.promise.finally(() => clearTimeout(t)).catch(() => {});
          }),
        ]);
        if (!done?.stream) throw new BrowserError("INTERNAL", "浏览器没有返回 trace 数据流（可能是该标签页不支持 Tracing）");
        const writer = newWriter(tr.session, "trace", ".json");
        tr.writer = writer;
        const res = await readTraceStream({
          tab: tr.tab,
          handle: done.stream,
          writer,
          limits,
          isCancelled: () => tr.aborted || st.disposed,
          isAppUrl,
        });
        return { ...res, tabId: tr.tabId, preset: tr.preset, recordedMs: Math.max(0, nowDate().getTime() - started), auto: auto === true, dataLoss: done.dataLossOccurred === true };
      } finally {
        tr.off();
        tr.offDestroy?.();
        clearTimeout(tr.timer);
        if (st.trace === tr) st.trace = null;
      }
    })();
    // 没人 await 时（自动结束）不能产生 unhandledRejection
    tr.finalizing.catch(() => {});
    return tr.finalizing;
  };

  const startTrace = async (session, ctx, a) => {
    const st = stateOf(session);
    if (st.trace) {
      const secs = Math.round((nowDate().getTime() - st.trace.startedAt) / 1000);
      throw new BrowserError("BAD_ARGS", `这个会话已经有一个性能录制在进行（标签页 ${st.trace.tabId}，已录 ${secs} 秒）：先 browser_perf stop_trace 结束它，再开新的`);
    }
    const tab = ctx.tab;
    ctx.check();
    await tab.ensureCdp();
    const complete = {};
    complete.promise = new Promise((resolve) => {
      complete.resolve = resolve;
    });
    const off = tab.onCdpEvent((method, params, sid) => {
      if (method === "Tracing.tracingComplete" && !sid) complete.resolve(params ?? {});
    });
    const preset = a.preset && TRACE_PRESETS[a.preset] ? a.preset : "default";
    try {
      await tab.send(
        "Tracing.start",
        {
          traceConfig: { recordMode: "recordUntilFull", includedCategories: [...TRACE_PRESETS[preset]] },
          transferMode: "ReturnAsStream",
          streamFormat: "json",
          streamCompression: "none",
        },
        null,
        15_000,
      );
    } catch (err) {
      off();
      throw new BrowserError("INTERNAL", `无法开始性能录制：${errMsg(err)}`);
    }
    const tr = { session, tab, tabId: tab.id, preset, startedAt: nowDate().getTime(), complete, off, offDestroy: null, timer: null, aborted: false, finalizing: null };
    st.trace = tr;
    st.lastTrace = null;
    tr.offDestroy = tab.addDestroyHook(() => abortTrace(st, "标签页关闭"));
    // 时长上限：到点自动结束并落盘，结果留给下一次 stop_trace
    tr.timer = setTimeout(() => {
      if (st.trace !== tr || tr.finalizing) return;
      logActivity(session, tab, "性能录制到时长上限，已自动结束", "download");
      finalizeTrace(st, tr, true).then(
        (res) => {
          if (!st.disposed) st.lastTrace = { res };
          if (!st.disposed) logActivity(session, tab, `自动保存了 trace ${savedAt(res.file)}（任务目录内）`, "download", 400);
        },
        (err) => {
          if (!st.disposed) st.lastTrace = { err };
        },
      );
    }, limits.traceMaxMs);
    tr.timer.unref?.();
    ctx.describe({ kind: "select", label: "开始性能录制", summary: `开始了性能录制（${preset}）` });
    schedule(session.taskId);
    return { action: "start_trace", tabId: tab.id, preset, maxSeconds: Math.round(limits.traceMaxMs / 1000), maxMB: Math.round(limits.traceMaxBytes / 1048576) };
  };

  const stopTrace = async (session, ctx) => {
    const st = stateOf(session);
    const tr = st.trace;
    if (!tr) {
      const last = st.lastTrace;
      if (last) {
        st.lastTrace = null;
        if (last.err) throw last.err;
        return { action: "stop_trace", ...publicTraceResult(last.res), auto: true };
      }
      throw new BrowserError("BAD_ARGS", "没有进行中的性能录制：先 browser_perf start_trace");
    }
    ctx.describe({ kind: "download", label: "结束性能录制", summary: "结束了性能录制并保存 trace" });
    ctx.check();
    const res = await finalizeTrace(st, tr, false);
    st.lastTrace = null;
    // R6-02：trace 里的请求 URL 带 query 令牌——结果体里不回显绝对路径；R6-34：活动日志同样只写 browser-traces/文件名
    ctx.describe({ kind: "download", summary: `结束了性能录制并保存 trace ${savedAt(res.file)}（${Math.round(res.bytes / 1024)}KB，任务目录内）` });
    schedule(session.taskId);
    return { action: "stop_trace", ...publicTraceResult(res) };
  };

  // ── metrics ──

  const metrics = async (session, ctx) => {
    const tab = ctx.tab;
    ctx.check();
    await tab.ensureCdp();
    ctx.describe({ kind: "select", label: "读取性能指标", summary: "读取了页面性能指标" });
    // Performance 域的计数 / 耗时类指标（布局次数、脚本耗时…）是「自 enable 起」累计的，堆 / DOM 节点是绝对值。
    // 所以第一次 metrics 只给绝对值，并让该标签页保持开启；再调一次才有「两次调用之间」的计数（标签页关闭 / 会话销毁时收尾）。
    const st = stateOf(session);
    const first = !st.perfTabs.has(tab.id);
    await tab.send("Performance.enable", {}, null, 8000);
    if (first) {
      st.perfTabs.set(tab.id, tab);
      tab.addDestroyHook(() => st.perfTabs.delete(tab.id));
    }
    const r = await tab.send("Performance.getMetrics", {}, null, 8000);
    const human = humanizeMetrics(r?.metrics);
    if (first) {
      for (const k of COUNTER_KEYS) delete human[k];
    }
    return { action: "metrics", tabId: tab.id, first, metrics: human };
  };

  // ── heap snapshot ──

  const heapSnapshot = async (session, ctx, a) => {
    const st = stateOf(session);
    if (st.heapBusy) throw new BrowserError("BAD_ARGS", "上一个堆快照还在进行，等它结束再试");
    const tab = ctx.tab;
    ctx.check();
    await tab.ensureCdp();
    const writer = newWriter(session, "heap", ".heapsnapshot");
    st.heapBusy = true;
    st.heapWriter = writer;
    let overflow = false;
    let writeError = null;
    const off = tab.onCdpEvent((method, params, sid) => {
      if (method !== "HeapProfiler.addHeapSnapshotChunk" || sid || overflow || writeError) return;
      const chunk = params?.chunk;
      if (typeof chunk !== "string") return;
      try {
        writer.write(chunk);
      } catch (err) {
        writeError = err;
        return;
      }
      if (writer.bytes > limits.heapMaxBytes) overflow = true;
    });
    let saved;
    try {
      ctx.describe({ kind: "download", label: "保存堆快照", summary: "保存了页面堆快照" });
      await tab.send("HeapProfiler.enable", {}, null, 10_000);
      try {
        if (a.gc) await tab.send("HeapProfiler.collectGarbage", {}, null, 30_000);
        await tab.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false }, null, 180_000);
      } finally {
        void tab.send("HeapProfiler.disable", {}, null, 3000).catch(() => {});
      }
      if (writeError) throw new BrowserError("INTERNAL", `写入堆快照失败：${errMsg(writeError)}`);
      if (overflow) {
        throw new BrowserError("INTERNAL", `堆快照超过 ${Math.round(limits.heapMaxBytes / 1048576)}MB 上限，已中止并删除。页面堆太大：先关掉无关内容或用 browser_perf metrics 看堆大小`);
      }
      ctx.check();
      saved = writer.commit();
    } catch (err) {
      writer.abort();
      throw err;
    } finally {
      off();
      st.heapBusy = false;
      st.heapWriter = null;
    }
    let summary = null;
    let summaryNote;
    if (saved.bytes > limits.heapSummaryMaxBytes) {
      summaryNote = `快照 ${Math.round(saved.bytes / 1048576)}MB 超过 ${Math.round(limits.heapSummaryMaxBytes / 1048576)}MB 摘要上限，只保存了文件，没有构造函数统计`;
    } else {
      try {
        const s = await summarizeHeapFile({ fs, filePath: saved.path, topN: a.topN ?? 12, isCancelled: () => ctx.signal?.aborted === true || st.disposed, chunk: limits.readChunk });
        if (s.ok) summary = redactHeapSummary(s);
        else summaryNote = `快照已保存，但摘要解析失败：${s.error}`;
      } catch (err) {
        if (err instanceof BrowserError) throw err;
        summaryNote = `快照已保存，但摘要解析失败：${errMsg(err)}`;
      }
    }
    // R6-02：结果体里只给文件名 + 任务目录里的子目录名 + 大小——模型自带 shell / 读文件工具，给了路径就等于给了读整页堆的入口。
    // R6-34：活动日志里也不写绝对路径。「AI 条目不会回流给模型」只对 browser_user_activity / handback（只取 user / system 条目）成立；
    // 录制期间的 AI 条目会成为 `record stop` 的 ai-action 标记，`export_activity` 也会导出 AI 条目——所以只写 browser-traces/文件名
    logActivity(session, tab, `保存了页面堆快照 ${savedAt(saved.file)}（${Math.round(saved.bytes / 1024)}KB，任务目录内）`, "download", 400);
    schedule(session.taskId);
    return { action: "heap_snapshot", tabId: tab.id, file: saved.file, dir: PERF_DIR_NAME, bytes: saved.bytes, summary, ...(summaryNote ? { summaryNote } : {}) };
  };

  /**
   * R6-02：堆快照含页面内存里的全部字符串（密码框的值、令牌、用户接管时手输的验证码），等价于 evaluate 且旁路 secret-field，
   * 所以与 debug scope 同口径先过 evaluate 审批（总闸开着免审批；拒绝 / 超时 → DENIED，此时还没创建任何文件）。
   * 放在 runAction 之外：审批最长等 2 分钟，不占动作队列 / 面板锁；批准后 runAction 里仍会做接管校验。
   */
  const approveHeapSnapshot = async (session, a, signal) => {
    if (session.controller === "user") {
      throw new BrowserError("USER_CONTROL", "用户正在接管浏览器，AI 的动作被拒绝。请结束本轮、或调用 ask_user_to_act 请用户协助，等用户点「交还给 AI」后再继续");
    }
    const tab = session.getTab(a.tabId);
    await ensureEvaluateApproval(session, {
      summary: "[性能·堆快照] 堆快照包含页面内存中的全部数据（含你手输的验证码 / 令牌），仅在本机任务目录保存",
      signal,
      tabId: tab.id,
      host: deps.hostLabel?.(tab.url),
      ...(Number.isFinite(deps.electron?.evaluatePromptTimeoutMs) && deps.electron.evaluatePromptTimeoutMs > 0 ? { timeoutMs: deps.electron.evaluatePromptTimeoutMs } : {}),
    });
  };

  // ── coverage ──

  const abortCoverage = (st, why) => {
    const cv = st.coverage;
    if (!cv) return;
    st.coverage = null;
    clearTimeout(cv.timer);
    cv.off?.();
    cv.offDestroy?.();
    cv.abortReason = why;
    // 尽力停掉（tab 已销毁会失败）：不让 Profiler 的精确覆盖 / CSS 规则追踪一直开着拖慢页面
    if (cv.js) {
      void cv.tab.send("Profiler.stopPreciseCoverage", {}, null, 3000).catch(() => {});
      void cv.tab.send("Profiler.disable", {}, null, 3000).catch(() => {});
    }
    if (cv.css) void cv.tab.send("CSS.stopRuleUsageTracking", {}, null, 3000).catch(() => {});
  };

  const coverageStart = async (session, ctx, a) => {
    const st = stateOf(session);
    if (st.coverage) throw new BrowserError("BAD_ARGS", `覆盖率已经在标签页 ${st.coverage.tabId} 上进行：先 coverage_stop`);
    const tab = ctx.tab;
    ctx.check();
    await tab.ensureCdp();
    const sheets = new Map();
    const off = tab.onCdpEvent((method, params, sid) => {
      if (sid) return;
      if (method === "CSS.styleSheetAdded") {
        const h = params?.header;
        if (h && typeof h.styleSheetId === "string") sheets.set(h.styleSheetId, { styleSheetId: h.styleSheetId, url: typeof h.sourceURL === "string" ? h.sourceURL : "", length: h.length });
      }
    });
    const cv = { session, tab, tabId: tab.id, js: a.js !== false, css: a.css !== false, sheets, off, offDestroy: null, timer: null };
    try {
      if (cv.js) {
        await tab.send("Profiler.enable", {}, null, 8000);
        await tab.send("Profiler.startPreciseCoverage", { callCount: false, detailed: false }, null, 8000);
      }
      if (cv.css) {
        await tab.send("DOM.enable", {}, null, 8000);
        await tab.send("CSS.enable", {}, null, 8000);
        await tab.send("CSS.startRuleUsageTracking", {}, null, 8000);
      }
    } catch (err) {
      st.coverage = cv; // 借 abortCoverage 统一回滚
      abortCoverage(st, "启动失败");
      throw new BrowserError("INTERNAL", `无法开始覆盖率统计：${errMsg(err)}`);
    }
    st.coverage = cv;
    cv.offDestroy = tab.addDestroyHook(() => abortCoverage(st, "标签页关闭"));
    cv.timer = setTimeout(() => abortCoverage(st, "超时"), limits.coverageMaxMs);
    cv.timer.unref?.();
    ctx.describe({ kind: "select", label: "开始覆盖率统计", summary: `开始了${cv.js ? "JS" : ""}${cv.js && cv.css ? " + " : ""}${cv.css ? "CSS" : ""} 覆盖率统计` });
    schedule(session.taskId);
    return { action: "coverage_start", tabId: tab.id, js: cv.js, css: cv.css };
  };

  const coverageStop = async (session, ctx, a) => {
    const st = stateOf(session);
    const cv = st.coverage;
    if (!cv) throw new BrowserError("BAD_ARGS", "没有进行中的覆盖率统计：先 browser_perf coverage_start（想统计整个加载过程就在它之后再 navigate / reload）");
    const tab = cv.tab;
    ctx.check();
    ctx.describe({ kind: "select", label: "结束覆盖率统计", summary: "结束了覆盖率统计" });
    // 先摘掉 st.coverage：后续任何一步失败也不会留下「永远在统计」的状态
    st.coverage = null;
    clearTimeout(cv.timer);
    cv.off();
    cv.offDestroy?.();
    const topN = a.topN ?? 10;
    const out = { action: "coverage_stop", tabId: tab.id };
    const warns = [];
    if (cv.js) {
      try {
        const r = await tab.send("Profiler.takePreciseCoverage", {}, null, 30_000);
        out.js = redactCoverage(summarizeJsCoverage(r?.result, { topN, isAppUrl }));
      } catch (err) {
        warns.push(`JS 覆盖率不可用：${errMsg(err)}（页面可能已换了渲染进程，如跨站导航；请在目标页面加载后再 coverage_start）`);
      }
      void tab.send("Profiler.stopPreciseCoverage", {}, null, 3000).catch(() => {});
      void tab.send("Profiler.disable", {}, null, 3000).catch(() => {});
    }
    if (cv.css) {
      try {
        const r = await tab.send("CSS.stopRuleUsageTracking", {}, null, 30_000);
        out.css = redactCoverage(summarizeCssCoverage([...cv.sheets.values()], r?.ruleUsage, { topN, isAppUrl }));
      } catch (err) {
        warns.push(`CSS 覆盖率不可用：${errMsg(err)}`);
      }
    }
    if (warns.length > 0) out.warnings = warns;
    if (!out.js && !out.css) throw new BrowserError("INTERNAL", warns.join("；") || "覆盖率统计没有产出数据");
    schedule(session.taskId);
    return out;
  };

  // ── dispatch ──

  const perf = async (taskId, a, signal) => {
    const session = requireSession(taskId);
    // stop_trace / coverage_stop 不依赖「当前 tab」：它们作用在开始时的那个 tab（可能已不是活动 tab）；但仍走 runAction 保证串行 / 接管校验。
    // runAction 的 needsTab 默认 true 会校验 tabId：这两个 action 在 tab 已关闭时也要能返回「没有进行中的…」的明确错误，所以不要求 tab
    const needsTab = a.action !== "stop_trace" && a.action !== "coverage_stop";
    if (a.action === "heap_snapshot") await approveHeapSnapshot(session, a, signal);
    return session.runAction({ op: "perf", tabId: a.tabId, needsTab, signal }, async (ctx) => {
      switch (a.action) {
        case "start_trace":
          return startTrace(session, ctx, a);
        case "stop_trace":
          return stopTrace(session, ctx);
        case "metrics":
          return metrics(session, ctx);
        case "heap_snapshot":
          return heapSnapshot(session, ctx, a);
        case "coverage_start":
          return coverageStart(session, ctx, a);
        case "coverage_stop":
          return coverageStop(session, ctx, a);
        default:
          throw new BrowserError("BAD_ARGS", `未知的 perf action：${String(a.action).slice(0, 30)}`);
      }
    });
  };

  return { perf };
};
