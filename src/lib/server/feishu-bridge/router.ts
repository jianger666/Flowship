/**
 * 飞书入向消息路由（4.3 / 4.4 / 4.5）
 *
 * 流程：p2p + 本人过滤 → 解析 content → 命令词扩展点 → 定位 task →
 * pendingAsk ? ask-inject : chat-inject → 结果钩子 / 失败文本回执。
 *
 * 命令词（/stop /list …）与 reaction 回执由 S3c 注册；本文件只留扩展点。
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ModelSelection } from "@cursor/sdk";

import { handleChatReplyInject } from "@/lib/server/chat-inject";
import { getPendingAsk } from "@/lib/server/chat-pending";
import { createTask, getTaskMeta, listTasks } from "@/lib/server/task-fs";
import { prewarmTaskWorkspace } from "@/lib/server/task-runner";
import { readSettingsFile } from "@/lib/server/settings-fs";
import { listSkillsWithSource } from "@/lib/server/app-skills";
import { matchLongestSkillName } from "@/lib/skill-token";
import { isValidModel } from "@/lib/server/route-helpers";
import {
  extractInteractiveText,
  parseTextContent,
} from "@/lib/server/route-helpers";
import {
  defaultModelForProvider,
  isCursorProvider,
  type FeAiFlowSettings,
  type TaskSummary,
} from "@/lib/types";
import {
  DANGLING_TASK_PROVIDER_MESSAGE,
  bootArgsForTask,
  findCustomProvider,
  isTaskProviderDangling,
  migrateProviderSettings,
} from "@/lib/agent-provider";

import { injectPendingAskText } from "./ask-inject";
import { placeAttachment } from "./attachment-store";
import {
  isGroupChatMessage,
  routeGroupInboundMessage,
} from "./group-route";
import {
  getCurrentChatTaskId,
  getEndedChatTaskIds,
  peekAwaitingChatSearch,
  removeEndedChatTaskId,
  setCurrentChatTaskId,
  takeAwaitingChatSearch,
} from "./bridge-state";
import { findTaskByMessageId, rememberCardMessage } from "./card-map";
import {
  defaultExtractVideoPreview,
  type VideoPreview,
} from "./video-frames";
import { buildQuotedBlock, resolveQuoteAnchorId } from "./group-quote";
import { resolveInboundQuote, type InboundQuote } from "./inbound-quote";
import {
  downloadMessageResource,
  fetchInboundMessageDetail,
  getBotAppInfo,
  larkApi,
  sendTextMessage,
} from "./lark-api";
import type { FeishuInboundMessage } from "./types";

// ----------------- 常量 -----------------

/** 过滤跳过原因（inbound 据此判断「是否本人 p2p」、决定要不要推进补拉状态） */
export const SKIP_NOT_P2P = "非 p2p";
export const SKIP_NOT_OWNER = "非本人消息";

/**
 * 「进行中」活跃窗（仅 /list 展示 + 指针失效后的活跃数兜底）。
 * 直发路由优先走「当前对话指针」，不受本窗限制——上午聊的下午直发仍进指针对话。
 */
const ACTIVE_CHAT_WINDOW_MS = 2 * 60 * 60 * 1000;
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 30 * 1024 * 1024;
/** review P1#2：入向文件体积上限（方案 4.5 降级「超大 → bot 回提示」） */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const TITLE_PREFIX_LEN = 20;
/** 单次注入的附件路径上限（对齐 chat-inject 的 MAX_ATTACHMENTS_PER_REPLY；引用里的附件只往余量里塞） */
const MAX_ATTACHMENTS = 10;
/**
 * 引用的是机器人自己的旧回复时给 agent 的字数上限。单聊里「回复某张卡片」本来就是用来路由到那个对话的
 * （agent 上文已有完整内容），不压的话每次回复卡片都会重复塞一大段；留开头足够认出是哪一条。
 */
const QUOTE_SELF_TEXT_MAX_CHARS = 800;

// ----------------- 命令扩展点（S3c 注册） -----------------

export type BridgeCommandContext = {
  msg: FeishuInboundMessage;
  /** 命令名（不含 /） */
  command: string;
  /** `/cmd` 后的剩余文本 */
  args: string;
  /** 完整原文 */
  text: string;
};

/**
 * handled = 已处理完、router 记 sent；
 * handled_failed = 命令已处理但失败（用户已收失败文本）、router 记 failed（不 retryable）；
 * passthrough = 未吃掉、继续当普通文本（或 skill）走。
 */
export type BridgeCommandHandler = (
  ctx: BridgeCommandContext,
) => Promise<"handled" | "handled_failed" | "passthrough">;

const commandHandlers = new Map<string, BridgeCommandHandler>();

/** 注册 `/name` 命令；同名覆盖 */
export const registerBridgeCommand = (
  name: string,
  handler: BridgeCommandHandler,
): void => {
  const key = name.replace(/^\//, "").trim().toLowerCase();
  if (!key) return;
  commandHandlers.set(key, handler);
};

/** 单测清命令表 */
export const __clearBridgeCommandsForTest = (): void => {
  commandHandlers.clear();
};

// ----------------- card.action 扩展点（S3b 实现） -----------------

export type CardActionHandler = (event: unknown) => Promise<void>;

let cardActionHandler: CardActionHandler | null = null;

/** 注册 card.action.trigger 处理器（S3b 实现）；传 null 注销（测试清理用） */
export const registerCardActionHandler = (
  handler: CardActionHandler | null,
): void => {
  cardActionHandler = handler;
};

/** inbound 把 card.action.trigger NDJSON 原样丢进来 */
export const dispatchCardActionEvent = async (event: unknown): Promise<void> => {
  if (!cardActionHandler) {
    console.warn(
      "[feishu-bridge/router] card.action.trigger 无 handler（S3b 未接）、丢弃",
    );
    return;
  }
  await cardActionHandler(event);
};

// ----------------- 注入结果钩子（S3c：reaction + 撤回出队多订阅） -----------------

export type InjectResultKind = "sent" | "queued" | "failed" | "skipped";

export type InjectResultPayload = {
  kind: InjectResultKind;
  messageId: string;
  taskId?: string;
  error?: string;
  /** 入队/注入时的用户文本（撤回出队按文本匹配用；可选） */
  text?: string;
  /**
   * R1-6：基础设施类失败可重试——inbound 不 markProcessed，等补拉重投。
   * 内容终态（unsupported / 图超限 / 空消息 / 队满 409 / 命令失败文案）不标。
   */
  retryable?: boolean;
};

type InjectResultCb = (payload: InjectResultPayload) => void | Promise<void>;

/** 多订阅者：reactions 等各自 listen，互不覆盖 */
const injectResultListeners = new Set<InjectResultCb>();

/**
 * 追加注入结果监听；返回注销函数。
 * reactions 等订阅方用这个，避免单回调互相踩。
 */
export const addInjectResultListener = (
  cb: InjectResultCb,
): (() => void) => {
  injectResultListeners.add(cb);
  return () => {
    injectResultListeners.delete(cb);
  };
};

/**
 * 兼容旧单测：传 cb 则清空后只挂这一个；传 null 清空全部。
 * 生产代码请用 addInjectResultListener。
 */
export const onInjectResult = (cb: InjectResultCb | null): void => {
  injectResultListeners.clear();
  if (cb) injectResultListeners.add(cb);
};

/** 单测清空监听 */
export const __clearInjectResultListenersForTest = (): void => {
  injectResultListeners.clear();
};

const emitInjectResult = async (payload: InjectResultPayload): Promise<void> => {
  if (injectResultListeners.size === 0) return;
  for (const cb of [...injectResultListeners]) {
    try {
      await cb(payload);
    } catch (err) {
      console.warn(
        "[feishu-bridge/router] injectResult 回调失败:",
        err instanceof Error ? err.message : err,
      );
    }
  }
};

/** 单测触发注入结果钩子（reactions 等） */
export const __emitInjectResultForTest = (
  payload: InjectResultPayload,
): Promise<void> => emitInjectResult(payload);

// ----------------- 可注入依赖（单测 mock） -----------------

type RouterDeps = {
  getBotAppInfo: typeof getBotAppInfo;
  sendTextMessage: typeof sendTextMessage;
  downloadMessageResource: typeof downloadMessageResource;
  findTaskByMessageId: typeof findTaskByMessageId;
  rememberCardMessage: typeof rememberCardMessage;
  larkApi: typeof larkApi;
  listTasks: typeof listTasks;
  /** 注入前读窗口 meta（取窗口所选 model / provider 算 bootArgs；轻量读、不 hydrate events） */
  getTaskMeta: typeof getTaskMeta;
  createTask: typeof createTask;
  getPendingAsk: typeof getPendingAsk;
  handleChatReplyInject: typeof handleChatReplyInject;
  injectPendingAskText: typeof injectPendingAskText;
  readSettingsFile: typeof readSettingsFile;
  listSkillsWithSource: typeof listSkillsWithSource;
  prewarmTaskWorkspace: typeof prewarmTaskWorkspace;
  /** 大视频抽帧预览（best-effort，失败返回 null，调用方退化处理） */
  extractVideoPreview: typeof defaultExtractVideoPreview;
  /** 取回被回复 / 引用的那条消息（best-effort，取不到返回 null） */
  fetchInboundMessageDetail: typeof fetchInboundMessageDetail;
};

let deps: RouterDeps = {
  getBotAppInfo,
  sendTextMessage,
  downloadMessageResource,
  findTaskByMessageId,
  rememberCardMessage,
  larkApi,
  listTasks,
  getTaskMeta,
  createTask,
  getPendingAsk,
  handleChatReplyInject,
  injectPendingAskText,
  readSettingsFile,
  listSkillsWithSource,
  prewarmTaskWorkspace,
  extractVideoPreview: defaultExtractVideoPreview,
  fetchInboundMessageDetail,
};

/** 单测替换依赖；传 null 恢复 */
export const __setRouterDepsForTest = (
  partial: Partial<RouterDeps> | null,
): void => {
  if (!partial) {
    deps = {
      getBotAppInfo,
      sendTextMessage,
      downloadMessageResource,
      findTaskByMessageId,
      rememberCardMessage,
      larkApi,
      listTasks,
      getTaskMeta,
      createTask,
      getPendingAsk,
      handleChatReplyInject,
      injectPendingAskText,
      readSettingsFile,
      listSkillsWithSource,
      prewarmTaskWorkspace,
      extractVideoPreview: defaultExtractVideoPreview,
      fetchInboundMessageDetail,
    };
    return;
  }
  deps = { ...deps, ...partial };
};

// ----------------- content 解析 -----------------

export type ParsedInboundContent = {
  text: string;
  images: Array<{ data: string; mimeType: string; filename?: string }>;
  attachments: string[];
  unsupported?: string;
  /**
   * 资源（图 / 文件 / 视频）**尚未下载**——只有 `parseInboundContent(msg, { deferDownloads: true })`
   * 才会带，且仅当消息里确有资源可下。此时 `images` / `attachments` 为空、`text` 是不含下载结果的预解析正文。
   * 用途：群里非属主的消息要先过鉴权 / 限流 / 忙线闸门，通过后才值得下载（见 group-route）；
   * `resolve()` 才真正下载并返回完整解析结果（成功后缓存、失败可重试）。
   */
  deferred?: {
    /** 待下载的资源里含图片（排队闸据此判「带图不排」，与下载后的 images.length>0 同口径） */
    hasImages: boolean;
    resolve: () => Promise<ParsedInboundContent>;
  };
};

/** 预解析模式（只数资源、不下载）的探针：dry=true 时各下载点只计数后跳过 */
type ResourceProbe = { dry: boolean; images: number; files: number };

const tryParseJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** text content：裸字符串 或 `{"text":"..."}` 都兼容（实现见 route-helpers，group-route 共用；
 * 旧引用 `import { parseTextContent } from "./router"` 由文件末尾重导出兼容） */
export { parseTextContent } from "@/lib/server/route-helpers";

const mimeFromExt = (p: string): string => {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "image/png";
};

const fileToBase64Image = async (
  absPath: string,
): Promise<{ data: string; mimeType: string; filename: string } | null> => {
  // 先 stat 再读：超限的图直接跳过，不把几十 MB 整个读进内存再判（旧实现 readFile 完才比大小）。
  // 读完后再核一次（stat 与 read 之间文件可能还在变）
  const st = await fs.stat(absPath);
  if (st.size > MAX_IMAGE_BYTES) return null;
  const buf = await fs.readFile(absPath);
  if (buf.length > MAX_IMAGE_BYTES) return null;
  return {
    data: buf.toString("base64"),
    mimeType: mimeFromExt(absPath),
    filename: path.basename(absPath),
  };
};

/**
 * lark-cli event/mget enrichment（convertlib Process hook）把 content 预渲染成
 * 人类可读文本、不是官方 OpenAPI 的 JSON（实证 2026-07-19）：
 * - post 图文混排 → `![Image](img_v3_xxx)\n正文`
 * - file 消息 → `<file key="file_v3_xxx" name="report.pdf"/>`
 * - image 消息 → `![Image](img_xxx)`
 * 所以各分支都要「JSON 优先、渲染文本兜底」双形态兼容。
 */
const MD_IMAGE_RE = /!\[[^\]]*\]\((img_[A-Za-z0-9_-]+)\)/g;
/** enrichment 渲染的文件标记：`<file key="file_xxx" name="…"/>`（name 可缺省） */
const FILE_TAG_RE =
  /<file\s+key="(file_[A-Za-z0-9_-]+)"(?:\s+name="([^"]*)")?\s*\/>/;
/** markdown 链接形态的文件引用：`[report.pdf](file_xxx)`（不含 `!` 前缀、以免吃掉图占位） */
const MD_FILE_LINK_RE = /(?<!!)\[([^\]]*)\]\((file_[A-Za-z0-9_-]+)\)/;

/** 从 enrichment 渲染文本里提取文件引用（两种形态）；提不到返 null */
const extractFileRef = (
  content: string,
): { fileKey: string; fileName: string } | null => {
  const tag = FILE_TAG_RE.exec(content);
  if (tag?.[1]) {
    return { fileKey: tag[1], fileName: tag[2] || "file" };
  }
  const link = MD_FILE_LINK_RE.exec(content);
  if (link?.[2]) {
    return { fileKey: link[2], fileName: link[1] || "file" };
  }
  return null;
};

/**
 * 已下载文件落附件：挪进 `attachments/<messageId>/` + 50MB 上限（file / media 共用）。
 * 下载文件 key → 落盘为附件路径的入口见 downloadFileAttachment。
 *
 * 文件名是发件人给的（可被构造）：旧实现直接 rename 成「bridge 目录顶层 + 发件人文件名」，
 * 文件名叫 `bridge-state.json` / `card-map.json` 就把状态文件覆盖了、同名附件也互相覆盖。
 * 现在走 attachment-store.placeAttachment：子目录 + 净化文件名 + 唯一前缀（见该模块头注释）。
 */
const finalizeAttachment = async (
  abs: string,
  fileName: string,
  messageId: string,
): Promise<{ path: string } | { error: string }> => {
  let finalPath = abs;
  try {
    finalPath = await placeAttachment(abs, fileName, messageId);
  } catch {
    // 挪不动就沿用下载产物原路径（`dl-<ts>-<key>`，不会撞任何状态文件；TTL 清扫也认 dl-*）
    finalPath = abs;
  }
  // review P1#2：超过 50MB → 删临时文件 + 错误文案（route 侧 notifyOwnerError）
  try {
    const st = await fs.stat(finalPath);
    if (st.size > MAX_FILE_BYTES) {
      await fs.unlink(finalPath).catch(() => undefined);
      return { error: "文件超过 50MB 上限" };
    }
  } catch (err) {
    await fs.unlink(finalPath).catch(() => undefined);
    return {
      error: `文件校验失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { path: finalPath };
};

/**
 * 下载文件 key → 落盘为附件路径（改回原文件名 + 50MB 校验）。
 * file 分支与 text/post 的 markdown 文件链接共用。
 */
const downloadFileAttachment = async (
  messageId: string,
  fileKey: string,
  fileName: string,
): Promise<{ path: string } | { error: string }> => {
  const abs = await deps.downloadMessageResource(messageId, fileKey, "file");
  return finalizeAttachment(abs, fileName, messageId);
};

/** 大视频交代文案用：字节 → MB/GB（一档小数） */
const formatByteSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  }
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))}MB`;
};

/** 大视频交代文案用：秒 → X分Y秒 / X秒（取不到时长返回空） */
const formatVideoDuration = (sec: number | null): string => {
  if (sec === null || !(sec > 0)) return "";
  const s = Math.round(sec);
  if (s < 60) return `${s}秒`;
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, "0")}秒`;
};

/** text/post 正文里的 markdown 文件链接 → 下载进 attachments、剥掉占位 */
const extractMarkdownFiles = async (
  messageId: string,
  text: string,
  probe?: ResourceProbe,
): Promise<{ text: string; attachments: string[] }> => {
  const attachments: string[] = [];
  const re = new RegExp(MD_FILE_LINK_RE.source, "g");
  const refs: Array<{ fileKey: string; fileName: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[2]) refs.push({ fileKey: m[2], fileName: m[1] || "file" });
  }
  if (refs.length === 0) return { text, attachments };
  const stripped = text
    .replace(new RegExp(MD_FILE_LINK_RE.source, "g"), "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // 预解析：只数资源、剥占位，不下载
  if (probe?.dry) {
    probe.files += refs.length;
    return { text: stripped, attachments };
  }
  for (const ref of refs) {
    try {
      const r = await downloadFileAttachment(
        messageId,
        ref.fileKey,
        ref.fileName,
      );
      if ("path" in r) attachments.push(r.path);
      else console.warn("[feishu-bridge/router] markdown 文件跳过:", r.error);
    } catch (err) {
      console.warn(
        "[feishu-bridge/router] markdown 文件下载失败:",
        ref.fileKey,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { text: stripped, attachments };
};

const extractMarkdownImages = async (
  messageId: string,
  text: string,
  seed: {
    images: ParsedInboundContent["images"];
    totalBytes: number;
  } = { images: [], totalBytes: 0 },
  probe?: ResourceProbe,
): Promise<{
  text: string;
  images: ParsedInboundContent["images"];
  totalBytes: number;
}> => {
  const images = [...seed.images];
  let totalBytes = seed.totalBytes;
  const keys: string[] = [];
  const re = new RegExp(MD_IMAGE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) keys.push(m[1]);
  }
  if (keys.length === 0) {
    return { text, images, totalBytes };
  }
  // 剥掉图占位，保留其余文字；行内多余空格 / 空行压一下
  const stripped = text
    .replace(new RegExp(MD_IMAGE_RE.source, "g"), "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // 预解析：只数资源、剥占位，不下载
  if (probe?.dry) {
    probe.images += keys.length;
    return { text: stripped, images, totalBytes };
  }

  for (const key of keys) {
    if (images.length >= MAX_IMAGES) break;
    try {
      const abs = await deps.downloadMessageResource(messageId, key, "image");
      // 转完即删：bridge 目录无 TTL，不删会堆积 dl-* 小图
      let img: { data: string; mimeType: string; filename: string } | null;
      try {
        img = await fileToBase64Image(abs);
      } finally {
        await fs.unlink(abs).catch(() => undefined);
      }
      if (!img) continue;
      const approx = Math.floor((img.data.length * 3) / 4);
      if (totalBytes + approx > MAX_TOTAL_IMAGE_BYTES) continue;
      totalBytes += approx;
      images.push(img);
    } catch (err) {
      console.warn(
        "[feishu-bridge/router] markdown 图下载失败:",
        key,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { text: stripped, images, totalBytes };
};

/**
 * 按 message_type 解析为 chat-inject 可用载荷（实现体）。
 * `probe.dry` = 预解析：各下载点只计数资源、跳过下载，见 {@link parseInboundContent} 的 deferDownloads。
 */
const parseInboundContentImpl = async (
  msg: FeishuInboundMessage,
  probe?: ResourceProbe,
): Promise<ParsedInboundContent> => {
  const type = msg.message_type;
  if (type === "text") {
    // text 也可能被 enrichment 成带 ![Image](img_…) / [名称](file_…) 的 markdown
    const rawText = parseTextContent(msg.content);
    const md = await extractMarkdownImages(msg.message_id, rawText, undefined, probe);
    const mf = await extractMarkdownFiles(msg.message_id, md.text, probe);
    return { text: mf.text, images: md.images, attachments: mf.attachments };
  }

  if (type === "image") {
    const obj = tryParseJson(msg.content) as Record<string, unknown> | null;
    // enrichment 渲染形态兜底：content 是 `![Image](img_xxx)` 而非 JSON
    const mdKey = new RegExp(MD_IMAGE_RE.source).exec(msg.content)?.[1] || "";
    const imageKey =
      (obj && typeof obj.image_key === "string" && obj.image_key) ||
      (obj && typeof obj.file_key === "string" && obj.file_key) ||
      mdKey;
    if (!imageKey) {
      return {
        text: "",
        images: [],
        attachments: [],
        unsupported: "图片消息缺少 image_key",
      };
    }
    if (probe?.dry) {
      probe.images += 1;
      return { text: "", images: [], attachments: [] };
    }
    const abs = await deps.downloadMessageResource(
      msg.message_id,
      imageKey,
      "image",
    );
    // 转完即删：bridge 目录无 TTL（与 markdown/post 分支同手法，try/finally 防读失败漏删）
    let img: { data: string; mimeType: string; filename: string } | null;
    try {
      img = await fileToBase64Image(abs);
    } finally {
      await fs.unlink(abs).catch(() => undefined);
    }
    if (!img) {
      return {
        text: "",
        images: [],
        attachments: [],
        unsupported: `图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 上限`,
      };
    }
    return { text: "", images: [img], attachments: [] };
  }

  if (type === "file") {
    const obj = tryParseJson(msg.content) as Record<string, unknown> | null;
    // enrichment 渲染形态兜底（T4 实证根因）：consumer 下发的 content 是
    // `<file key="file_v3_xxx" name="…"/>` 而非 JSON → tryParseJson 必 null、
    // 旧逻辑直接 unsupported「缺少 file_key」、附件永远注入不了
    const ref = extractFileRef(msg.content);
    const fileKey =
      (obj && typeof obj.file_key === "string" && obj.file_key) ||
      ref?.fileKey ||
      "";
    const fileName =
      (obj && typeof obj.file_name === "string" && obj.file_name) ||
      ref?.fileName ||
      "file";
    if (!fileKey) {
      return {
        text: "",
        images: [],
        attachments: [],
        unsupported: "文件消息缺少 file_key",
      };
    }
    if (probe?.dry) {
      probe.files += 1;
      return { text: "", images: [], attachments: [] };
    }
    const r = await downloadFileAttachment(msg.message_id, fileKey, fileName);
    if ("error" in r) {
      return { text: "", images: [], attachments: [], unsupported: r.error };
    }
    return { text: "", images: [], attachments: [r.path] };
  }

  if (type === "post") {
    // post 两种形态都要兼容：
    // 1) 官方 OpenAPI：JSON 节点树（tag=img + image_key）
    // 2) lark-cli enrichment：markdown 字符串 `![Image](img_v3_…)\n正文`
    const textParts: string[] = [];
    const images: ParsedInboundContent["images"] = [];
    let totalBytes = 0;
    const walk = async (node: unknown): Promise<void> => {
      if (!node) return;
      if (typeof node === "string") {
        textParts.push(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const n of node) await walk(n);
        return;
      }
      if (typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      if (typeof o.text === "string") textParts.push(o.text);
      if (o.tag === "img" || o.tag === "image") {
        const key =
          (typeof o.image_key === "string" && o.image_key) ||
          (typeof o.file_key === "string" && o.file_key) ||
          "";
        if (key && probe?.dry) {
          // 预解析：只计数（dry 下 images 恒空，MAX_IMAGES 闸不适用）
          probe.images += 1;
        } else if (key && images.length < MAX_IMAGES) {
          try {
            const abs = await deps.downloadMessageResource(
              msg.message_id,
              key,
              "image",
            );
            // 转完即删：bridge 目录无 TTL
            let img: { data: string; mimeType: string; filename: string } | null;
            try {
              img = await fileToBase64Image(abs);
            } finally {
              await fs.unlink(abs).catch(() => undefined);
            }
            if (img) {
              const approx = Math.floor((img.data.length * 3) / 4);
              if (totalBytes + approx <= MAX_TOTAL_IMAGE_BYTES) {
                totalBytes += approx;
                images.push(img);
              }
            }
          } catch (err) {
            console.warn(
              "[feishu-bridge/router] post 内图片下载失败:",
              err instanceof Error ? err.message : err,
            );
          }
        }
      }
      if (o.content !== undefined) await walk(o.content);
      // zh_cn / en_us 等语言块（content 已单独 walk，勿重复）
      for (const [k, v] of Object.entries(o)) {
        if (
          k === "text" ||
          k === "tag" ||
          k === "image_key" ||
          k === "file_key" ||
          k === "content"
        )
          continue;
        if (typeof v === "object") await walk(v);
      }
    };
    const parsed = tryParseJson(msg.content);
    if (parsed) {
      await walk(parsed);
      // JSON 树已抽过 img 节点；正文里若仍残留 markdown 图/文件引用再补一轮
      const md = await extractMarkdownImages(
        msg.message_id,
        textParts.join("").trim(),
        { images, totalBytes },
        probe,
      );
      const mf = await extractMarkdownFiles(msg.message_id, md.text, probe);
      return { text: mf.text, images: md.images, attachments: mf.attachments };
    }
    // enrichment markdown 字符串路径（真机验收实证形态）
    const md = await extractMarkdownImages(msg.message_id, msg.content, undefined, probe);
    const mf = await extractMarkdownFiles(msg.message_id, md.text, probe);
    return { text: mf.text, images: md.images, attachments: mf.attachments };
  }

  if (type === "media") {
    // 视频消息：content JSON {"file_key":"file_v3_…","image_key":"img_v3_…"}。
    // 封面图 → images（agent 看得见）；视频本体分档：
    // - ≤50MB → attachments（完整文件）；
    // - 超限（几个 GB 的视频）→ 抽帧预览 + 删原文件 + 文字交代，不回 unsupported。
    const obj = tryParseJson(msg.content) as Record<string, unknown> | null;
    const fileKey =
      (obj && typeof obj.file_key === "string" && obj.file_key) ||
      // enrichment 渲染兜底（file 分支 T4 实证：consumer 下发 <file key="…"/> 而非 JSON）
      extractFileRef(msg.content)?.fileKey ||
      "";
    const imageKey =
      (obj && typeof obj.image_key === "string" && obj.image_key) || "";
    if (!fileKey) {
      // 记下真实形态、方便以后补双形态兼容
      console.warn(
        "[feishu-bridge/router] media 缺少 file_key、content 前 200 字:",
        msg.content.slice(0, 200),
      );
      return {
        text: "",
        images: [],
        attachments: [],
        unsupported: "视频消息缺少 file_key",
      };
    }
    if (probe?.dry) {
      // 预解析：封面（图）+ 视频本体（文件）都待下载；交代文案要看下载结果，留给 resolve 之后的完整解析
      if (imageKey) probe.images += 1;
      probe.files += 1;
      return { text: "", images: [], attachments: [] };
    }
    const images: ParsedInboundContent["images"] = [];
    let totalBytes = 0;
    const pushImage = async (abs: string): Promise<void> => {
      if (images.length >= MAX_IMAGES) return;
      const img = await fileToBase64Image(abs);
      if (!img) return;
      const approx = Math.floor((img.data.length * 3) / 4);
      if (totalBytes + approx > MAX_TOTAL_IMAGE_BYTES) return;
      totalBytes += approx;
      images.push(img);
    };
    if (imageKey) {
      // 封面转完 base64 即删：bridge 目录无 TTL（image/post 分支同笔一起收）
      let coverAbs: string | null = null;
      try {
        coverAbs = await deps.downloadMessageResource(
          msg.message_id,
          imageKey,
          "image",
        );
        await pushImage(coverAbs);
      } catch (err) {
        console.warn(
          "[feishu-bridge/router] 视频封面下载失败:",
          err instanceof Error ? err.message : err,
        );
      } finally {
        if (coverAbs) await fs.unlink(coverAbs).catch(() => undefined);
      }
    }
    let abs: string;
    try {
      abs = await deps.downloadMessageResource(
        msg.message_id,
        fileKey,
        "file",
      );
    } catch (err) {
      // 回执脱敏：原始异常可能带英文/路径，只给用户一句话，细节打 warn
      console.warn(
        "[feishu-bridge/router] 视频下载失败:",
        msg.message_id,
        fileKey,
        err instanceof Error ? err.message : String(err),
      );
      return {
        text: "",
        images,
        attachments: [],
        unsupported: "视频下载失败，请稍后重试",
      };
    }
    let size = 0;
    try {
      size = (await fs.stat(abs)).size;
    } catch (err) {
      await fs.unlink(abs).catch(() => undefined);
      return {
        text: "",
        images,
        attachments: [],
        unsupported: `视频校验失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (size <= MAX_FILE_BYTES) {
      const r = await finalizeAttachment(abs, "video.mp4", msg.message_id);
      if ("error" in r) {
        return { text: "", images, attachments: [], unsupported: r.error };
      }
      return {
        text: "收到一段视频（封面见附图，完整视频见附件）",
        images,
        attachments: [r.path],
      };
    }
    // 大视频：抽帧预览（best-effort）+ 删原文件 + 文字交代
    let preview: VideoPreview | null = null;
    try {
      preview = await deps.extractVideoPreview(abs);
    } catch (err) {
      console.warn(
        "[feishu-bridge/router] 视频抽帧失败:",
        err instanceof Error ? err.message : err,
      );
    }
    await fs.unlink(abs).catch(() => undefined);
    if (preview) {
      for (const fp of preview.framePaths) {
        try {
          await pushImage(fp);
        } finally {
          await fs.unlink(fp).catch(() => undefined);
        }
      }
    }
    const dur = formatVideoDuration(preview?.durationSec ?? null);
    // 附图可能一张没推进去（预算闸全拦）：没图就不写“画面见附图”，别撒谎
    const hasView = images.length > 0;
    return {
      text: hasView
        ? `收到一段${dur}视频（文件约${formatByteSize(size)}，过大未下载完整文件，画面见附图）`
        : `收到一段${dur}视频（文件约${formatByteSize(size)}，过大未下载完整文件）`,
      images,
      attachments: [],
    };
  }

  if (type === "interactive") {
    // 卡片消息（常是别的 bot 回的结论）：抽正文走 text 同链路；抽不出才 unsupported。
    // 卡片引用形态（仅 card_id、无正文）抽不出 → 回退 unsupported，由调用方决定是否单条取详情。
    const text = extractInteractiveText(msg.content);
    if (text) return { text, images: [], attachments: [] };
    return {
      text: "",
      images: [],
      attachments: [],
      unsupported: "暂不支持该消息类型",
    };
  }

  return {
    text: "",
    images: [],
    attachments: [],
    unsupported: "暂不支持该消息类型",
  };
};

/**
 * 按 message_type 解析为 chat-inject 可用载荷。
 * 不支持的类型设 unsupported 文案（调用方 bot 回执）。
 *
 * `deferDownloads`：只做预解析——不下载任何图 / 文件 / 视频，正文里的资源占位照常剥掉；
 * 消息里确有资源时在返回值带 `deferred`（`hasImages` + `resolve()`），`resolve()` 才真正下载并给出完整结果
 *（成功后缓存，失败不缓存、可重试）。给群里非属主的消息用：先过鉴权 / 限流 / 忙线闸门、通过了再下载，
 * 免得陌生人的附件在门外就占满全局单飞的 lark 队列、拖住属主消息（见 group-route）。
 * 没有资源（纯文本 / 卡片 / unsupported）时预解析结果就是最终结果、不带 `deferred`。
 */
export const parseInboundContent = async (
  msg: FeishuInboundMessage,
  opts?: { deferDownloads?: boolean },
): Promise<ParsedInboundContent> => {
  if (!opts?.deferDownloads) return parseInboundContentImpl(msg);
  const probe: ResourceProbe = { dry: true, images: 0, files: 0 };
  const dry = await parseInboundContentImpl(msg, probe);
  if (dry.unsupported || probe.images + probe.files === 0) return dry;
  let full: Promise<ParsedInboundContent> | null = null;
  return {
    ...dry,
    deferred: {
      hasImages: probe.images > 0,
      resolve: () => {
        if (!full) {
          full = parseInboundContentImpl(msg).catch((err: unknown) => {
            full = null; // 失败不缓存：排队回放等场景要能重试
            throw err;
          });
        }
        return full;
      },
    },
  };
};

// ----------------- 活跃 chat / 新建 / 当前对话指针 -----------------

/**
 * 可路由的 chat（指针校验用）：mode=chat、非终态。
 * 与 isActiveChatTask 的差别：不看活跃时间窗。
 */
export const isRoutableChatTask = (t: TaskSummary): boolean => {
  if (t.mode !== "chat") return false;
  if (t.repoStatus === "merged" || t.repoStatus === "abandoned") return false;
  return true;
};

/**
 * 「进行中」活跃 chat：可路由 + 活跃窗内有更新。
 * 仅影响 /list 与指针失效后的活跃数兜底；指针直发不走本判定。
 */
export const isActiveChatTask = (
  t: TaskSummary,
  now = Date.now(),
): boolean => {
  if (!isRoutableChatTask(t)) return false;
  const updated = typeof t.updatedAt === "number" ? t.updatedAt : 0;
  return now - updated <= ACTIVE_CHAT_WINDOW_MS;
};

export const listActiveChatTasks = async (): Promise<TaskSummary[]> => {
  const all = await deps.listTasks();
  // 飞书侧「已结束」的对话（清理卡按过「结束」）不算进行中——app 数据不动、只影响桥接口径
  const ended = new Set(await getEndedChatTaskIds());
  const now = Date.now();
  return all
    .filter((t) => isActiveChatTask(t, now) && !ended.has(t.id))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
};

/** 刷当前对话指针；失败静默（不影响注入主路径） */
const touchCurrentChatPointer = async (taskId: string): Promise<void> => {
  if (!taskId) return;
  try {
    await setCurrentChatTaskId(taskId);
  } catch (err) {
    console.warn(
      "[feishu-bridge/router] 刷当前对话指针失败:",
      err instanceof Error ? err.message : err,
    );
  }
};

/**
 * 回复锚定命中 = 用户明确指回该对话——**复活语义**：
 * 若对话曾被清理卡「结束」（进了 endedChatTaskIds），回复它的旧卡片即重新激活
 * （移出 ended 集合）+ 当前指针切过去。router 直发与命令锚定共用。
 */
export const reviveChatByAnchor = async (taskId: string): Promise<void> => {
  if (!taskId) return;
  try {
    await removeEndedChatTaskId(taskId);
  } catch (err) {
    console.warn(
      "[feishu-bridge/router] 复活 ended 对话失败:",
      err instanceof Error ? err.message : err,
    );
  }
  await touchCurrentChatPointer(taskId);
};

/**
 * 读指针并校验 task 仍可路由；失效则清指针后返 undefined。
 * 不看活跃时间窗——上午指针对下午直发仍有效。
 */
const resolveCurrentChatPointer = async (): Promise<string | undefined> => {
  let pointerId = "";
  try {
    pointerId = await getCurrentChatTaskId();
  } catch (err) {
    console.warn(
      "[feishu-bridge/router] 读当前对话指针失败:",
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
  if (!pointerId) return undefined;
  const all = await deps.listTasks();
  const hit = all.find((t) => t.id === pointerId);
  if (hit && isRoutableChatTask(hit)) return hit.id;
  // 删了 / 终态 → 清指针再走活跃数兜底
  try {
    await setCurrentChatTaskId("");
  } catch (err) {
    console.warn(
      "[feishu-bridge/router] 清失效指针失败:",
      err instanceof Error ? err.message : err,
    );
  }
  return undefined;
};

const titleFromMessage = (text: string): string => {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return `飞书对话 ${new Date().toLocaleString("zh-CN")}`;
  return t.length > TITLE_PREFIX_LEN
    ? `${t.slice(0, TITLE_PREFIX_LEN)}…`
    : t;
};

/**
 * 从 settings 读 bootArgs + 默认 workdir + MCP 黑名单。
 *
 * @param task 给**已存在的窗口**取 bootArgs 时必传：模型 / 提供方跟窗口走（bootArgsForTask 口径，
 *   与 app 输入条、定时任务一致），否则飞书注入带的是设置页默认模型——与窗口所选不一致时，
 *   chat-inject 的 modelEquals 判「换了模型」→ 懒重启（取消在跑回合 + 上下文压成 12 轮摘要）。
 *   不传 = 新建对话 / 命令等「还没有窗口」的场景，仍取设置页默认提供方 + 默认模型。
 */
export const loadBridgeBootContext = async (
  task?: Parameters<typeof bootArgsForTask>[0],
): Promise<{
  apiKey: string;
  model: ModelSelection;
  provider: string;
  repoPaths: string[];
  /** 设置页「默认禁用 MCP」黑名单（与 app 内新建对话同源） */
  disabledMcpServers: string[];
} | null> => {
  const result = await deps.readSettingsFile();
  if (result.status !== "ok") return null;
  const raw = result.settings as Record<string, unknown>;
  const migrated = migrateProviderSettings(raw);
  const settings = {
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey.trim() : "",
    defaultModel: (raw.defaultModel as ModelSelection | undefined) ?? { id: "" },
    provider: migrated.provider,
    customProviders: migrated.customProviders,
  };
  // 窗口绑定的自定义提供方已被删除：拒绝（返回 null），不让 bootArgsForTask 落回 Cursor 凭据——
  // 飞书进来的消息 / 上下文会悄悄走云端（第四轮 Q2-02；与主路径 resolveProviderIdForCreate 同口径）。
  // 调用方想给出明确原因用 `bridgeTaskProviderDanglingReason`
  if (task && isTaskProviderDangling(task, settings)) return null;
  // 有窗口：provider / model 都交给 bootArgsForTask（task.model 缺失 / 空 id 时它自己回落设置页默认）；
  // 凭据门下面仍按这里定的 provider 判（窗口绑的那家，不是设置页默认家）
  const taskBoot = task
    ? bootArgsForTask(task, settings as FeAiFlowSettings)
    : null;
  const provider = taskBoot?.providerId ?? migrated.provider;
  const model = taskBoot?.model ?? defaultModelForProvider(settings, provider);
  const apiKey = isCursorProvider(provider)
    ? settings.apiKey
    : (findCustomProvider(settings, provider)?.apiKey ?? "");
  const hasCreds = isCursorProvider(provider)
    ? !!apiKey
    : !!findCustomProvider(settings, provider)?.baseUrl.trim();
  if (!hasCreds) return null;
  if (!isValidModel(model)) return null;
  const repos = Array.isArray(raw.repos) ? raw.repos : [];
  const repoPaths: string[] = [];
  for (const r of repos) {
    if (r && typeof r === "object" && typeof (r as { path?: string }).path === "string") {
      const p = (r as { path: string }).path.trim();
      if (p) repoPaths.push(p);
    }
  }
  const disabledMcpServers = Array.isArray(raw.disabledMcpServers)
    ? raw.disabledMcpServers.filter((x): x is string => typeof x === "string")
    : [];
  return { apiKey, model, provider, repoPaths, disabledMcpServers };
};

/**
 * 窗口绑定的提供方是否已被删（loadBridgeBootContext 因此返回 null 时，用它把「缺 Key」的泛化提示换成真正原因）。
 * 配置读不出来 / 没传窗口 → null（不误判）。
 */
export const bridgeTaskProviderDanglingReason = async (
  task?: Parameters<typeof bootArgsForTask>[0],
): Promise<string | null> => {
  if (!task) return null;
  const result = await deps.readSettingsFile().catch(() => null);
  if (!result || result.status !== "ok") return null;
  const migrated = migrateProviderSettings(result.settings as Record<string, unknown>);
  return isTaskProviderDangling(task, { customProviders: migrated.customProviders })
    ? DANGLING_TASK_PROVIDER_MESSAGE
    : null;
};

/**
 * 桥接侧建新 chat（/new 与 0 活跃自动建共用）。
 *
 * 参数对齐 app 内一键新建对话（use-new-chat.ts）：不绑工作目录（repoPaths 空）、
 * MCP 黑名单跟设置页「默认禁用 MCP」（不传 = 全开、错）。
 * 差异仅标题：app 是空标题占位，飞书场景取消息前缀更好认（多对话列表里可辨）。
 */
export const createChatTaskForBridge = async (
  title: string,
): Promise<{ taskId: string; title: string } | { error: string }> => {
  const boot = await loadBridgeBootContext();
  if (!boot) {
    return { error: "缺少 API Key 或默认模型，请先在设置页配置" };
  }
  const task = await deps.createTask({
    title,
    mode: "chat",
    repoPaths: [],
    model: boot.model,
    provider: boot.provider,
    disabledMcpServers:
      boot.disabledMcpServers.length > 0 ? boot.disabledMcpServers : undefined,
  });
  deps.prewarmTaskWorkspace(task.id);
  // /new 与 0 活跃自动建：新对话立刻成为当前指针
  await touchCurrentChatPointer(task.id);
  return { taskId: task.id, title: task.title };
};

// ----------------- 命令 / skill -----------------

const tryCommandOrSkill = async (
  msg: FeishuInboundMessage,
  text: string,
): Promise<
  | { kind: "handled" }
  | { kind: "handled_failed" }
  | { kind: "skill"; text: string; skills: Array<{ name: string; absPath: string }> }
  | { kind: "text"; text: string }
> => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { kind: "text", text };

  // `/cmd args…`
  const m = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!m) return { kind: "text", text };
  // 命令表按小写匹配；skill 名保留原大小写（skill 目录名区分大小写）
  const rawCommand = m[1]!;
  const command = rawCommand.toLowerCase();
  const args = (m[2] ?? "").trim();

  const handler = commandHandlers.get(command);
  if (handler) {
    const result = await handler({ msg, command, args, text: trimmed });
    if (result === "handled") return { kind: "handled" };
    if (result === "handled_failed") return { kind: "handled_failed" };
    // passthrough → 继续 skill / 普通文本
  }

  // 未注册命令：尝试本机 skill 最长前缀命中（原样大小写）
  const skills = await deps.listSkillsWithSource();
  const known = new Set(skills.map((s) => s.name));
  const hit = matchLongestSkillName(rawCommand, known);
  if (hit) {
    const entry = skills.find((s) => s.name === hit);
    if (entry) {
      // 正文 = 去掉 `/skillName` 后的剩余（允许紧贴中文）
      const rest = trimmed.slice(1 + hit.length).trim();
      return {
        kind: "skill",
        text: rest,
        skills: [{ name: entry.name, absPath: entry.absPath }],
      };
    }
  }

  return { kind: "text", text };
};

// ----------------- 注入 -----------------

const parseHttpInject = async (
  resp: Response,
): Promise<
  | { ok: true; queued: boolean }
  | { ok: false; error: string; retryable: boolean }
> => {
  let data: { error?: string; queued?: boolean } = {};
  try {
    data = (await resp.json()) as { error?: string; queued?: boolean };
  } catch {
    // ignore
  }
  if (resp.status === 200 || resp.status === 202) {
    return { ok: true, queued: data.queued === true || resp.status === 202 };
  }
  // 5xx = 基础设施抖动可重试；4xx（含队满 409）= 内容/业务终态，用户已见提示
  return {
    ok: false,
    error:
      typeof data.error === "string" && data.error
        ? data.error
        : `注入失败（HTTP ${resp.status}）`,
    retryable: resp.status >= 500,
  };
};

const notifyOwnerError = async (text: string): Promise<void> => {
  try {
    const info = await deps.getBotAppInfo();
    await deps.sendTextMessage(info.ownerOpenId, text);
  } catch (err) {
    console.warn(
      "[feishu-bridge/router] 错误回执发送失败:",
      err instanceof Error ? err.message : err,
    );
  }
};

/**
 * 发一条「与具体 task 绑定」的文本提示（如「已开新对话：xxx」），
 * 成功后把 message_id 记进 card-map——用户回复这条提示即可锚定到该 task。
 * cardId 空串 = 纯文本提示（无卡片实体）；card-map 读盘校验只要求 string、兼容既有数据。
 * 「多对话列表」这类不绑定 task 的提示不要走本函数（继续 notifyOwnerError）。
 */
export const sendTaskBoundText = async (
  taskId: string,
  text: string,
): Promise<void> => {
  const info = await deps.getBotAppInfo();
  const sent = await deps.sendTextMessage(info.ownerOpenId, text);
  try {
    await deps.rememberCardMessage({
      messageId: sent.message_id,
      cardId: "",
      taskId,
      createdAt: Date.now(),
    });
  } catch (err) {
    // 记录失败只影响「回复这条提示」的锚定、不影响消息本身——降级 warn
    console.warn(
      "[feishu-bridge/router] 提示消息记 card-map 失败:",
      err instanceof Error ? err.message : err,
    );
  }
};

const nonEmptyStr = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

/** 「回复」上下文：`ids` 给 card-map 反查路由用、`parentId` 是用户点「回复」的那条（给引用用） */
export type ReplyContext = {
  ids: string[];
  /** 直接回复的父消息 id（事件取 reply_to → parent_id → root_id；REST 反查取 parent_id → root_id） */
  parentId?: string;
};

/**
 * 解析「回复」上下文：优先事件自带的 root_id / parent_id / reply_to；三者都缺时按
 * message_id 反查一次 REST 消息详情补齐。
 *
 * 实证（2026-07-19、真实消息 om_x100b6afcc99c68a0b2a3e1bca85c0ce）：当时的 lark-cli
 * `event consume im.message.receive_v1` 的 NDJSON schema **不含** root_id / parent_id，
 * 事件路径拿不到被回复消息 id、这是「回复卡片仍提示多对话」的根因；
 * REST `GET /open-apis/im/v1/messages/:message_id` 两个字段都有：
 * 直接回复时 root_id === parent_id === 被回复消息 id、可对上 card-map。
 *
 * 2026-11-05 复核：本机 lark-cli 1.0.79 的 `event schema im.message.receive_v1` 已带
 * `reply_to`（直接回复的父消息 id）/ `root_id` / `thread_id`——新版本回复事件自带锚点、不会走反查；
 * 反查只剩两种情况：老版本 lark-cli、或这条根本不是回复（后者每条普通消息仍会多一次 REST，
 * 事件规整后分不出「字段缺」与「字段空」，没敢直接去掉）。
 * 反查失败静默返回空（走活跃 chat 兜底），不阻断注入。
 */
export const resolveReplyContext = async (
  msg: FeishuInboundMessage,
): Promise<ReplyContext> => {
  // 直接回复时 root_id === parent_id === reply_to——去重避免同一 id 查几次盘
  const own = [
    ...new Set(
      [msg.root_id, msg.parent_id, msg.reply_to].filter(nonEmptyStr),
    ),
  ];
  if (own.length > 0) {
    return {
      ids: own,
      parentId: [msg.reply_to, msg.parent_id, msg.root_id].find(nonEmptyStr),
    };
  }
  try {
    const rec = await deps.larkApi(
      "GET",
      `/open-apis/im/v1/messages/${msg.message_id}`,
    );
    const data = (rec.data as Record<string, unknown> | undefined) ?? rec;
    const items = Array.isArray(data.items) ? data.items : [];
    const first = items[0];
    if (!first || typeof first !== "object") return { ids: [] };
    const it = first as Record<string, unknown>;
    return {
      ids: [...new Set([it.root_id, it.parent_id].filter(nonEmptyStr))],
      parentId: [it.parent_id, it.root_id].find(nonEmptyStr),
    };
  } catch (err) {
    console.warn(
      "[feishu-bridge/router] 反查消息 parent/root 失败（忽略、走活跃兜底）:",
      err instanceof Error ? err.message : err,
    );
    return { ids: [] };
  }
};

/** 只要路由用的锚定 id（commands 的 /stop 等沿用） */
export const resolveReplyAnchorIds = async (
  msg: FeishuInboundMessage,
): Promise<string[]> => (await resolveReplyContext(msg)).ids;

/**
 * 路由一条入向消息。幂等由调用方（inbound）按 message_id 去重。
 */
export const routeInboundMessage = async (
  msg: FeishuInboundMessage,
): Promise<InjectResultPayload> => {
  // 1) 过滤：群消息走需求群回流分支（第二批）；其余非 p2p 忽略
  if (msg.chat_type !== "p2p") {
    if (isGroupChatMessage(msg)) {
      const payload = await routeGroupInboundMessage(msg, {
        parseContent: parseInboundContent,
        // 带上目标任务：提供方 / 模型跟窗口走，别拿设置页默认模型去 resume（F2-01）
        loadBootContext: async (task) => {
          const boot = await loadBridgeBootContext(task);
          return boot ? { apiKey: boot.apiKey, model: boot.model } : null;
        },
      });
      await emitInjectResult(payload);
      return payload;
    }
    return { kind: "skipped", messageId: msg.message_id, error: SKIP_NOT_P2P };
  }
  let ownerOpenId: string;
  let botAppId = "";
  try {
    const appInfo = await deps.getBotAppInfo();
    ownerOpenId = appInfo.ownerOpenId;
    botAppId = appInfo.appId ?? "";
  } catch (err) {
    const error = `无法获取 bot 身份：${err instanceof Error ? err.message : String(err)}`;
    const payload: InjectResultPayload = {
      kind: "failed",
      messageId: msg.message_id,
      error,
      retryable: true,
    };
    await emitInjectResult(payload);
    return payload;
  }
  if (msg.sender_id !== ownerOpenId) {
    return { kind: "skipped", messageId: msg.message_id, error: SKIP_NOT_OWNER };
  }

  // 2) content
  let parsed: ParsedInboundContent;
  try {
    parsed = await parseInboundContent(msg);
  } catch (err) {
    const error = `解析消息失败：${err instanceof Error ? err.message : String(err)}`;
    await notifyOwnerError(error);
    const payload: InjectResultPayload = {
      kind: "failed",
      messageId: msg.message_id,
      error,
      retryable: true,
    };
    await emitInjectResult(payload);
    return payload;
  }
  if (parsed.unsupported) {
    await notifyOwnerError(parsed.unsupported);
    await emitInjectResult({
      kind: "failed",
      messageId: msg.message_id,
      error: parsed.unsupported,
    });
    return { kind: "failed", messageId: msg.message_id, error: parsed.unsupported };
  }
  // 图超限 → 回执失败；空消息在下方（命令 / skill 解析后）统一静默跳过
  if (parsed.images.length > MAX_IMAGES) {
    const error = `单次最多 ${MAX_IMAGES} 张图`;
    await notifyOwnerError(error);
    await emitInjectResult({ kind: "failed", messageId: msg.message_id, error });
    return { kind: "failed", messageId: msg.message_id, error };
  }

  // 3) 命令 / skill
  let text = parsed.text;
  let skills: Array<{ name: string; absPath: string }> | undefined;
  if (text.trim().startsWith("/")) {
    const cmdResult = await tryCommandOrSkill(msg, text);
    if (cmdResult.kind === "handled") {
      // 对话遥控器「搜对话」待关键词时来了条命令：按命令办、搜索 intent 作废
      await takeAwaitingChatSearch().catch(() => false);
      // T8 用户拍板：Get 语义 = 消息真进了 AI——命令词只有 bot 文本回执、
      // 不点表情（skipped 在 reactions 侧本来就不点）
      await emitInjectResult({
        kind: "skipped",
        messageId: msg.message_id,
      });
      return { kind: "skipped", messageId: msg.message_id };
    }
    // R1-9：命令失败 → failed（不 retryable，用户已收到失败文本）
    if (cmdResult.kind === "handled_failed") {
      await takeAwaitingChatSearch().catch(() => false);
      const payload: InjectResultPayload = {
        kind: "failed",
        messageId: msg.message_id,
        error: "命令执行失败",
      };
      await emitInjectResult(payload);
      return payload;
    }
    if (cmdResult.kind === "skill") {
      text = cmdResult.text;
      skills = cmdResult.skills;
      // skill-only 无正文也允许（指引进 agent）
      if (
        text.length === 0 &&
        parsed.images.length === 0 &&
        parsed.attachments.length === 0
      ) {
        text = ""; // chat-inject 要求 text/images/attachments 至少一项——skill 指引靠 buildSkillDirective，需垫一个占位
        // 用 skill 名作展示文本
        text = `/${skills[0]!.name}`;
      }
    } else {
      text = cmdResult.text;
    }
  }

  // 对话遥控器「搜对话」：待关键词时纯文本即搜（动态 import，别拖重依赖进热路径）。
  // flag 取值即清——搜完/空消息都不留尾巴，后面的正常聊天不受影响。
  // fast-path：99.9% 为 false，先无锁 peek，不过才连 import 都省了。
  if (!text.trim().startsWith("/")) {
    let searching = false;
    try {
      searching = await peekAwaitingChatSearch();
    } catch {
      searching = false;
    }
    if (searching) {
      const { consumeChatSearchText } = await import("./chats-panel");
      // 带图/附件不搜：附件走正常注入，搜索 intent 留给下一条纯文本
      if (
        await consumeChatSearchText(text, {
          hasAttachments: parsed.images.length + parsed.attachments.length > 0,
        })
      ) {
        await emitInjectResult({
          kind: "skipped",
          messageId: msg.message_id,
        });
        return { kind: "skipped", messageId: msg.message_id };
      }
    }
  }

  if (
    text.length === 0 &&
    parsed.images.length === 0 &&
    parsed.attachments.length === 0
  ) {
    await emitInjectResult({
      kind: "skipped",
      messageId: msg.message_id,
      error: "空消息",
    });
    return { kind: "skipped", messageId: msg.message_id, error: "空消息" };
  }

  // 4) 定位 taskId：回复锚定 > 当前对话指针（不看活跃窗）> 活跃数兜底
  let taskId: string | undefined;
  const replyCtx = await resolveReplyContext(msg);
  for (const anchorId of replyCtx.ids) {
    const hit = await deps.findTaskByMessageId(anchorId);
    // 清理卡等「非 task 绑定」提示的 card-map 条目 taskId 为空串——不当锚定
    if (hit?.taskId) {
      taskId = hit.taskId;
      // 锚定命中：被「结束」过的对话回复旧卡片即复活 + 指针切过去
      await reviveChatByAnchor(taskId);
      break;
    }
  }

  if (!taskId) {
    taskId = await resolveCurrentChatPointer();
  }

  if (!taskId) {
    const active = await listActiveChatTasks();
    if (active.length === 1) {
      taskId = active[0]!.id;
    } else if (active.length === 0) {
      const created = await createChatTaskForBridge(titleFromMessage(text));
      if ("error" in created) {
        await notifyOwnerError(created.error);
        await emitInjectResult({
          kind: "failed",
          messageId: msg.message_id,
          error: created.error,
        });
        return { kind: "failed", messageId: msg.message_id, error: created.error };
      }
      taskId = created.taskId;
      try {
        // task 绑定类提示：记 card-map、用户回复这条「已开新对话」也能锚定
        await sendTaskBoundText(created.taskId, `已开新对话：${created.title}`);
      } catch {
        // 提示失败不阻断注入
      }
    } else {
      // 不带编号：编号会误导用户「回个数字」（序号选择已拍板不做）
      const lines = active.map((t) => `· ${t.title || t.id}`);
      const tip = `有 ${active.length} 个进行中的对话。请用「回复」功能回复对应对话的卡片，来指定发给谁：\n${lines.join("\n")}`;
      await notifyOwnerError(tip);
      await emitInjectResult({
        kind: "skipped",
        messageId: msg.message_id,
        error: "多活跃 chat、需回复锚定",
      });
      return {
        kind: "skipped",
        messageId: msg.message_id,
        error: "多活跃 chat、需回复锚定",
      };
    }
  }

  // 直发进某对话（含回复锚定 / 指针 / 活跃兜底 / 新建）→ 刷指针（幂等）
  await touchCurrentChatPointer(taskId);

  // 5) 注入
  // bootArgs 的模型要跟目标窗口走（bootArgsForTask 口径）：读不到 meta（任务刚删 / IO 异常）就退回
  // 设置页默认——此时注入本身也会因任务不存在失败，不在这里额外拦
  const bootTask = await deps.getTaskMeta(taskId).catch(() => null);
  const boot = await loadBridgeBootContext(bootTask ?? undefined);
  const bootArgs = boot
    ? { apiKey: boot.apiKey, model: boot.model }
    : undefined;

  const pending = deps.getPendingAsk(taskId);
  if (pending) {
    // R1-5：pendingAsk 分支穿透附图（落盘在 ask-inject 内）
    const askResult = await deps.injectPendingAskText(
      taskId,
      text || "(附图/附件)",
      bootArgs,
      parsed.images.length > 0 ? parsed.images : undefined,
    );
    if (askResult.ok) {
      const payload: InjectResultPayload = {
        kind: "sent",
        messageId: msg.message_id,
        taskId,
      };
      await emitInjectResult(payload);
      return payload;
    }
    // no_pending 竞态 → 落 chat；其它失败回执
    if (askResult.reason !== "no_pending") {
      await notifyOwnerError(askResult.error);
      const payload: InjectResultPayload = {
        kind: "failed",
        messageId: msg.message_id,
        taskId,
        error: askResult.error,
      };
      await emitInjectResult(payload);
      return payload;
    }
  }

  if (!bootArgs) {
    // 悬空提供方要说真话：不是「缺 Key」，而是窗口原来绑的那家被删了（回执给属主，不静默改走 Cursor）
    const error =
      (await bridgeTaskProviderDanglingReason(bootTask ?? undefined)) ??
      "缺少 API Key 或默认模型，请先在设置页配置";
    await notifyOwnerError(error);
    const payload: InjectResultPayload = {
      kind: "failed",
      messageId: msg.message_id,
      taskId,
      error,
    };
    await emitInjectResult(payload);
    return payload;
  }

  // 回复 / 引用了某条消息 → 被引用的那条也交给 agent（此前单聊里回复只用来路由、被引用内容 agent 看不到）。
  // 放在待答提问分支之后：
  // 那条路径的文本是「答案」、不该夹引用；也放在 bootArgs 校验之后：注定失败的消息不白占一次取回。
  // 取不到 / 已撤回 / 不是本会话 → 当没引用。
  const quoteAnchor = resolveQuoteAnchorId({
    message_id: msg.message_id,
    reply_to: replyCtx.parentId,
  });
  let quote: InboundQuote | null = null;
  if (quoteAnchor) {
    quote = await resolveInboundQuote({
      msg,
      anchorId: quoteAnchor,
      isOwner: true,
      selfIds: [botAppId],
      parseContent: parseInboundContent,
      lookupName: () => undefined,
      logPrefix: "[feishu-bridge/router]",
      userFallbackLabel: "用户",
      selfTextMaxChars: QUOTE_SELF_TEXT_MAX_CHARS,
      fetchDetail: deps.fetchInboundMessageDetail,
    }).catch(() => null);
  }
  // 引用里的图 / 附件只往余量里塞（chat-inject 对数量有上限）
  const injectImages = quote
    ? [
        ...parsed.images,
        ...quote.images.slice(0, Math.max(0, MAX_IMAGES - parsed.images.length)),
      ]
    : parsed.images;
  const injectAttachments = quote
    ? [
        ...parsed.attachments,
        ...quote.attachments.slice(
          0,
          Math.max(0, MAX_ATTACHMENTS - parsed.attachments.length),
        ),
      ]
    : parsed.attachments;

  let resp: Response;
  try {
    resp = await deps.handleChatReplyInject(
      taskId,
      {
        text,
        images: injectImages.length > 0 ? injectImages : undefined,
        attachments:
          injectAttachments.length > 0 ? injectAttachments : undefined,
        skills,
        bootArgs,
      },
      // review P0#1：feishuMessageId 进 extraMeta → 入队条目携带 → flush 钩子精确匹配
      {
        userReplyMetaExtra: {
          source: "feishu",
          feishuMessageId: msg.message_id,
          ...(quote ? { quotedMessageId: quote.messageId } : {}),
        },
        // 引用块只进 agent 的消息、不进事件气泡（与 skill 指引 / ATTACHED_* 同口径）
        ...(quote
          ? {
              agentContext: buildQuotedBlock({
                messageId: quote.messageId,
                senderLabel: quote.senderLabel,
                text: quote.text,
                truncated: quote.truncated,
              }),
            }
          : {}),
      },
    );
  } catch (err) {
    // 网络 / 未捕获异常 = 基础设施失败，可重试
    const error = `注入异常：${err instanceof Error ? err.message : String(err)}`;
    await notifyOwnerError(error);
    const payload: InjectResultPayload = {
      kind: "failed",
      messageId: msg.message_id,
      taskId,
      error,
      retryable: true,
    };
    await emitInjectResult(payload);
    return payload;
  }
  const parsedResp = await parseHttpInject(resp);
  if (!parsedResp.ok) {
    await notifyOwnerError(parsedResp.error);
    const payload: InjectResultPayload = {
      kind: "failed",
      messageId: msg.message_id,
      taskId,
      error: parsedResp.error,
      ...(parsedResp.retryable ? { retryable: true } : {}),
    };
    await emitInjectResult(payload);
    return payload;
  }
  const payload: InjectResultPayload = {
    kind: parsedResp.queued ? "queued" : "sent",
    messageId: msg.message_id,
    taskId,
    text: text || undefined,
  };
  await emitInjectResult(payload);
  return payload;
};

/** 主机名（冲突提示用） */
export const bridgeHostname = (): string => {
  try {
    return os.hostname();
  } catch {
    return "unknown";
  }
};
