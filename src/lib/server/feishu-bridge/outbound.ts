/**
 * 飞书桥接出向：app chat 流式事件 → 飞书流式卡片（方案 4.2）
 *
 * 挂点：task-stream 全局 tap（subscribeAllTaskStreams），对 chat-runner 零侵入。
 * 每轮 turn（user_reply → … → done/error）一张新卡；异常一律吞掉（坑 #10）。
 *
 * 正文本地图片取舍（决策 #12）：
 * - 方案原文「流式期间占位 [图片上传中…]、finalize 替换」——但 CardKit 打字机要求
 *   已推文本是新文本前缀，回改前缀会全量闪屏、破坏打字机。
 * - 故简化为：流式期间本地路径 markdown 原样保留；finalize 前一次性 uploadImage
 *   换成 image_key（失败 →「[图片：仅 app 内可见]」），再经 finalize 全量 PUT 上屏。
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { dataRoot } from "@/lib/server/data-root";
import { getTask } from "@/lib/server/task-fs";
import { taskDir } from "@/lib/server/task-fs-core";
import {
  subscribeAllTaskStreams,
  writeEventAndPublish,
  type TaskStreamEvent,
} from "@/lib/server/task-stream";
import type { Task, TaskEvent } from "@/lib/types";

import { isFeishuChatBridgeEnabled } from "./bridge-config";
import {
  createCardStream as defaultCreateCardStream,
} from "./card-stream";
import { uploadImage as defaultUploadImage } from "./lark-api";
import type {
  CardStreamAppendAskOpts,
  CardStreamHandle,
  CardStreamOptions,
} from "./types";

// ----------------- 可注入依赖（单测 mock） -----------------

type CreateCardStreamFn = (
  taskId: string,
  opts: CardStreamOptions,
) => CardStreamHandle;
type UploadImageFn = (filePath: string) => Promise<string>;

let createCardStreamImpl: CreateCardStreamFn = defaultCreateCardStream;
let uploadImageImpl: UploadImageFn = defaultUploadImage;

/** 单测替换 createCardStream 工厂 */
export const __setCreateCardStreamForTest = (
  fn: CreateCardStreamFn | null,
): void => {
  createCardStreamImpl = fn ?? defaultCreateCardStream;
};

/** 单测替换 uploadImage */
export const __setUploadImageForTest = (fn: UploadImageFn | null): void => {
  uploadImageImpl = fn ?? defaultUploadImage;
};

// ----------------- 开关缓存（避免每事件读盘） -----------------

const ENABLED_CACHE_TTL_MS = 8_000;

type EnabledCache = { value: boolean; at: number };
/** null = 走真实读取；boolean = 单测强制 */
let enabledOverride: boolean | null = null;
let enabledCache: EnabledCache | null = null;

/** 单测强制开关；传 null 恢复 */
export const __setBridgeEnabledForTest = (v: boolean | null): void => {
  enabledOverride = v;
  enabledCache = null;
};

const isBridgeEnabledCached = async (): Promise<boolean> => {
  if (enabledOverride !== null) return enabledOverride;
  const now = Date.now();
  if (enabledCache && now - enabledCache.at < ENABLED_CACHE_TTL_MS) {
    return enabledCache.value;
  }
  const value = await isFeishuChatBridgeEnabled();
  enabledCache = { value, at: now };
  return value;
};

// ----------------- chat mode / 标题缓存 -----------------

const MODE_CACHE_TTL_MS = 30_000;

type ModeCacheEntry = {
  isChat: boolean;
  title: string;
  modelId?: string;
  at: number;
};

/** taskId → 模式/标题缓存（减少 getTask 读盘）；超上限按插入序淘汰最旧 */
const MODE_CACHE_MAX = 500;
const modeCache = new Map<string, ModeCacheEntry>();

const setModeCache = (taskId: string, entry: ModeCacheEntry): void => {
  modeCache.delete(taskId);
  modeCache.set(taskId, entry);
  while (modeCache.size > MODE_CACHE_MAX) {
    const oldest = modeCache.keys().next().value;
    if (oldest === undefined) break;
    modeCache.delete(oldest);
  }
};

const resolveTaskInfo = async (
  taskId: string,
): Promise<ModeCacheEntry | null> => {
  const now = Date.now();
  const hit = modeCache.get(taskId);
  // mode 不可变：非 chat 直接永久命中（task 模式事件量大、不为它反复 getTask）；
  // chat 的 entry 才走 TTL（title / model 可能变，且 task/done 事件会顺带刷新）
  if (hit && (!hit.isChat || now - hit.at < MODE_CACHE_TTL_MS)) return hit;
  try {
    const task = await getTask(taskId);
    if (!task) return null;
    const entry = taskInfoFromTask(task, now);
    setModeCache(taskId, entry);
    return entry;
  } catch (err) {
    console.warn(
      `[feishu-bridge/outbound] getTask 失败 task=${taskId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
};

const taskInfoFromTask = (task: Task, at = Date.now()): ModeCacheEntry => ({
  isChat: task.mode === "chat",
  title: task.title?.trim() || "Flowship 对话",
  modelId: task.model?.id,
  at,
});

// ----------------- turn 状态机 -----------------

/** 过程区一行：思考段落或工具 timeline */
type ProcessPart =
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      callId: string;
      name: string;
      argsSummary: string;
      /** running 无标记；完成后 ✓/✗ */
      status: "running" | "ok" | "err";
    };

type TurnState = {
  /** 本轮 app 侧回显文本（feishu 来源不累积） */
  echoText: string;
  /** 待上传的本地图 absPath */
  echoImageAbsPaths: string[];
  /** 过程区混排片段 */
  processParts: ProcessPart[];
  /** 正文累积（assistant_delta 是增量 chunk） */
  answerText: string;
  /** 本轮最后一条用户消息（重试用） */
  lastUserMessage: string;
  /** 最近一条落盘 error 事件文本（done ok=false 时作 finalize 错误文案） */
  lastError: string;
  /** turn 起点（header 耗时） */
  turnStartedAt: number;
  /** 已见工具调用次数（含 running） */
  toolCount: number;
  /** 当前工具名（header 用） */
  currentToolName: string;
  /** 当前工具参数摘要（Hermes 式 subtitle「正在Xxx：target」用） */
  currentToolArgs: string;
  /** 卡片句柄；首个 assistant 活动后才有 */
  card: CardStreamHandle | null;
  /** start() 进行中的 Promise——后续 push 排队等它 */
  startPromise: Promise<void> | null;
  /** start 已成功 */
  started: boolean;
  /** 已 finalize / 放弃 */
  finalized: boolean;
  /** start 完成前缓冲的操作（按序执行） */
  pendingOps: Array<() => void | Promise<void>>;
  /** 卡片标题 */
  title: string;
  /** finalize 带模型名 */
  modelId?: string;
};

/** callId → processParts 下标（tool_result 回填 ✓/✗） */
type ToolIndexMap = Map<string, number>;

type OutboundGlobal = {
  registered: boolean;
  unsub: (() => void) | null;
  /** taskId → 当前 turn */
  turns: Map<string, TurnState>;
  /** taskId → callId→partIdx（跟 turns 同生命周期） */
  toolIndexes: Map<string, ToolIndexMap>;
  /**
   * taskId → 事件处理串行链。listener 收事件同步入链——handle 内部有 await
   * （开关/getTask/beginNewTurn），不串行会 microtask 交错（echo 乱序 / done 越过 delta）。
   */
  chains: Map<string, Promise<void>>;
};

const OUTBOUND_GLOBAL_KEY = "__flowshipFeishuOutboundV1__";

const getOutboundGlobal = (): OutboundGlobal => {
  const g = globalThis as unknown as Record<
    string,
    OutboundGlobal | undefined
  >;
  if (!g[OUTBOUND_GLOBAL_KEY]) {
    g[OUTBOUND_GLOBAL_KEY] = {
      registered: false,
      unsub: null,
      turns: new Map(),
      toolIndexes: new Map(),
      chains: new Map(),
    };
  }
  return g[OUTBOUND_GLOBAL_KEY]!;
};

/** 单测重置注册态 + turn 缓存 */
export const __resetFeishuOutboundForTest = (): void => {
  const g = getOutboundGlobal();
  g.unsub?.();
  g.unsub = null;
  g.registered = false;
  g.turns.clear();
  g.toolIndexes.clear();
  g.chains.clear();
  modeCache.clear();
  enabledCache = null;
  enabledOverride = null;
  createCardStreamImpl = defaultCreateCardStream;
  uploadImageImpl = defaultUploadImage;
};

// ----------------- 小工具 -----------------

const truncateOneLine = (s: string, max = 80): string => {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max)}…`;
};

/** header 耗时：3m20s / 45s（决策 #23） */
export const formatElapsed = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m${s}s` : `${m}m`;
};

/** Hermes runtime header 上限 */
const RUNTIME_HEADER_MAX_CHARS = 120;

/**
 * 从工具 args JSON / 摘要里抽出展示用 target（command / path / query…）。
 * 解析失败则退回原摘要单行。
 */
const extractToolPreviewTarget = (argsSummary: string): string => {
  const text = argsSummary.replace(/\s+/g, " ").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>;
      for (const key of [
        "command",
        "cmd",
        "path",
        "file_path",
        "file",
        "target_file",
        "query",
        "url",
        "pattern",
        "glob_pattern",
      ]) {
        const v = o[key];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
  } catch {
    // 非 JSON——下文按纯文本 target 处理
  }
  // 去掉「参数:」前缀（Hermes 会丢弃这类噪声）
  if (/^(参数[:：]|args?:|arguments:)/i.test(text)) return "";
  return text;
};

/**
 * Hermes `_runtime_tool_summary` 同款：把工具名 + 摘要收成单行 subtitle。
 * 例：正在执行终端：pnpm lint / 正在读取：foo.ts / 正在使用 shell
 */
export const formatToolRuntimePreview = (
  name: string,
  argsSummary: string,
): string => {
  const raw = argsSummary.replace(/\s+/g, " ").trim();
  if (raw.startsWith("正在")) {
    return raw.length <= RUNTIME_HEADER_MAX_CHARS
      ? raw
      : `${raw.slice(0, RUNTIME_HEADER_MAX_CHARS - 1).trimEnd()}…`;
  }

  const toolName = (name || "").trim().toLowerCase();
  const preview = extractToolPreviewTarget(raw);
  const isUrl = /^https?:\/\//i.test(preview);
  const looksSearch =
    /\bsite:\S+/i.test(preview) ||
    toolName.includes("search") ||
    toolName.includes("query");

  let action: string;
  if (looksSearch) {
    action = "正在搜索";
  } else if (
    isUrl ||
    ["browser", "fetch", "web", "http"].some((m) => toolName.includes(m))
  ) {
    action = "正在浏览";
  } else if (
    ["terminal", "shell", "exec", "command", "bash", "zsh"].some((m) =>
      toolName.includes(m),
    )
  ) {
    action = "正在执行终端";
  } else if (
    ["write", "edit", "patch", "replace", "strreplace"].some((m) =>
      toolName.includes(m),
    )
  ) {
    action = "正在编辑";
  } else if (
    ["read", "open", "list", "glob", "grep"].some((m) => toolName.includes(m))
  ) {
    action = "正在读取";
  } else {
    const readable = toolName.replace(/_/g, " ").trim() || "工具";
    const fallback = `正在使用 ${readable}`;
    return fallback.length <= RUNTIME_HEADER_MAX_CHARS
      ? fallback
      : `${fallback.slice(0, RUNTIME_HEADER_MAX_CHARS - 1).trimEnd()}…`;
  }

  let target = preview;
  if (isUrl) {
    try {
      const u = new URL(preview);
      const host = u.hostname.replace(/^www\./, "");
      const p = u.pathname.replace(/\/$/, "");
      target = host ? `${host}${p}` : "";
    } catch {
      target = preview;
    }
  } else if (
    (action === "正在读取" || action === "正在编辑") &&
    (target.startsWith("/") || target.startsWith("~/"))
  ) {
    const pathOnly = target.split(/\s/, 1)[0] ?? target;
    target = pathOnly.replace(/\/$/, "").split("/").pop() ?? pathOnly;
  }

  const line = target ? `${action}：${target}` : action;
  if (line.length <= RUNTIME_HEADER_MAX_CHARS) return line;
  return `${line.slice(0, RUNTIME_HEADER_MAX_CHARS - 1).trimEnd()}…`;
};

/**
 * Hermes timeline 呈现：
 * - 思考：`**思考 N** · running|completed` + 正文
 * - 工具：引用块 `` `name` · status `` + 参数摘要行
 * （折叠面板 chrome 在 card-stream；这里只拼 md_process 内容）
 */
const renderProcess = (parts: ProcessPart[]): string => {
  let thinkingIdx = 0;
  const openThinkingIdx =
    parts.length > 0 && parts[parts.length - 1]!.kind === "thinking"
      ? parts.length - 1
      : -1;

  return parts
    .map((p, i) => {
      if (p.kind === "thinking") {
        thinkingIdx += 1;
        const status = i === openThinkingIdx ? "running" : "completed";
        return `**思考 ${thinkingIdx}** · ${status}\n${p.text}`;
      }
      const status =
        p.status === "ok"
          ? "completed"
          : p.status === "err"
            ? "failed"
            : "running";
      const lines = [`\`${p.name}\` · ${status}`];
      if (p.argsSummary.trim()) lines.push(p.argsSummary.trim());
      // Hermes `_quote_markdown`：整块工具条目包进引用
      return lines.map((line) => (line ? `> ${line}` : ">")).join("\n");
    })
    .join("\n\n");
};

const isLocalImageSrc = (src: string): boolean => {
  const t = src.trim();
  if (!t) return false;
  if (/^https?:\/\//i.test(t)) return false;
  // 已是飞书 image_key（img_v2_… / img_xxx）——不再当本地路径上传
  if (/^img[_-]/i.test(t)) return false;
  return true;
};

/**
 * 相对路径图片（`uploads/x.png` / `tasks/<id>/uploads/x.png`）解析成绝对路径。
 * agent 写正文时基准通常是 task 目录或 dataRoot；两处都探不到就返回原样
 * （交给 upload 失败降级、不在这里吞）。
 */
const resolveLocalImagePath = async (
  src: string,
  taskId?: string,
): Promise<string> => {
  if (path.isAbsolute(src)) return src;
  const candidates = taskId
    ? [path.join(taskDir(taskId), src), path.join(dataRoot(), src)]
    : [path.join(dataRoot(), src)];
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch {
      // 试下一个候选
    }
  }
  return src;
};

/**
 * finalize 前把正文里的本地图片路径换成 image_key（失败降级文案）。
 * 流式期间原样保留——回改已推前缀会破坏打字机（决策 #12 简化取舍，见模块顶注释）。
 */
export const replaceLocalImagesInMarkdown = async (
  markdown: string,
  upload: UploadImageFn = uploadImageImpl,
  taskId?: string,
): Promise<string> => {
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const matches = [...markdown.matchAll(re)];
  if (matches.length === 0) return markdown;
  let out = markdown;
  // 从后往前替换，避免 offset 漂移
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]!;
    const full = m[0]!;
    const alt = m[1] ?? "";
    const src = (m[2] ?? "").trim();
    const start = m.index ?? -1;
    if (start < 0 || !isLocalImageSrc(src)) continue;
    let filePath = src;
    if (src.startsWith("file://")) {
      try {
        filePath = decodeURIComponent(src.slice("file://".length));
      } catch {
        filePath = src.slice("file://".length);
      }
    }
    filePath = await resolveLocalImagePath(filePath, taskId);
    let replacement: string;
    try {
      const key = await upload(filePath);
      replacement = `![${alt}](${key})`;
    } catch {
      replacement = "[图片：仅 app 内可见]";
    }
    out = out.slice(0, start) + replacement + out.slice(start + full.length);
  }
  return out;
};

const parseEchoImages = (meta: TaskEvent["meta"]): string[] => {
  if (!meta || !Array.isArray(meta.images)) return [];
  const out: string[] = [];
  for (const item of meta.images as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const abs = (item as Record<string, unknown>).absPath;
    if (typeof abs === "string" && abs.trim()) out.push(abs);
  }
  return out;
};

/** meta.attachments（本机路径 chips）→ 引用块文本行（矩阵 4.5：仅本机可读、不假装可点） */
const parseEchoAttachments = (meta: TaskEvent["meta"]): string[] => {
  if (!meta || !Array.isArray(meta.attachments)) return [];
  const out: string[] = [];
  for (const item of meta.attachments as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const abs = (item as Record<string, unknown>).absPath;
    if (typeof abs === "string" && abs.trim()) {
      out.push(`📎 ${abs}（仅本机可读）`);
    }
  }
  return out;
};

const toolNameFromMeta = (meta: TaskEvent["meta"], fallback = "tool"): string => {
  if (!meta) return fallback;
  const inner =
    typeof meta.innerToolName === "string" && meta.innerToolName
      ? meta.innerToolName
      : "";
  const name = typeof meta.name === "string" && meta.name ? meta.name : "";
  // MCP wrapper 优先展示内层工具名
  return inner || name || fallback;
};

const argsSummaryFromMeta = (meta: TaskEvent["meta"], text: string): string => {
  if (meta && typeof meta.args === "string" && meta.args) {
    // 优先抽 command/path 等关键字段，timeline / subtitle 更干净
    const extracted = extractToolPreviewTarget(meta.args);
    return truncateOneLine(extracted || meta.args, 80);
  }
  // tool_call 的 text 形如「调用 Shell:…」——去掉前缀当摘要
  const stripped = text.replace(/^调用\s+\S+:?\s*/i, "").trim();
  return truncateOneLine(stripped || text || "…", 80);
};

const askOptsFromEvent = (ev: TaskEvent): CardStreamAppendAskOpts | null => {
  const meta = ev.meta;
  if (!meta) return null;
  const askId = typeof meta.askId === "string" ? meta.askId : "";
  if (!askId || !Array.isArray(meta.questions)) return null;
  const questions: CardStreamAppendAskOpts["questions"] = [];
  for (const q of meta.questions as unknown[]) {
    if (!q || typeof q !== "object") continue;
    const rec = q as Record<string, unknown>;
    if (typeof rec.id !== "string" || typeof rec.question !== "string") continue;
    const options: Array<{ id: string; label: string }> = [];
    if (Array.isArray(rec.options)) {
      for (const opt of rec.options as unknown[]) {
        if (!opt || typeof opt !== "object") continue;
        const o = opt as Record<string, unknown>;
        if (typeof o.id === "string" && typeof o.label === "string") {
          options.push({ id: o.id, label: o.label });
        }
      }
    }
    questions.push({
      id: rec.id,
      question: rec.question,
      options: options.length > 0 ? options : undefined,
      allowText: rec.allowText === true,
    });
  }
  if (questions.length === 0) return null;
  return { askId, questions };
};

// ----------------- turn 生命周期 -----------------

const getOrCreateTurn = (
  taskId: string,
  info: ModeCacheEntry,
): TurnState => {
  const g = getOutboundGlobal();
  let turn = g.turns.get(taskId);
  if (!turn) {
    turn = {
      echoText: "",
      echoImageAbsPaths: [],
      processParts: [],
      answerText: "",
      lastUserMessage: "",
      lastError: "",
      turnStartedAt: Date.now(),
      toolCount: 0,
      currentToolName: "",
      currentToolArgs: "",
      card: null,
      startPromise: null,
      started: false,
      finalized: false,
      pendingOps: [],
      title: info.title,
      modelId: info.modelId,
    };
    g.turns.set(taskId, turn);
    g.toolIndexes.set(taskId, new Map());
  }
  return turn;
};

/** 新一轮：丢弃上一轮未完态（尽量 finalize 关 streaming） */
const beginNewTurn = async (
  taskId: string,
  info: ModeCacheEntry,
): Promise<TurnState> => {
  const g = getOutboundGlobal();
  const prev = g.turns.get(taskId);
  if (prev && !prev.finalized) {
    try {
      if (prev.startPromise) await prev.startPromise;
      if (prev.started && prev.card) {
        await prev.card.finalize({
          ok: true,
          durationMs: Date.now() - prev.turnStartedAt,
          model: prev.modelId,
        });
      }
    } catch (err) {
      console.warn(
        `[feishu-bridge/outbound] 上一轮收尾失败 task=${taskId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  g.turns.delete(taskId);
  g.toolIndexes.delete(taskId);
  return getOrCreateTurn(taskId, info);
};

const clearTurn = (taskId: string): void => {
  const g = getOutboundGlobal();
  g.turns.delete(taskId);
  g.toolIndexes.delete(taskId);
};

/**
 * 确保卡片已 start；完成前把 op 推进 pendingOps。
 * start 失败（card 未建）时后续 op 仍会跑但句柄空操作——与 card-stream 行为一致。
 */
const withCard = (
  taskId: string,
  turn: TurnState,
  op: (card: CardStreamHandle) => void | Promise<void>,
): void => {
  if (turn.finalized) return;
  if (turn.started && turn.card) {
    void Promise.resolve(op(turn.card)).catch((err) => {
      console.warn(
        `[feishu-bridge/outbound] card op 失败 task=${taskId}:`,
        err instanceof Error ? err.message : err,
      );
    });
    return;
  }
  turn.pendingOps.push(async () => {
    if (turn.finalized || !turn.card) return;
    await op(turn.card);
  });
  void ensureCardStarted(taskId, turn);
};

const ensureCardStarted = async (
  taskId: string,
  turn: TurnState,
): Promise<void> => {
  if (turn.finalized || turn.started) return;
  if (turn.startPromise) {
    await turn.startPromise;
    return;
  }
  turn.startPromise = (async () => {
    const card = createCardStreamImpl(taskId, { title: turn.title });
    turn.card = card;

    // echo 图：失败降级「📎 N 张图」进文本、不阻塞 start
    let echoImageKeys: string[] = [];
    let echoText = turn.echoText;
    if (turn.echoImageAbsPaths.length > 0) {
      const keys: string[] = [];
      let failCount = 0;
      await Promise.all(
        turn.echoImageAbsPaths.map(async (abs) => {
          try {
            keys.push(await uploadImageImpl(abs));
          } catch {
            failCount += 1;
          }
        }),
      );
      echoImageKeys = keys;
      if (failCount > 0) {
        const hint = `📎 ${failCount} 张图`;
        echoText = echoText ? `${echoText}\n${hint}` : hint;
      }
    }

    try {
      await card.start({
        echoText: echoText || undefined,
        echoImageKeys: echoImageKeys.length > 0 ? echoImageKeys : undefined,
      });
    } catch (err) {
      // card.start 内部已吞 lark 错误、这里只兜非预期异常——不抛、继续排空 pending
      //（start 失败时句柄内部 started=false、后续 push 都是空操作、行为一致）
      console.warn(
        `[feishu-bridge/outbound] start 失败 task=${taskId}:`,
        err instanceof Error ? err.message : err,
      );
    }
    // outbound 层无论 start 成败都标 started：pending 排空、后续 op 直通句柄
    turn.started = true;

    const ops = turn.pendingOps.splice(0, turn.pendingOps.length);
    for (const fn of ops) {
      try {
        await fn();
      } catch (err) {
        console.warn(
          `[feishu-bridge/outbound] pending op 失败 task=${taskId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  })().catch((err) => {
    // 双保险：上面已逐段捕获、理论到不了这里
    console.warn(
      `[feishu-bridge/outbound] start 链异常 task=${taskId}:`,
      err instanceof Error ? err.message : err,
    );
    turn.started = true; // 避免永久卡在 pending
  });
  await turn.startPromise;
};

const pushProcessUpdate = (taskId: string, turn: TurnState): void => {
  const full = renderProcess(turn.processParts);
  withCard(taskId, turn, (card) => {
    card.pushProcess(full);
  });
};

const updateToolHeader = (taskId: string, turn: TurnState): void => {
  // Hermes：subtitle 只承载当前动作预览（正在Xxx：target），耗时进 footer
  const preview = formatToolRuntimePreview(
    turn.currentToolName,
    turn.currentToolArgs,
  );
  if (!preview) return;
  withCard(taskId, turn, (card) => {
    card.setHeaderStatus(preview, "blue");
  });
};

// ----------------- 事件处理 -----------------

const handleUserReply = async (
  taskId: string,
  event: TaskEvent,
  info: ModeCacheEntry,
): Promise<void> => {
  const g = getOutboundGlobal();
  const existing = g.turns.get(taskId);
  const text = event.text ?? "";

  // 卡片已开还没 done——正常链路 user_reply 先于 assistant 活动落盘，这里只剩
  // 「persist 晚于首个 delta 几 ms」的竞态：不拆轮（拆会把半截卡提前 finalize）、
  // echo 放弃、只更新重试文案。done 清轮后新 user_reply 自然走新一轮。
  if (
    existing &&
    !existing.finalized &&
    (existing.started ||
      existing.startPromise ||
      existing.processParts.length > 0 ||
      existing.answerText)
  ) {
    existing.lastUserMessage = text || existing.lastUserMessage;
    return;
  }

  // 队列 flush 场景：assistant 还没动、连续多条 user_reply → 合并进同一轮回显
  // （方案 4.5「排队消息合并显示」）；无 turn / 上一轮已 finalize → 新一轮
  const canMerge = existing && !existing.finalized;
  const turn = canMerge ? existing : await beginNewTurn(taskId, info);
  const fromFeishu = event.meta?.source === "feishu";
  // 决策 #1：飞书侧消息不嵌回显（飞书本来就有这条、回显只会让消息翻倍）
  if (!fromFeishu) {
    const lines: string[] = [];
    if (text.trim()) lines.push(text.trim());
    // 本机路径附件：列文本 +「仅本机可读」（矩阵 4.5、飞书侧不假装可点）
    lines.push(...parseEchoAttachments(event.meta));
    if (lines.length > 0) {
      const chunk = lines.join("\n");
      turn.echoText = turn.echoText ? `${turn.echoText}\n${chunk}` : chunk;
    }
    turn.echoImageAbsPaths.push(...parseEchoImages(event.meta));
  }
  turn.lastUserMessage = text;
  turn.turnStartedAt = Date.now();
};

const handleThinking = (taskId: string, event: TaskEvent, turn: TurnState): void => {
  const text = (event.text ?? "").trim();
  if (!text) return;
  turn.processParts.push({ kind: "thinking", text });
  pushProcessUpdate(taskId, turn);
  // Hermes：思考阶段不写 header subtitle（状态靠 footer spinner「生成中」）
  withCard(taskId, turn, (card) => {
    card.setHeaderStatus("", "blue");
  });
};

const handleToolCall = (
  taskId: string,
  event: TaskEvent,
  turn: TurnState,
): void => {
  const meta = event.meta;
  const callId =
    (meta && typeof meta.callId === "string" && meta.callId) ||
    `anon_${turn.toolCount + 1}`;
  const name = toolNameFromMeta(meta);
  const argsSummary = argsSummaryFromMeta(meta, event.text ?? "");
  const indexes = getOutboundGlobal().toolIndexes.get(taskId) ?? new Map();
  getOutboundGlobal().toolIndexes.set(taskId, indexes);

  const existingIdx = indexes.get(callId);
  if (existingIdx != null) {
    const part = turn.processParts[existingIdx];
    if (part && part.kind === "tool") {
      part.name = name;
      part.argsSummary = argsSummary;
      part.status = "running";
    }
  } else {
    turn.toolCount += 1;
    const idx = turn.processParts.length;
    turn.processParts.push({
      kind: "tool",
      callId,
      name,
      argsSummary,
      status: "running",
    });
    indexes.set(callId, idx);
  }
  turn.currentToolName = name;
  turn.currentToolArgs = argsSummary;
  pushProcessUpdate(taskId, turn);
  updateToolHeader(taskId, turn);
};

const handleToolResult = (
  taskId: string,
  event: TaskEvent,
  turn: TurnState,
): void => {
  const meta = event.meta;
  const callId =
    (meta && typeof meta.callId === "string" && meta.callId) || "";
  const statusRaw = meta && typeof meta.status === "string" ? meta.status : "";
  const ok = statusRaw !== "error";
  const name = toolNameFromMeta(meta, turn.currentToolName || "tool");
  const argsSummary = argsSummaryFromMeta(meta, event.text ?? "");
  const indexes = getOutboundGlobal().toolIndexes.get(taskId) ?? new Map();

  const idx = callId ? indexes.get(callId) : undefined;
  if (idx != null) {
    const part = turn.processParts[idx];
    if (part && part.kind === "tool") {
      part.status = ok ? "ok" : "err";
      if (!part.name) part.name = name;
      // result 常不带 args——保留 call 时摘要作 header 预览
      if (argsSummary && argsSummary !== "…") {
        part.argsSummary = argsSummary;
      }
    }
  } else {
    // 没见过 running（偶发只落 result）→ 直接追加完成行
    turn.toolCount += 1;
    turn.processParts.push({
      kind: "tool",
      callId: callId || `result_${turn.toolCount}`,
      name,
      argsSummary,
      status: ok ? "ok" : "err",
    });
  }
  turn.currentToolName = name;
  if (argsSummary && argsSummary !== "…") {
    turn.currentToolArgs = argsSummary;
  } else {
    // 沿用 processParts 里该工具的摘要
    const partIdx = callId ? indexes.get(callId) : undefined;
    const part = partIdx != null ? turn.processParts[partIdx] : undefined;
    if (part && part.kind === "tool" && part.argsSummary) {
      turn.currentToolArgs = part.argsSummary;
    }
  }
  pushProcessUpdate(taskId, turn);
  updateToolHeader(taskId, turn);
};

const handleAssistantDelta = (
  taskId: string,
  text: string,
  turn: TurnState,
): void => {
  if (!text) return;
  // sdk-message-handler：assistant_delta.text 是增量 chunk，不是全量快照
  turn.answerText += text;
  const snapshot = turn.answerText;
  withCard(taskId, turn, (card) => {
    card.pushAnswer(snapshot);
  });
};

const handleAskUser = (
  taskId: string,
  event: TaskEvent,
  turn: TurnState,
): void => {
  const opts = askOptsFromEvent(event);
  if (!opts) return;
  withCard(taskId, turn, async (card) => {
    await card.appendAskUser(opts);
  });
};

const finalizeTurn = async (
  taskId: string,
  turn: TurnState,
  opts: { ok: boolean; error?: string },
): Promise<void> => {
  if (turn.finalized) return;
  turn.finalized = true;

  // 若从未有 assistant 活动（没建卡）→ 直接清状态
  if (!turn.startPromise && !turn.started) {
    clearTurn(taskId);
    return;
  }

  try {
    if (turn.startPromise) await turn.startPromise;
    const card = turn.card;
    if (!card || !turn.started) {
      clearTurn(taskId);
      return;
    }

    // 决策 #12 简化：流式期间本地图路径原样；finalize 前一次性换 image_key 再全量 PUT
    if (turn.answerText) {
      const replaced = await replaceLocalImagesInMarkdown(
        turn.answerText,
        uploadImageImpl,
        taskId,
      );
      turn.answerText = replaced;
      card.pushAnswer(replaced);
    }

    await card.finalize({
      ok: opts.ok,
      durationMs: Date.now() - turn.turnStartedAt,
      model: turn.modelId,
      error: opts.error,
    });

    if (!opts.ok) {
      await card.appendRetryButton(turn.lastUserMessage || "");
    }

    // review P1#4 / 坑 #10：连续出向失败要在 app 内可见（每轮最多一条 info）
    const fails = card.getFailCount();
    if (fails >= 3) {
      try {
        // 系统 info：写+publish 同链（对齐 chat-reply 清队通知写法）
        await writeEventAndPublish(taskId, {
          kind: "info",
          text: `飞书卡片推送异常（${fails} 次失败），本轮回复可能未同步到飞书`,
        });
      } catch (logErr) {
        console.warn(
          `[feishu-bridge/outbound] 写失败可见 info 失败 task=${taskId}:`,
          logErr instanceof Error ? logErr.message : logErr,
        );
      }
    }
  } catch (err) {
    console.warn(
      `[feishu-bridge/outbound] finalize 失败 task=${taskId}:`,
      err instanceof Error ? err.message : err,
    );
  } finally {
    clearTurn(taskId);
  }
};

const isAssistantActivityEvent = (ev: TaskStreamEvent): boolean => {
  if (ev.kind === "assistant_delta") return true;
  if (ev.kind !== "event") return false;
  const k = ev.event.kind;
  return (
    k === "thinking" ||
    k === "tool_call" ||
    k === "tool_result" ||
    k === "ask_user_request" ||
    k === "assistant_message"
  );
};

/**
 * 处理单条流事件（对外可测）。
 * 整段 try/catch——任何异常不得影响 chat-runner 主流程。
 */
export const handleFeishuOutboundEvent = async (
  taskId: string,
  ev: TaskStreamEvent,
): Promise<void> => {
  try {
    const enabled = await isBridgeEnabledCached();
    if (!enabled) return;

    // task / done 事件自带 Task——零成本刷新 mode/title 缓存（标题派生后卡片跟着新）
    if ((ev.kind === "task" || ev.kind === "done") && ev.task) {
      setModeCache(taskId, taskInfoFromTask(ev.task));
    }

    const info = await resolveTaskInfo(taskId);
    if (!info?.isChat) return;

    // —— user_reply：开新轮 / 累积 echo ——
    if (ev.kind === "event" && ev.event.kind === "user_reply") {
      await handleUserReply(taskId, ev.event, info);
      return;
    }

    const g = getOutboundGlobal();
    let turn = g.turns.get(taskId);

    // 无 turn（漏了 user_reply、或开关中途打开）→ 首个 assistant 活动时补建空 echo 轮
    if (!turn && isAssistantActivityEvent(ev)) {
      turn = getOrCreateTurn(taskId, info);
      turn.turnStartedAt = Date.now();
    }
    if (!turn || turn.finalized) return;

    // 刷新标题/模型（缓存可能过期）
    turn.title = info.title;
    if (info.modelId) turn.modelId = info.modelId;

    if (ev.kind === "assistant_delta") {
      handleAssistantDelta(taskId, ev.text, turn);
      return;
    }

    if (ev.kind === "done") {
      await finalizeTurn(taskId, turn, {
        ok: ev.ok,
        // 失败时用本轮最近落盘的 error 事件文案（handleChatRunFailure 先写事件再发 done）
        error: ev.ok ? undefined : turn.lastError || "出错",
      });
      return;
    }

    if (ev.kind === "error") {
      // SSE 顶层 error 总在 done(ok=false) 之后发（handleChatRunFailure 顺序）——
      // done 已 finalize 清 turn、这里通常摸不到；兜底路径：还有 turn 就按失败收尾
      await finalizeTurn(taskId, turn, {
        ok: false,
        error: ev.message || turn.lastError || "出错",
      });
      return;
    }

    if (ev.kind !== "event") return;
    const event = ev.event;

    switch (event.kind) {
      case "thinking":
        handleThinking(taskId, event, turn);
        break;
      case "tool_call":
        handleToolCall(taskId, event, turn);
        break;
      case "tool_result":
        handleToolResult(taskId, event, turn);
        break;
      case "ask_user_request":
        handleAskUser(taskId, event, turn);
        break;
      case "error":
        // 落盘 error 事件不立即 finalize（tool 失败也发 error 但 run 未终止）；
        // 记文案、等 done(ok=false) 时作 finalize 错误行
        turn.lastError = event.text || turn.lastError;
        break;
      case "assistant_message":
        // 完整落盘消息：若 delta 已累积则忽略；否则用全文补一次（flush 无 delta 的边界）
        if (!turn.answerText && event.text) {
          turn.answerText = event.text;
          withCard(taskId, turn, (card) => {
            card.pushAnswer(event.text);
          });
        }
        break;
      default:
        break;
    }
  } catch (err) {
    console.warn(
      `[feishu-bridge/outbound] 处理事件失败 task=${taskId}:`,
      err instanceof Error ? err.message : err,
    );
  }
};

/**
 * per-task 串行入链：publish 是同步 fanout、但 handle 内部有 await——
 * 不入链的话同 task 的事件会 microtask 交错（done 越过还没排上的 delta）。
 * chains entry 不主动清（value 是已 settle 的 Promise、量级 = 任务数，可接受）。
 */
const enqueueOutboundEvent = (taskId: string, ev: TaskStreamEvent): void => {
  const g = getOutboundGlobal();
  const prev = g.chains.get(taskId) ?? Promise.resolve();
  g.chains.set(
    taskId,
    prev.then(() => handleFeishuOutboundEvent(taskId, ev)),
  );
};

/**
 * 幂等注册全局 tap（instrumentation / 模块加载调用）。
 * 挂 globalThis——dev 热重载不重复订阅。
 */
export const ensureFeishuOutboundRegistered = (): void => {
  const g = getOutboundGlobal();
  if (g.registered) return;
  g.registered = true;
  g.unsub = subscribeAllTaskStreams((taskId, ev) => {
    enqueueOutboundEvent(taskId, ev);
  });
  console.log("[feishu-bridge/outbound] 已注册全局 tap");
};
