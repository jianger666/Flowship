/**
 * 增强包 E2 · B7 browser_record（server 工具定义）：录制页面画面（帧序列 + 时间线）/ 导出 / 活动日志导出（高级调试组）。
 * 主进程实现在 electron-app/browser/ops/record.mjs，纯逻辑在 electron-app/browser/record-policy.mjs。
 *
 * # 文案分层
 * 可信行只有固定话术与「形状受限」的数字 / 枚举；时间线标记的文字（来自页面元素名 / AI 或用户动作摘要 / URL）一律先脱敏再截断，
 * 放进 untrusted 块。文件路径由主进程生成，仍按形状校验（无控制字符、限长）后才展示。
 *
 * 积木从 `kit` 取（见 tools.ts 的 buildToolKit）；不要 import "./tools"（成环），类型用 `import type`。
 */
import { Number as TBNumber, Object as TBObject, Optional as TBOptional, String as TBString, Enum as TBEnum } from "typebox/type";
import type { FlowshipToolDef } from "../flowship-tools";
import type { ToolResultBuilder } from "./content";
import type { BrowserToolKit } from "./tools";

export const RECORD_TOOL_ACTIONS = ["start", "stop", "status", "export", "export_activity"] as const;
export type RecordToolAction = (typeof RECORD_TOOL_ACTIONS)[number];
/** 与主进程 record-policy.mjs 的 EXPORT_FORMATS / ACTIVITY_FORMATS 逐项一致（测试对账） */
export const RECORD_EXPORT_FORMATS = ["frames", "mp4", "gif"] as const;
export const RECORD_ACTIVITY_FORMATS = ["json", "markdown"] as const;
/** 与主进程 REC_ID_RE 一致 */
export const REC_ID_RE = /^rec-\d{8}-\d{6}-[0-9a-f]{6}$/;
/** 与主进程 export_activity 生成的文件名一致（`activity-<时间戳>[-序号].json|md`）；形状不对不展示 */
export const ACTIVITY_FILE_RE = /^activity-\d{8}-\d{6}(?:-\d+)?\.(?:json|md)$/;

interface RecordMarker {
  t?: number;
  type?: string;
  text?: string;
  frame?: number;
}

interface RecordResult {
  action?: string;
  recId?: string;
  tabId?: string;
  dir?: string;
  maxFrames?: number;
  maxSeconds?: number;
  maxMB?: number;
  everyNth?: number;
  quality?: number;
  frames?: number;
  durationMs?: number;
  totalBytes?: number;
  markerCount?: number;
  markerCounts?: Record<string, number>;
  markers?: RecordMarker[];
  stopReason?: string;
  stopReasonText?: string;
  redactedGaps?: number;
  redactedFrames?: number;
  userControlSegments?: number;
  timelineFile?: string | null;
  timelineError?: string;
  auto?: boolean;
  format?: string;
  file?: string;
  path?: string;
  bytes?: number;
  fps?: number;
  entries?: number;
  recording?: { recId?: string; tabId?: string; frames?: number; bytes?: number; elapsedMs?: number; redactedGaps?: number } | null;
  pendingResult?: { recId?: string; frames?: number; stopReasonText?: string } | null;
  lastRecId?: string | null;
}

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const int = (v: unknown): number => Math.max(0, Math.round(finite(v) ?? 0));
const fmtBytes = (v: unknown): string => {
  const n = finite(v) ?? 0;
  if (n >= 1048576) return `${Math.round((n / 1048576) * 10) / 10}MB`;
  if (n >= 1024) return `${Math.round((n / 1024) * 10) / 10}KB`;
  return `${Math.round(n)}B`;
};
const fmtSec = (ms: unknown): string => `${Math.round(((finite(ms) ?? 0) / 1000) * 10) / 10} 秒`;
/** 路径形状校验：无控制字符、限长；否则不展示（宁可少给也不把怪字符放进可信行） */
const safePath = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= 400 && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(v) ? v : undefined);
const safeRecId = (v: unknown): string | undefined => (typeof v === "string" && REC_ID_RE.test(v) ? v : undefined);
const MARKER_TYPES = new Set(["navigation", "ai-action", "user-action", "system", "redacted-gap", "user-control"]);
const STOP_REASONS = new Set(["stopped", "user", "max_frames", "max_duration", "max_bytes", "tab_closed", "session_closed", "error"]);

export const createRecordTools = (kit: BrowserToolKit): FlowshipToolDef[] => {
  const { run, guarded, BadArgs, argStr, argNum, argEnum, clipRedacted } = kit;

  const renderSummary = (r: RecordResult, b: ToolResultBuilder, head: string): void => {
    const path = safePath(r.dir);
    const reason = STOP_REASONS.has(String(r.stopReason)) ? r.stopReasonText : undefined;
    b.trusted(
      `${head}${int(r.frames)} 帧 / ${fmtSec(r.durationMs)} / ${fmtBytes(r.totalBytes)}，${int(r.markerCount)} 条时间线标记${path ? `；目录 ${path}（frame-NNNN.jpg + timeline.json，可用文件类工具读取；帧已过密码 / 验证码输入框可见探针，但画面仍可能含页面内容）` : ""}。` +
        (reason ? `结束原因：${clipRedacted(reason, 40)}。` : "") +
        (int(r.redactedGaps) > 0 ? `其中 ${int(r.redactedGaps)} 段因页面有可见的密码 / 验证码输入框而暂停写帧（共跳过 ${int(r.redactedFrames)} 个画面，时间线里记为 redacted-gap），这些时刻没有画面。` : "") +
        (int(r.userControlSegments) > 0 ? `期间用户接管了 ${int(r.userControlSegments)} 段（时间线 user-control，那段画面是用户的操作）。` : "") +
        (r.timelineError ? "timeline.json 写入失败，帧文件仍在目录里。" : ""),
    );
    const kinds = Object.entries(r.markerCounts ?? {})
      .filter(([k]) => MARKER_TYPES.has(k))
      .map(([k, n]) => `${k}×${int(n)}`)
      .join("、");
    if (kinds) b.trusted(`标记分布：${kinds}。`);
    const ms = (r.markers ?? []).filter((m) => MARKER_TYPES.has(String(m.type)));
    if (ms.length > 0) {
      b.untrusted(
        ms
          .map((m) => `+${fmtSec(m.t)} [${m.type}] ${clipRedacted(m.text, 160)}${int(m.frame) > 0 ? `（≈第 ${int(m.frame)} 帧）` : ""}`)
          .join("\n"),
      );
      if (int(r.markerCount) > ms.length) b.trusted(`（只列出前 ${ms.length} 条，完整时间线在 timeline.json）`);
    }
  };

  const render = (r: RecordResult, b: ToolResultBuilder): void => {
    switch (r?.action) {
      case "start":
        b.trusted(
          `已开始录制页面（标签页 ${/^[\w.:-]{1,40}$/.test(String(r.tabId)) ? r.tabId : "?"}，编号 ${safeRecId(r.recId) ?? "?"}），最长 ${int(r.maxSeconds) || 60} 秒 / ${int(r.maxFrames) || 600} 帧 / ${int(r.maxMB) || 150}MB 后自动停止；面板上有「正在录制」提示条，用户可随时停止。` +
            "现在去操作页面，然后调用 browser_record stop 取得时间线摘要。页面有可见的密码 / 验证码输入框时画面不会被保存。",
        );
        return;
      case "stop":
        return renderSummary(r, b, r.auto ? "录制已结束（自动 / 用户停止）：" : "录制已结束：");
      case "status": {
        const rec = r.recording;
        if (rec) {
          b.trusted(`正在录制：${safeRecId(rec.recId) ?? "?"}，已 ${int(rec.frames)} 帧 / ${fmtSec(rec.elapsedMs)} / ${fmtBytes(rec.bytes)}${int(rec.redactedGaps) > 0 ? `，其中 ${int(rec.redactedGaps)} 段因敏感输入框暂停写帧` : ""}。`);
        } else if (r.pendingResult) {
          b.trusted(`当前没有进行中的录制；上一个录制（${safeRecId(r.pendingResult.recId) ?? "?"}，${int(r.pendingResult.frames)} 帧）已结束（${clipRedacted(r.pendingResult.stopReasonText, 40)}），调用 browser_record stop 取摘要。`);
        } else {
          b.trusted(`当前没有进行中的录制${safeRecId(r.lastRecId) ? `；最近一次是 ${r.lastRecId}，可 export` : ""}。`);
        }
        return;
      }
      case "export": {
        if (r.format === "mp4") {
          const p = safePath(r.path);
          b.trusted(`已导出 mp4：${fmtBytes(r.bytes)}（${int(r.fps)} fps）${p ? `，文件 ${p}` : ""}（可用文件类工具读取；画面可能含页面内容）。`);
          return;
        }
        renderSummary(r, b, "帧目录已就绪：");
        return;
      }
      case "export_activity": {
        // R6-34：只展示 browser-exports/文件名（任务目录内，仅供用户查看），与 perf 同口径——忽略主进程 / 旧版带来的任何 `path`（userData 绝对路径里有系统用户名）
        const file = typeof r.file === "string" && ACTIVITY_FILE_RE.test(r.file) ? r.file : undefined;
        b.trusted(
          `活动日志已导出（${r.format === "markdown" ? "markdown" : "json"}，${int(r.entries)} 条，${fmtBytes(r.bytes)}，已脱敏）${file ? `：browser-exports/${file}（任务目录内，仅供用户查看）` : ""}。`,
        );
        return;
      }
      default:
        b.trusted("操作完成。");
    }
  };

  const recordTool: FlowshipToolDef = {
    name: "browser_record",
    label: "浏览器·录制",
    description:
      "录制页面画面（高级调试）：start 开始（最长 60 秒 / 600 帧 / 150MB 自动停，面板上有提示条、用户可随时停）、stop 返回帧数与导航 / AI / 用户动作时间线、export 导出帧目录或 mp4（需 ffmpeg）、export_activity 导出本会话活动日志。" +
      "密码 / 验证码输入框可见时暂停写帧（时间线记 redacted-gap），文件只存任务目录；stop / export 会给出目录或文件路径，可用文件类工具读取帧 / mp4（画面可能含页面内容）。",
    parameters: TBObject({
      action: TBEnum([...RECORD_TOOL_ACTIONS]),
      max_frames: TBOptional(TBNumber({ description: "start：最多帧数，1–600，默认 600" })),
      quality: TBOptional(TBNumber({ description: "start：jpeg 质量 20–90，默认 60" })),
      every_nth: TBOptional(TBNumber({ description: "start：每 N 个画面取 1 帧，1–60，默认 6（≈10fps）" })),
      format: TBOptional(TBString({ description: "export：frames（默认）/ mp4；export_activity：json（默认）/ markdown" })),
      rec_id: TBOptional(TBString({ description: "export：录制编号（rec-…），默认最近一个" })),
      tab_id: TBOptional(TBString({ description: "start 的目标标签页，默认当前" })),
    }),
    handler: guarded(async (args, ctx) => {
      const action = argEnum(args, "action", RECORD_TOOL_ACTIONS);
      if (!action) throw new BadArgs(`缺少必填参数 action（${RECORD_TOOL_ACTIONS.join(" / ")}）`);
      const opArgs: Record<string, unknown> = { action };
      if (action === "start") {
        const tabId = argStr(args, "tab_id");
        if (tabId !== undefined) opArgs.tabId = tabId;
        for (const [key, op, lo, hi] of [
          ["max_frames", "maxFrames", 1, 600],
          ["quality", "quality", 20, 90],
          ["every_nth", "everyNth", 1, 60],
        ] as const) {
          const v = argNum(args, key);
          if (v !== undefined) opArgs[op] = Math.min(hi, Math.max(lo, Math.floor(v)));
        }
      }
      if (action === "export") {
        const raw = argStr(args, "format");
        if (raw !== undefined && !(RECORD_EXPORT_FORMATS as readonly string[]).includes(raw)) throw new BadArgs(`export 的 format 只能是 ${RECORD_EXPORT_FORMATS.join(" / ")}`);
        if (raw !== undefined) opArgs.format = raw;
        const recId = argStr(args, "rec_id");
        if (recId !== undefined) {
          if (!REC_ID_RE.test(recId)) throw new BadArgs("rec_id 只能是 browser_record start / stop 返回的 rec-YYYYMMDD-HHmmss-xxxxxx 编号（不接受路径）");
          opArgs.recId = recId;
        }
      }
      if (action === "export_activity") {
        const raw = argStr(args, "format");
        if (raw !== undefined && !(RECORD_ACTIVITY_FORMATS as readonly string[]).includes(raw)) throw new BadArgs(`export_activity 的 format 只能是 ${RECORD_ACTIVITY_FORMATS.join(" / ")}`);
        if (raw !== undefined) opArgs.format = raw;
      }
      return run<RecordResult>(ctx, { op: "record", args: opArgs, render });
    }),
  };
  return [recordTool];
};
