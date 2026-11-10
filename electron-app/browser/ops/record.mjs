/**
 * 增强包 E2 · B7 录制（start / stop / status / export / export_activity）
 *
 * 纯逻辑（上限判定 / recId 与路径前缀校验 / 清理策略 / 时间线 / ffmpeg 固定参数 / 页内敏感探针 / 活动日志导出渲染）在 ../record-policy.mjs；
 * 本文件把它们接到 tab / session，并负责落盘。
 *
 *  - **只有 AI 显式 start 才开始**；同会话同时只有一个录制；面板 `RecordingBar` 经状态贡献者 `recording:{frames,startedAt}` 始终可见，
 *    用户随时可点「停止」（`registerExt("record.stop")`，接管期间也可用——停止录制不是 AI 动作）；
 *  - **帧**：`Page.startScreencast`（jpeg）→ 每帧**处理完才** `Page.screencastFrameAck`（无论写没写都 ack，否则 Chromium 停发；晚 ack 顺带
 *    给了背压）。帧串行处理，所以「探针 → 写盘」之间不会被别的帧插队；
 *  - **敏感字段（比截图更保守）**：截图通路没有像素遮罩，录制每帧在写盘前先跑一次页内探针（`SECRET_VISIBLE_PROBE_SOURCE`，规则与 snapshot / type
 *    同源 `secret-field.mjs`，对主会话与每个 OOPIF 子会话各跑一次）：视口里有可见 / 聚焦的敏感输入框 → 这一帧**不写盘**，时间线记 `redacted-gap`；
 *    探针本身失败 / 超时（导航中、页面卡死）同样不写（fail-closed）。Flowship 自身 origin 的页面也不写；
 *  - **写盘红线（§15.3-8）**：`<userData>/data/tasks/<taskId>/browser-recordings/<recId>/frame-NNNN.jpg`（目录 0700、文件 0600，recId 主进程生成），
 *    600 帧 / 60 秒 / 150MB 到限自动停；timeline.json 先写 `.tmp` 再 rename；保留最近 5 个录制 / ≤500MB，清理只动形如 recId 的真目录；
 *  - **收尾全是同步的**（`finalize`）：停止 / 到限 / tab 关闭 / 会话销毁都走它——摘监听、`Page.stopScreencast`（尽力）、收集活动日志标记、写 timeline.json。
 *    在途的帧处理在探针之后会再看一次 `stopped`，所以不会在收尾后再写文件；
 *  - 不走 runAction 的 stop / status / export*：它们不碰页面主线程；`start` 走 runAction（串行 / AI 归因 / 接管时 USER_CONTROL / 活动日志）。
 */
import nodeChildProcess from "node:child_process";
import nodeCrypto from "node:crypto";
import nodeFs from "node:fs";
import nodePath from "node:path";
import { probeFocusSecretCdp } from "../closed-shadow.mjs";
import { redactUrlSecrets } from "../net-detail.mjs";
import { fsErrorText, scrubPaths } from "../path-scrub.mjs";
import {
  ACTIVITY_FORMATS,
  EXPORT_DIR_NAME,
  EXPORT_FORMATS,
  RECORD_ACTIONS,
  RECORD_LIMITS,
  SECRET_VISIBLE_PROBE_SOURCE,
  STOP_REASON_TEXT,
  buildFfmpegArgs,
  buildTimeline,
  clampStartArgs,
  entriesToMarkers,
  evaluateLimits,
  exportsRootFor,
  ffmpegCandidates,
  frameFileName,
  framesFps,
  isValidRecId,
  makeRecId,
  mergeVerdicts,
  probeHasVisibleOpaque,
  readProbeVerdict,
  recStamp,
  recordingsRootFor,
  renderActivityExport,
  resolveRecDir,
  selectRecordingsToPrune,
  summarizeTimeline,
  toExportEntry,
} from "../record-policy.mjs";
import { ensureSafeDir } from "../safe-dir.mjs";
import { BrowserError } from "../server-channel.mjs";
import { redactAndClip } from "../text-redact.mjs";

export const OPS = Object.freeze(["record"]);

export const normalize = (op, args, h) => {
  switch (op) {
    case "record": {
      const action = h.reqEnum(args, "action", RECORD_ACTIONS);
      const out = { action };
      if (action === "start") {
        out.maxFrames = h.optNum(args, "maxFrames", { min: 1, max: RECORD_LIMITS.maxFrames, dflt: RECORD_LIMITS.maxFrames });
        out.quality = h.optNum(args, "quality", { min: 20, max: 90, dflt: 60 });
        out.everyNth = h.optNum(args, "everyNth", { min: 1, max: 60, dflt: 6 });
      }
      if (action === "export") {
        out.format = h.optEnum(args, "format", EXPORT_FORMATS, "frames");
        const recId = h.optStr(args, "recId", 64);
        if (recId !== undefined) {
          if (!isValidRecId(recId)) throw h.bad("recId 形状不对：只能用 browser_record start / stop 返回的 rec-YYYYMMDD-HHmmss-xxxxxx，不接受路径");
          out.recId = recId;
        }
      }
      if (action === "export_activity") out.format = h.optEnum(args, "format", ACTIVITY_FORMATS, "json");
      return h.withTab(args, out);
    }
    default:
      throw h.bad(`未实现的浏览器操作：${String(op).slice(0, 40)}`);
  }
};

const unixMode = () => process.platform !== "win32";
const clipText = (s, n) => redactAndClip(String(s ?? ""), n).text;
const EXT_KEY = "record";
const MAX_TIMELINE_READ = 8 * 1024 * 1024;
const MARKERS_IN_RESULT = 40;
/** 敏感框消失后继续丢弃的帧数（见 handleFrame 的「冷却」注释） */
const COOLDOWN_FRAMES = 2;

// R6-15：目录走共享的 ensureSafeDir（lstat 逐级拒符号链接 / 属主 / 0700 / 必须在任务目录下）。
// R6-37：label 由调用方给（录制根 `browser-recordings`、导出目录 `browser-exports`——此前硬编码成 browser-recordings，导出目录出错时文案张冠李戴）；
// `root` 缺省取 dir 的父目录（任务目录）；`create: false` 用于「导出已有录制」：目录不存在就报 ENOENT，不顺手建出一个空目录
const ensureDir = (fs, dir, label, { root, create = true } = {}) => ensureSafeDir(dir, { fs, root, label, create });

/** 带 0600 的写文件（wx：不覆盖已有；部分写入会循环写完） */
const writeFile600 = (fs, file, buf) => {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    if (unixMode()) fs.fchmodSync(fd, 0o600);
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off, off);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* 已关 */
    }
  }
};

/** tmp(0600) → rename：最终文件名下永远不会有半截文件 */
const writeAtomic600 = (fs, finalPath, text) => {
  const tmp = nodePath.join(nodePath.dirname(finalPath), `.${nodePath.basename(finalPath)}.${process.pid}.${nodeCrypto.randomBytes(3).toString("hex")}.tmp`);
  try {
    writeFile600(fs, tmp, Buffer.from(text, "utf8"));
    fs.renameSync(tmp, finalPath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 留给下次清理 */
    }
    throw err;
  }
};

const dirBytes = (fs, dir) => {
  let total = 0;
  try {
    for (const n of fs.readdirSync(dir)) {
      try {
        const st = fs.lstatSync(nodePath.join(dir, n));
        if (st.isFile()) total += st.size;
      } catch {
        /* 刚被删 */
      }
    }
  } catch {
    /* 目录没了 */
  }
  return total;
};

/** 保留策略：只动 root 下形如 recId 的真目录（lstat，符号链接不算）；删除前再做一次路径前缀校验。返回删掉的目录名 */
export const pruneRecordings = ({ fs = nodeFs, root, keep, maxTotalBytes, protect = [] }) => {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!isValidRecId(name)) continue;
    const dir = resolveRecDir(root, name);
    if (!dir) continue;
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      entries.push({ name, mtimeMs: st.mtimeMs, bytes: dirBytes(fs, dir) });
    } catch {
      /* 刚被删 */
    }
  }
  const removed = [];
  for (const name of selectRecordingsToPrune(entries, { keep, maxTotalBytes, protect })) {
    const dir = resolveRecDir(root, name);
    if (!dir) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* 删不掉下次再说 */
    }
  }
  return removed;
};

const newestRecId = (fs, root) => {
  let best = null;
  try {
    for (const name of fs.readdirSync(root)) {
      if (!isValidRecId(name)) continue;
      const dir = resolveRecDir(root, name);
      if (!dir) continue;
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if (!best || st.mtimeMs > best.t) best = { name, t: st.mtimeMs };
    }
  } catch {
    return null;
  }
  return best?.name ?? null;
};

/** 在 PATH 里找可执行的 ffmpeg（只认绝对路径项；不经 shell / which） */
export const findFfmpeg = ({ fs = nodeFs, env = process.env, platform = process.platform } = {}) => {
  const pathEnv = env.PATH ?? env.Path ?? "";
  for (const p of ffmpegCandidates(pathEnv, platform)) {
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      if (platform !== "win32") fs.accessSync(p, nodeFs.constants.X_OK);
      return { path: p, pathEnv };
    } catch {
      /* 不存在 / 不可执行：下一个 */
    }
  }
  return null;
};

/**
 * @param {object} deps  index.mjs 的 createExtraHandlers 依赖（契约 §15.1）；测试可额外注入 `fs` / `now` / `recordLimits` / `env` / `execFile`
 */
export const createHandlers = (deps) => {
  const { requireSession, scheduleState } = deps;
  const fs = deps.fs ?? nodeFs;
  // 测试用上限覆盖：单测直接传 `deps.recordLimits`；真机 e2e 经 createBrowserManager({ recordLimits }) 透传到 `deps.electron`。生产的 main.js 不传
  const limits = { ...RECORD_LIMITS, ...(deps.electron?.recordLimits ?? {}), ...(deps.recordLimits ?? {}) };
  const nowMs = () => (typeof deps.now === "function" ? Number(deps.now()) : Date.now());
  const isAppUrl = (u) => {
    try {
      return deps.electron?.isAppUrl?.(u) === true;
    } catch {
      return false;
    }
  };
  const userDataDir = () => {
    try {
      return deps.app?.getPath?.("userData") ?? "";
    } catch {
      return "";
    }
  };
  // R6-34：进错误文案 / 结果 / 日志的错误一律经 errMsg（fs 错误只留 errno 码 + 释义 + 系统调用 + 文件名，其它 message 里的本机路径被剔除）；
  // 活动日志文字（时间线标记 / export_activity）出站前过 scrubClip：先剔除 userData / 家目录 / 常见绝对路径，再脱敏截断。perf 已不往活动日志写路径，这是第二道防线
  const errMsg = (err) => fsErrorText(err, { roots: [userDataDir()], max: 160 });
  const scrubClip = (s, n) => clipText(scrubPaths(s, { roots: [userDataDir()] }), n);
  const schedule = (taskId) => {
    try {
      scheduleState?.(taskId);
    } catch {
      /* 状态推送失败不影响结果 */
    }
  };
  const logAi = (session, tab, summary, kind = "select") => {
    try {
      session.activityLog.addAI({ kind, tabId: tab?.id ?? session.activeTabId ?? "", url: tab?.url ?? "", summary: clipText(summary, 150) });
      schedule(session.taskId);
    } catch (err) {
      deps.log?.(`[browser] 录制的活动日志写入失败：${err?.message || err}`);
    }
  };
  const logSystem = (session, tab, summary) => {
    try {
      session.activityLog.addSystem({ kind: "select", tabId: tab?.id ?? session.activeTabId ?? "", url: tab?.url ?? "", summary: clipText(summary, 150) });
      schedule(session.taskId);
    } catch (err) {
      deps.log?.(`[browser] 录制的活动日志写入失败：${err?.message || err}`);
    }
  };

  /** 会话级私有状态；dispose = 会话销毁时的收尾（同步） */
  const stateOf = (session) =>
    session.getExt(EXT_KEY, () => {
      const st = {
        active: null,
        /** 最近一次结束（用户停止 / 到限 / tab 关闭）的结果：下一次 stop 取走；rec 目录信息用于 export 默认值 */
        pending: null,
        lastRecId: null,
        dispose() {
          if (st.active) finalize(session, st, st.active, "session_closed");
          st.pending = null;
        },
      };
      return st;
    });

  // ── 敏感字段探针 ──

  const probeSecret = async (rec) => {
    const tab = rec.tab;
    const evalIn = (sid) =>
      tab.send("Runtime.evaluate", { expression: SECRET_VISIBLE_PROBE_SOURCE, returnByValue: true, silent: true, includeCommandLineAPI: false }, sid, limits.probeTimeoutMs);
    // R6-06：本帧探针里「可见且读不进去的内嵌框架」标记（主会话或任一子会话命中）；handleFrame 据此记 skippedOpaque / 活动日志
    rec.opaqueHit = false;
    let main = "unknown";
    try {
      const raw = await evalIn(null);
      main = readProbeVerdict(raw);
      if (probeHasVisibleOpaque(raw)) rec.opaqueHit = true;
    } catch {
      main = "unknown";
    }
    let sids = [];
    try {
      sids = (tab.cdpSessionIds?.() ?? []).filter((s) => s !== null);
    } catch {
      sids = [];
    }
    const children = await Promise.all(
      sids.map(async (sid) => {
        try {
          const raw = await evalIn(sid);
          // 子会话里的 opaque 框架同样看不见内容；子会话的 unknown 在 mergeVerdicts 里本来被忽略（子会话随时会销毁），这里不能让 opaque 跟着被忽略
          if (probeHasVisibleOpaque(raw)) {
            rec.opaqueHit = true;
            return "unknown";
          }
          return readProbeVerdict(raw);
        } catch {
          return "unknown";
        }
      }),
    );
    let merged = mergeVerdicts(main, children);
    if (merged === "safe" && rec.opaqueHit) merged = "unknown";
    if (merged !== "safe") return merged;
    // 页内探针只认 open shadow root：焦点在 closed shadow root 里的密码框它看不见 → 再用 CDP 穿透复核主页面焦点（只升级不降级；出错 = unknown = 该帧不写盘）。
    // 仅「聚焦」的 closed 密码框能被挡；「可见但未聚焦」的 closed 密码框与既有截图同口径（浏览器自己的圆点渲染），见 §15 残余风险
    try {
      return mergeVerdicts(merged, await probeFocusSecretCdp(tab, null));
    } catch {
      return "unknown";
    }
  };

  // ── 帧处理 ──

  const openGap = (rec, t, reason) => {
    if (!rec.gap) rec.gap = { t, endT: t, skipped: 0, reason };
    rec.gap.skipped += 1;
    rec.gap.endT = t;
    // 同一段里原因只从「探针失败」升级成更具体的原因；已经有具体原因的不改（冷却帧一律记成 secret-field，不能盖掉 app-origin）
    if (rec.gap.reason === "probe-unknown" && reason !== "probe-unknown") rec.gap.reason = reason;
  };
  const closeGap = (rec) => {
    if (!rec.gap) return;
    rec.gaps.push(rec.gap);
    rec.gap = null;
  };

  const handleFrame = async (session, st, rec, params, arrivedAt) => {
    if (rec.stopped) return;
    const elapsed = nowMs() - rec.startedAt;
    const hit = evaluateLimits({ frames: rec.frames.length, bytes: rec.bytes, elapsedMs: elapsed, maxFrames: rec.maxFrames }, limits);
    if (hit) {
      autoStop(session, st, rec, hit.reason);
      return;
    }
    let verdict;
    let reason = "secret-field";
    // R6-06：本帧是否因「可见且读不进去的内嵌框架」被丢（只在直接判成 unknown 时算；冷却帧 / 排队帧不算）
    let opaqueSkip = false;
    if (isAppUrl(rec.tab.url)) {
      verdict = "secret";
      reason = "app-origin";
    } else {
      verdict = await probeSecret(rec);
      if (verdict === "unknown") {
        opaqueSkip = rec.opaqueHit === true;
        reason = opaqueSkip ? "opaque-frame" : "probe-unknown";
      }
    }
    // 探针期间可能已经被停止 / tab 关闭：不能在收尾之后再写文件
    if (rec.stopped) return;
    const t = nowMs() - rec.startedAt;
    // 排队的帧：它在最近一次「非 safe」探针结束之前就已到达，抓取时刻更早，那时敏感框很可能还在——即使现在探针说 safe（框刚消失）也不能写
    if (verdict === "safe" && arrivedAt <= rec.secretUntil) {
      verdict = "secret";
      reason = "secret-field";
    }
    // 冷却：敏感框消失后的头 COOLDOWN_FRAMES 帧也不写。Chromium 最多放 2 帧在途（我们处理完才 ack），这两帧可能抓取于框消失之前、
    // 探针却在框消失之后才跑 → 会把刚刚还可见的密码圆点写盘（真机 e2e 实测抓到过）；第 3 帧一定是在探针看到 safe 之后才抓的
    if (verdict === "safe" && rec.cooldown > 0) {
      rec.cooldown -= 1;
      verdict = "secret";
      reason = "secret-field";
    } else if (verdict !== "safe") {
      rec.cooldown = COOLDOWN_FRAMES;
    }
    if (verdict !== "safe") {
      rec.secretUntil = nowMs();
      openGap(rec, t, reason);
      if (opaqueSkip) {
        rec.skippedOpaque = (rec.skippedOpaque ?? 0) + 1;
        // 每段暂停只提示一次（不逐帧刷屏）；文案固定、不含页面内容 / URL
        if (!rec.opaqueNoted) {
          rec.opaqueNoted = true;
          logSystem(session, rec.tab, "录制暂停：存在无法检查的内嵌框架");
        }
      }
      return;
    }
    rec.opaqueNoted = false;
    closeGap(rec);
    const data = params?.data;
    if (typeof data !== "string" || data.length === 0) return;
    const buf = Buffer.from(data, "base64");
    // 只收 JPEG（魔数 FF D8 FF）且单帧不超限：别的内容不落盘
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff || buf.length > limits.maxFrameBytes) return;
    if (rec.bytes + buf.length > limits.maxBytes) {
      autoStop(session, st, rec, "max_bytes");
      return;
    }
    const n = rec.frames.length + 1;
    const file = frameFileName(n);
    try {
      writeFile600(fs, nodePath.join(rec.dir, file), buf);
    } catch (err) {
      deps.log?.(`[browser] 录制写帧失败，已中止录制：${errMsg(err)}`);
      rec.error = errMsg(err);
      autoStop(session, st, rec, "error");
      return;
    }
    rec.frames.push({ n, file, t, bytes: buf.length });
    rec.bytes += buf.length;
    if (nowMs() - rec.lastPush > 400) {
      rec.lastPush = nowMs();
      schedule(session.taskId);
    }
    const after = evaluateLimits({ frames: rec.frames.length, bytes: rec.bytes, elapsedMs: t, maxFrames: rec.maxFrames }, limits);
    if (after) autoStop(session, st, rec, after.reason);
  };

  const onCdp = (session, st, rec) => (method, params, sid) => {
    if (method !== "Page.screencastFrame" || sid || rec.stopped) return;
    const ackId = params?.sessionId;
    // 积压保护：Chromium 自己最多放行几帧在途，这里再兜一层，积压过多的帧直接 ack 丢弃
    if (rec.pending > 8) {
      void rec.tab.send("Page.screencastFrameAck", { sessionId: ackId }, null, 3000).catch(() => {});
      return;
    }
    rec.pending += 1;
    const arrivedAt = nowMs();
    rec.chain = rec.chain
      .then(() => handleFrame(session, st, rec, params, arrivedAt))
      .catch((err) => deps.log?.(`[browser] 录制帧处理出错（已忽略）：${errMsg(err)}`))
      .finally(() => {
        rec.pending -= 1;
        // 无论写没写、有没有收尾都 ack：否则 Chromium 不再发下一帧（tab 已销毁时失败，忽略）
        void rec.tab.send("Page.screencastFrameAck", { sessionId: ackId }, null, 3000).catch(() => {});
      });
  };

  // ── 收尾（同步） ──

  /**
   * 结束录制并写 timeline.json。幂等；所有失败只记日志（收尾路径不能抛）。返回 summary（含 dir / timelineFile）。
   */
  const finalize = (session, st, rec, reason) => {
    if (rec.stopped) return rec.result;
    rec.stopped = true;
    clearTimeout(rec.timer);
    try {
      rec.off?.();
      rec.offDestroy?.();
      rec.offCtl?.();
    } catch {
      /* 取消订阅失败无所谓 */
    }
    // 尽力停掉屏幕录制（tab 已销毁会失败）；不 await：收尾必须同步完成
    void rec.tab.send("Page.stopScreencast", {}, null, 3000).catch(() => {});
    const endedAt = nowMs();
    closeGap(rec);
    if (rec.ctl) {
      rec.userControl.push({ t: rec.ctl.t, endT: endedAt - rec.startedAt });
      rec.ctl = null;
    }
    let markers = [];
    try {
      const entries = session.activityLog.list({ sinceId: rec.activityStartId });
      markers = entriesToMarkers(entries, {
        startedAt: rec.startedAt,
        endedAt,
        frames: rec.frames,
        redactText: scrubClip,
        redactUrl: (u) => clipText(redactUrlSecrets(u), 300),
        max: limits.maxMarkers,
      });
    } catch (err) {
      deps.log?.(`[browser] 录制时间线收集活动日志失败：${errMsg(err)}`);
    }
    const timeline = buildTimeline({
      recId: rec.recId,
      tabId: rec.tabId,
      startedAt: rec.startedAt,
      endedAt,
      stopReason: reason,
      frames: rec.frames,
      markers,
      gaps: rec.gaps,
      userControl: rec.userControl,
      limits: { ...limits, maxFrames: Math.min(limits.maxFrames, rec.maxFrames) },
      params: { quality: rec.quality, everyNth: rec.everyNth },
    });
    const timelineFile = nodePath.join(rec.dir, "timeline.json");
    let timelineError;
    try {
      writeAtomic600(fs, timelineFile, JSON.stringify(timeline, null, 2));
    } catch (err) {
      timelineError = errMsg(err);
      deps.log?.(`[browser] 写 timeline.json 失败：${timelineError}`);
    }
    const summary = {
      ...summarizeTimeline(timeline),
      tabId: rec.tabId,
      dir: rec.dir,
      timelineFile: timelineError ? null : timelineFile,
      stopReasonText: STOP_REASON_TEXT[reason] ?? reason,
      redactedGaps: rec.gaps.length,
      redactedFrames: rec.gaps.reduce((s, g) => s + g.skipped, 0),
      // R6-06：因读不进去的内嵌框架（沙箱 / 同站异源 iframe、嵌套 > 8 层）丢掉的帧数（已含在 redactedFrames 里）
      skippedOpaque: rec.skippedOpaque ?? 0,
      userControlSegments: rec.userControl.length,
      markers: timeline.markers.slice(0, MARKERS_IN_RESULT).map((m) => ({ t: m.t, type: m.type, text: m.text, frame: m.frame })),
      ...(timelineError ? { timelineError } : {}),
    };
    rec.result = summary;
    if (st.active === rec) st.active = null;
    st.lastRecId = rec.recId;
    st.pending = { ...summary, auto: reason !== "stopped" };
    try {
      pruneRecordings({ fs, root: rec.root, keep: limits.keepRecordings, maxTotalBytes: limits.maxTotalBytes, protect: [rec.recId] });
    } catch {
      /* 清理失败不影响结果 */
    }
    schedule(session.taskId);
    return summary;
  };

  const autoStop = (session, st, rec, reason) => {
    if (rec.stopped) return;
    const label = STOP_REASON_TEXT[reason] ?? reason;
    finalize(session, st, rec, reason);
    logAi(session, rec.tab, `录制已结束：${label}`, "download");
  };

  // ── start ──

  const start = async (session, ctx, a) => {
    const st = stateOf(session);
    if (st.active) {
      const secs = Math.round((nowMs() - st.active.startedAt) / 1000);
      throw new BrowserError("BAD_ARGS", `这个会话已经有一个录制在进行（标签页 ${st.active.tabId}，已录 ${secs} 秒、${st.active.frames.length} 帧）：先 browser_record stop 结束它，再开新的`);
    }
    const tab = ctx.tab;
    if (isAppUrl(tab.url)) throw new BrowserError("DENIED", "不能录制 Flowship 自己的界面");
    const root = recordingsRootFor(userDataDir(), session.taskId);
    if (!root) throw new BrowserError("INTERNAL", "无法确定任务目录（userData 或 taskId 不可用），不能保存录制");
    ctx.check();
    await tab.ensureCdp();
    const p = clampStartArgs(a, limits);
    let dir;
    let recId;
    try {
      ensureDir(fs, root, "browser-recordings");
      // 新录制开始前清最旧的：旧的最多留 keep-1 个、总体积给新录制的上限留出余量
      pruneRecordings({ fs, root, keep: Math.max(0, limits.keepRecordings - 1), maxTotalBytes: Math.max(0, limits.maxTotalBytes - limits.maxBytes) });
      recId = makeRecId(new Date(nowMs()), nodeCrypto.randomBytes(3).toString("hex"));
      dir = resolveRecDir(root, recId);
      if (!dir) throw new Error("recId 生成失败");
      fs.mkdirSync(dir, { mode: 0o700 }); // 不 recursive：recId 重名就 EEXIST，绝不复用已有录制目录
      ensureSafeDir(dir, { fs, root, label: "browser-recordings" }); // 创建后再 lstat 复核（属主 / 0700 / 非符号链接）
    } catch (err) {
      throw new BrowserError("INTERNAL", `无法创建录制目录：${errMsg(err)}`);
    }
    let activityStartId = 0;
    try {
      activityStartId = session.activityLog.list({ limit: 1 }).at(-1)?.id ?? 0;
    } catch {
      activityStartId = 0;
    }
    const rec = {
      recId,
      dir,
      root,
      tab,
      tabId: tab.id,
      startedAt: nowMs(),
      maxFrames: p.maxFrames,
      quality: p.quality,
      everyNth: p.everyNth,
      frames: [],
      bytes: 0,
      gaps: [],
      gap: null,
      secretUntil: -1,
      cooldown: 0,
      userControl: [],
      ctl: null,
      activityStartId,
      chain: Promise.resolve(),
      pending: 0,
      lastPush: 0,
      stopped: false,
      error: null,
      timer: null,
      off: null,
      offDestroy: null,
      offCtl: null,
      result: null,
    };
    st.active = rec;
    st.pending = null;
    rec.off = tab.onCdpEvent(onCdp(session, st, rec));
    rec.offDestroy = tab.addDestroyHook(() => {
      if (!rec.stopped) finalize(session, st, rec, "tab_closed");
    });
    // 用户接管：继续录（用户在场、面板可见），但时间线标出这一段，事后能区分「AI 的操作」与「用户的操作」
    rec.offCtl = session.onControllerChange?.((next) => {
      if (rec.stopped) return;
      if (next === "user" && !rec.ctl) rec.ctl = { t: nowMs() - rec.startedAt };
      else if (next !== "user" && rec.ctl) {
        rec.userControl.push({ t: rec.ctl.t, endT: nowMs() - rec.startedAt });
        rec.ctl = null;
      }
    });
    // 时长上限：静止页面不出帧，光靠帧事件判不了超时
    rec.timer = setTimeout(() => autoStop(session, st, rec, "max_duration"), limits.maxMs);
    rec.timer.unref?.();
    try {
      await tab.send("Page.startScreencast", { format: "jpeg", quality: p.quality, maxWidth: 1280, maxHeight: 1280, everyNthFrame: p.everyNth }, null, 10_000);
    } catch (err) {
      rec.stopped = true;
      clearTimeout(rec.timer);
      rec.off?.();
      rec.offDestroy?.();
      rec.offCtl?.();
      st.active = null;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 空目录留给清理 */
      }
      throw new BrowserError("INTERNAL", `无法开始录制：${errMsg(err)}`);
    }
    ctx.describe({ kind: "select", label: "开始录制页面", summary: "开始录制页面（AI 发起，面板上有「正在录制」提示条）" });
    schedule(session.taskId);
    return {
      action: "start",
      recId,
      tabId: tab.id,
      dir,
      maxFrames: p.maxFrames,
      maxSeconds: Math.round(limits.maxMs / 1000),
      maxMB: Math.round(limits.maxBytes / 1048576),
      everyNth: p.everyNth,
      quality: p.quality,
    };
  };

  // ── stop / status ──

  const stop = (session) => {
    const st = stateOf(session);
    const rec = st.active;
    if (!rec) {
      const pending = st.pending;
      if (pending) {
        st.pending = null;
        return { action: "stop", ...pending };
      }
      throw new BrowserError("BAD_ARGS", "没有进行中的录制：先 browser_record start");
    }
    const summary = finalize(session, st, rec, "stopped");
    st.pending = null;
    logAi(session, rec.tab, `结束了录制（${summary.frames} 帧）`, "download");
    return { action: "stop", ...summary, auto: false };
  };

  const status = (session) => {
    const st = stateOf(session);
    const rec = st.active;
    return {
      action: "status",
      recording: rec
        ? { recId: rec.recId, tabId: rec.tabId, frames: rec.frames.length, bytes: rec.bytes, elapsedMs: nowMs() - rec.startedAt, redactedGaps: rec.gaps.length + (rec.gap ? 1 : 0) }
        : null,
      pendingResult: st.pending ? { recId: st.pending.recId, frames: st.pending.frames, stopReasonText: st.pending.stopReasonText } : null,
      lastRecId: st.lastRecId,
    };
  };

  // ── export ──

  const readTimeline = (dir) => {
    const file = nodePath.join(dir, "timeline.json");
    let st;
    try {
      st = fs.lstatSync(file);
    } catch {
      throw new BrowserError("BAD_ARGS", "这个录制没有 timeline.json（可能还没 stop，或目录被清理过）");
    }
    if (!st.isFile() || st.size > MAX_TIMELINE_READ) throw new BrowserError("INTERNAL", "timeline.json 异常（不是普通文件或过大）");
    try {
      const tl = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!tl || !Array.isArray(tl.frames) || !Array.isArray(tl.markers)) throw new Error("形状不对");
      return { tl, file };
    } catch (err) {
      throw new BrowserError("INTERNAL", `timeline.json 解析失败：${errMsg(err)}`);
    }
  };

  /**
   * R6-37：导出前 / 落盘前对「已有录制目录」做逐级安全校验（不创建）。
   * 不存在 → BAD_ARGS（已被清理）；符号链接 / 非目录 / 他人属主 / 权限收不紧 → INTERNAL「录制目录不安全」（文案不含绝对路径）
   */
  const verifyRecordingDir = (root, dir, recId) => {
    try {
      ensureDir(fs, dir, `browser-recordings/${recId}`, { root: nodePath.dirname(root), create: false });
    } catch (err) {
      if (err?.code === "ENOENT") throw new BrowserError("BAD_ARGS", `没有这个录制（${recId}）：可能已被自动清理（只保留最近 ${limits.keepRecordings} 个）`);
      throw new BrowserError("INTERNAL", `录制目录不安全，拒绝导出：${errMsg(err)}`);
    }
  };

  const execFfmpeg = (ffmpeg, args, cwd) =>
    new Promise((resolve, reject) => {
      const run = deps.execFile ?? nodeChildProcess.execFile;
      const env = { PATH: ffmpeg.pathEnv };
      if (process.platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
      // execFile（不经 shell）+ 固定参数数组 + cwd = 录制目录；env 只给 PATH，不把进程里的令牌交给 ffmpeg
      run(ffmpeg.path, args, { cwd, timeout: limits.ffmpegTimeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, windowsHide: true, env }, (err, _stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderrText: String(stderr ?? "") }));
        else resolve();
      });
    });

  const exportRecording = async (session, a) => {
    const st = stateOf(session);
    const format = a.format ?? "frames";
    if (format === "gif") throw new BrowserError("UNSUPPORTED", "gif 导出暂不支持：请用 format=frames（帧目录 + timeline.json）或 format=mp4（需要本机装有 ffmpeg）");
    const root = recordingsRootFor(userDataDir(), session.taskId);
    if (!root) throw new BrowserError("INTERNAL", "无法确定任务目录（userData 或 taskId 不可用）");
    const recId = a.recId ?? st.lastRecId ?? newestRecId(fs, root);
    if (!recId) throw new BrowserError("BAD_ARGS", "还没有录制可导出：先 browser_record start → stop");
    if (st.active && st.active.recId === recId) throw new BrowserError("BAD_ARGS", "这个录制还在进行：先 browser_record stop，再导出");
    const dir = resolveRecDir(root, recId);
    if (!dir) throw new BrowserError("BAD_ARGS", "rec_id 不合法：只能用 start / stop 返回的 rec-… 编号");
    // R6-37：导出目录逐级经 ensureSafeDir（任务目录 / browser-recordings / <recId> 每一级 lstat：符号链接、非目录、他人属主、被放宽的权限都拒绝）。
    // 之前只 lstat 叶子目录——browser-recordings 或任务目录被换成符号链接时，lstat(叶子) 穿过链接成功，timeline.json / 帧 / ffmpeg 输出全落到链接目标。目录不存在（被清理）不创建
    verifyRecordingDir(root, dir, recId);
    const { tl, file: timelineFile } = readTimeline(dir);
    const base = { action: "export", format, ...summarizeTimeline(tl), dir, timelineFile };
    const tab = session.tabs?.find((t) => t.id === session.activeTabId);
    if (format === "frames") {
      logAi(session, tab, `导出了录制（帧目录，${tl.frames.length} 帧）`, "download");
      return base;
    }
    // mp4
    if (tl.frames.length === 0) throw new BrowserError("BAD_ARGS", "这个录制没有写入任何帧（可能全程有密码框 / 页面静止），没法导出视频");
    const ffmpeg = findFfmpeg({ fs, env: deps.env ?? process.env });
    if (!ffmpeg) {
      throw new BrowserError("UNSUPPORTED", "本机 PATH 里没有 ffmpeg，无法导出 mp4。请改用 browser_record export format=frames（帧目录 + timeline.json 已经可用），或让用户安装 ffmpeg 后重试");
    }
    const outName = `.rec-${nodeCrypto.randomBytes(4).toString("hex")}.tmp.mp4`;
    const fps = framesFps(tl.frames.length, tl.durationMs);
    const args = buildFfmpegArgs({ fps, maxBytes: limits.ffmpegMaxOutputBytes, outName });
    const tmp = nodePath.join(dir, outName);
    const finalPath = nodePath.join(dir, "recording.mp4");
    // R6-37：输出名是随机的，正常不会已存在；存在（哪怕是符号链接）就拒绝——ffmpeg 带 -y，会顺着链接覆盖目标
    let tmpExists = true;
    try {
      fs.lstatSync(tmp);
    } catch {
      tmpExists = false;
    }
    if (tmpExists) throw new BrowserError("INTERNAL", "导出的临时文件名已被占用，拒绝覆盖；请重试");
    try {
      await execFfmpeg(ffmpeg, args, dir);
      // ffmpeg 最长跑 ffmpegTimeoutMs：期间目录链可能被换成符号链接。落盘（chmod / rename）前把整条链再校验一遍，且产物必须是真文件（lstat，不跟随链接）
      verifyRecordingDir(root, dir, recId);
      const stat = fs.lstatSync(tmp);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error("ffmpeg 没有产出文件");
      if (stat.size > limits.ffmpegMaxOutputBytes) throw new BrowserError("INTERNAL", `导出的 mp4 超过 ${Math.round(limits.ffmpegMaxOutputBytes / 1048576)}MB 上限，已删除`);
      if (unixMode()) fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, finalPath);
      logAi(session, tab, `把录制导出为 mp4（${tl.frames.length} 帧）`, "download");
      return { ...base, format: "mp4", file: "recording.mp4", path: finalPath, bytes: stat.size, fps };
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 留给下次清理 */
      }
      if (err instanceof BrowserError) throw err;
      if (err?.killed === true || err?.signal === "SIGKILL") throw new BrowserError("TIMEOUT", `ffmpeg 超过 ${Math.round(limits.ffmpegTimeoutMs / 1000)} 秒仍未完成，已终止；可改用 format=frames`);
      throw new BrowserError("INTERNAL", `ffmpeg 导出失败：${scrubClip(String(err?.stderrText || err?.message || err).trim().split("\n").slice(-3).join(" "), 200)}。可改用 format=frames`);
    }
  };

  const exportActivity = (session, a) => {
    const format = a.format === "markdown" ? "markdown" : "json";
    const root = exportsRootFor(userDataDir(), session.taskId);
    if (!root) throw new BrowserError("INTERNAL", "无法确定任务目录（userData 或 taskId 不可用），不能导出");
    // R6-34：导出文件内容里的活动日志文字先剔除本机路径（perf 已不写，这里兜底其它写入方）再脱敏截断
    const redact = { redactText: scrubClip, redactUrl: (u) => clipText(redactUrlSecrets(u), 300) };
    const rows = session.activityLog.list().map((e) => toExportEntry(e, redact));
    const text = renderActivityExport(rows, format);
    const ext = format === "markdown" ? "md" : "json";
    let finalPath;
    try {
      ensureDir(fs, root, EXPORT_DIR_NAME);
      const base = `activity-${recStamp(new Date(nowMs()))}`;
      let name = `${base}.${ext}`;
      for (let i = 2; i < 100; i += 1) {
        try {
          fs.lstatSync(nodePath.join(root, name));
        } catch {
          break;
        }
        name = `${base}-${i}.${ext}`;
      }
      finalPath = nodePath.join(root, name);
      writeAtomic600(fs, finalPath, text);
      pruneExports(root);
    } catch (err) {
      throw new BrowserError("INTERNAL", `导出活动日志失败：${errMsg(err)}`);
    }
    const tab = session.tabs?.find((t) => t.id === session.activeTabId);
    logAi(session, tab, `导出了活动日志（${rows.length} 条，${format}）`, "download");
    // R6-34：返回值不带绝对路径（与 perf 的 publicTraceResult 同口径）：只给文件名 + 任务目录里的子目录名；文件仅供用户查看，模型不需要也不该拿到 userData 路径
    return { action: "export_activity", format, file: nodePath.basename(finalPath), dir: EXPORT_DIR_NAME, entries: rows.length, bytes: Buffer.byteLength(text, "utf8") };
  };

  /** 导出目录只留最近 keepExports 个 `activity-*`（别的文件不动） */
  const pruneExports = (root) => {
    const files = [];
    for (const n of fs.readdirSync(root)) {
      if (!/^activity-\d{8}-\d{6}(-\d+)?\.(json|md)$/.test(n)) continue;
      try {
        const st = fs.lstatSync(nodePath.join(root, n));
        if (st.isFile()) files.push({ n, t: st.mtimeMs });
      } catch {
        /* 刚被删 */
      }
    }
    files.sort((x, y) => y.t - x.t);
    for (const f of files.slice(limits.keepExports)) {
      try {
        fs.unlinkSync(nodePath.join(root, f.n));
      } catch {
        /* 下次再说 */
      }
    }
  };

  // ── 状态 / 面板 ──

  // 状态贡献者：recording:{frames, startedAt}（没有录制时不贡献 → 默认 null，条不显示）
  deps.addStateContributor?.((session) => {
    // 只窥视：getExt 会把工厂结果缓存进 session.ext，这里若建出 null 会让后面真正的状态对象永远建不出来
    const rec = session.ext?.get(EXT_KEY)?.active;
    return rec && !rec.stopped ? { recording: { frames: rec.frames.length, startedAt: rec.startedAt } } : {};
  });

  // 面板「停止」按钮：用户发起，接管期间也可用（停止录制不是 AI 动作）。结果留给 AI 下一次 stop 取走
  deps.registerExt?.("record.stop", async (session) => {
    const st = stateOf(session);
    const rec = st.active;
    if (!rec) return { stopped: false };
    const summary = finalize(session, st, rec, "user");
    logSystem(session, rec.tab, `用户停止了录制（${summary.frames} 帧）`);
    return { stopped: true, frames: summary.frames };
  });

  // ── dispatch ──

  const record = async (taskId, a, signal) => {
    const session = requireSession(taskId);
    switch (a.action) {
      case "start":
        return session.runAction({ op: "record", tabId: a.tabId, signal }, (ctx) => start(session, ctx, a));
      case "stop":
        return stop(session);
      case "status":
        return status(session);
      case "export":
        return exportRecording(session, a);
      case "export_activity":
        return exportActivity(session, a);
      default:
        throw new BrowserError("BAD_ARGS", `未知的 record action：${String(a.action).slice(0, 30)}`);
    }
  };

  return { record };
};
