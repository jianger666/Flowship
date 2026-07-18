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
import { createTask, listTasks } from "@/lib/server/task-fs";
import { prewarmTaskWorkspace } from "@/lib/server/task-runner";
import { readSettingsFile } from "@/lib/server/settings-fs";
import { listSkillsWithSource } from "@/lib/server/app-skills";
import { matchLongestSkillName } from "@/lib/skill-token";
import { isValidModel } from "@/lib/server/route-helpers";
import type { TaskSummary } from "@/lib/types";

import { injectPendingAskText } from "./ask-inject";
import { findTaskByMessageId } from "./card-map";
import {
  downloadMessageResource,
  getBotAppInfo,
  sendTextMessage,
} from "./lark-api";
import type { FeishuInboundMessage } from "./types";

// ----------------- 常量 -----------------

/** 过滤跳过原因（inbound 据此判断「是否本人 p2p」、决定要不要推进补拉状态） */
export const SKIP_NOT_P2P = "非 p2p";
export const SKIP_NOT_OWNER = "非本人消息";

const ACTIVE_CHAT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 30 * 1024 * 1024;
/** review P1#2：入向文件体积上限（方案 4.5 降级「超大 → bot 回提示」） */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const TITLE_PREFIX_LEN = 20;

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
 * handled = 已处理完、router 不再注入；
 * passthrough = 未吃掉、继续当普通文本（或 skill）走。
 */
export type BridgeCommandHandler = (
  ctx: BridgeCommandContext,
) => Promise<"handled" | "passthrough">;

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
};

type InjectResultCb = (payload: InjectResultPayload) => void | Promise<void>;

/** 多订阅者：reactions + recall 各自 listen，互不覆盖 */
const injectResultListeners = new Set<InjectResultCb>();

/**
 * 追加注入结果监听；返回注销函数。
 * S3c reactions / recall 用这个，避免单回调互相踩。
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

/** 单测触发注入结果钩子（reactions / recall） */
export const __emitInjectResultForTest = (
  payload: InjectResultPayload,
): Promise<void> => emitInjectResult(payload);

// ----------------- 可注入依赖（单测 mock） -----------------

type RouterDeps = {
  getBotAppInfo: typeof getBotAppInfo;
  sendTextMessage: typeof sendTextMessage;
  downloadMessageResource: typeof downloadMessageResource;
  findTaskByMessageId: typeof findTaskByMessageId;
  listTasks: typeof listTasks;
  createTask: typeof createTask;
  getPendingAsk: typeof getPendingAsk;
  handleChatReplyInject: typeof handleChatReplyInject;
  injectPendingAskText: typeof injectPendingAskText;
  readSettingsFile: typeof readSettingsFile;
  listSkillsWithSource: typeof listSkillsWithSource;
  prewarmTaskWorkspace: typeof prewarmTaskWorkspace;
};

let deps: RouterDeps = {
  getBotAppInfo,
  sendTextMessage,
  downloadMessageResource,
  findTaskByMessageId,
  listTasks,
  createTask,
  getPendingAsk,
  handleChatReplyInject,
  injectPendingAskText,
  readSettingsFile,
  listSkillsWithSource,
  prewarmTaskWorkspace,
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
      listTasks,
      createTask,
      getPendingAsk,
      handleChatReplyInject,
      injectPendingAskText,
      readSettingsFile,
      listSkillsWithSource,
      prewarmTaskWorkspace,
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
};

const tryParseJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** text content：裸字符串 或 `{"text":"..."}` 都兼容 */
export const parseTextContent = (content: string): string => {
  const trimmed = content ?? "";
  if (!trimmed) return "";
  // 官方 schema 可能是 JSON；真实样本是裸字符串
  if (trimmed.startsWith("{")) {
    const obj = tryParseJson(trimmed);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const t = (obj as Record<string, unknown>).text;
      if (typeof t === "string") return t;
    }
  }
  return trimmed;
};

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
  const buf = await fs.readFile(absPath);
  if (buf.length > MAX_IMAGE_BYTES) return null;
  return {
    data: buf.toString("base64"),
    mimeType: mimeFromExt(absPath),
    filename: path.basename(absPath),
  };
};

/**
 * 按 message_type 解析为 chat-inject 可用载荷。
 * 不支持的类型设 unsupported 文案（调用方 bot 回执）。
 */
export const parseInboundContent = async (
  msg: FeishuInboundMessage,
): Promise<ParsedInboundContent> => {
  const type = msg.message_type;
  if (type === "text") {
    return { text: parseTextContent(msg.content), images: [], attachments: [] };
  }

  if (type === "image") {
    const obj = tryParseJson(msg.content) as Record<string, unknown> | null;
    const imageKey =
      (obj && typeof obj.image_key === "string" && obj.image_key) ||
      (obj && typeof obj.file_key === "string" && obj.file_key) ||
      "";
    if (!imageKey) {
      return {
        text: "",
        images: [],
        attachments: [],
        unsupported: "图片消息缺少 image_key",
      };
    }
    const abs = await deps.downloadMessageResource(
      msg.message_id,
      imageKey,
      "image",
    );
    const img = await fileToBase64Image(abs);
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
    const fileKey =
      (obj && typeof obj.file_key === "string" && obj.file_key) || "";
    const fileName =
      (obj && typeof obj.file_name === "string" && obj.file_name) || "file";
    if (!fileKey) {
      return {
        text: "",
        images: [],
        attachments: [],
        unsupported: "文件消息缺少 file_key",
      };
    }
    const abs = await deps.downloadMessageResource(
      msg.message_id,
      fileKey,
      "file",
    );
    // 下载产物可能无扩展名——尽量保留原文件名
    const dest = path.join(path.dirname(abs), fileName.replace(/[/\\]/g, "_"));
    let finalPath = abs;
    try {
      await fs.rename(abs, dest);
      finalPath = dest;
    } catch {
      finalPath = abs;
    }
    // review P1#2：超过 50MB → 删临时文件 + unsupported（route 侧 notifyOwnerError）
    try {
      const st = await fs.stat(finalPath);
      if (st.size > MAX_FILE_BYTES) {
        await fs.unlink(finalPath).catch(() => undefined);
        return {
          text: "",
          images: [],
          attachments: [],
          unsupported: "文件超过 50MB 上限",
        };
      }
    } catch (err) {
      await fs.unlink(finalPath).catch(() => undefined);
      return {
        text: "",
        images: [],
        attachments: [],
        unsupported: `文件校验失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { text: "", images: [], attachments: [finalPath] };
  }

  if (type === "post") {
    // post：官方 content 可能是 JSON 富文本；尽量抽 text + image_key
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
        if (key && images.length < MAX_IMAGES) {
          try {
            const abs = await deps.downloadMessageResource(
              msg.message_id,
              key,
              "image",
            );
            const img = await fileToBase64Image(abs);
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
      // zh_cn / en_us 等语言块
      for (const [k, v] of Object.entries(o)) {
        if (k === "text" || k === "tag" || k === "image_key" || k === "file_key")
          continue;
        if (typeof v === "object") await walk(v);
      }
    };
    const parsed = tryParseJson(msg.content);
    if (parsed) await walk(parsed);
    else textParts.push(msg.content);
    return {
      text: textParts.join("").trim(),
      images,
      attachments: [],
    };
  }

  return {
    text: "",
    images: [],
    attachments: [],
    unsupported: "暂不支持该消息类型",
  };
};

// ----------------- 活跃 chat / 新建 -----------------

/** 活跃 chat：mode=chat、非终态（merged/abandoned）、24h 内有更新 */
export const isActiveChatTask = (
  t: TaskSummary,
  now = Date.now(),
): boolean => {
  if (t.mode !== "chat") return false;
  if (t.repoStatus === "merged" || t.repoStatus === "abandoned") return false;
  const updated = typeof t.updatedAt === "number" ? t.updatedAt : 0;
  return now - updated <= ACTIVE_CHAT_WINDOW_MS;
};

export const listActiveChatTasks = async (): Promise<TaskSummary[]> => {
  const all = await deps.listTasks();
  const now = Date.now();
  return all
    .filter((t) => isActiveChatTask(t, now))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
};

const titleFromMessage = (text: string): string => {
  const t = text.trim().replace(/\s+/g, " ");
  if (!t) return `飞书对话 ${new Date().toLocaleString("zh-CN")}`;
  return t.length > TITLE_PREFIX_LEN
    ? `${t.slice(0, TITLE_PREFIX_LEN)}…`
    : t;
};

/** 从 settings 读 bootArgs + 默认 workdir */
export const loadBridgeBootContext = async (): Promise<{
  apiKey: string;
  model: ModelSelection;
  repoPaths: string[];
} | null> => {
  const result = await deps.readSettingsFile();
  if (result.status !== "ok") return null;
  const s = result.settings;
  const apiKey = typeof s.apiKey === "string" ? s.apiKey.trim() : "";
  const model = s.defaultModel as ModelSelection | undefined;
  if (!apiKey || !isValidModel(model)) return null;
  const repos = Array.isArray(s.repos) ? s.repos : [];
  const repoPaths: string[] = [];
  for (const r of repos) {
    if (r && typeof r === "object" && typeof (r as { path?: string }).path === "string") {
      const p = (r as { path: string }).path.trim();
      if (p) repoPaths.push(p);
    }
  }
  return { apiKey, model, repoPaths };
};

/** 桥接侧建新 chat（/new 与 0 活跃自动建共用）；不改逻辑，仅导出给 commands */
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
    repoPaths: boot.repoPaths.slice(0, 1),
    model: boot.model,
  });
  deps.prewarmTaskWorkspace(task.id);
  return { taskId: task.id, title: task.title };
};

// ----------------- 命令 / skill -----------------

const tryCommandOrSkill = async (
  msg: FeishuInboundMessage,
  text: string,
): Promise<
  | { kind: "handled" }
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
): Promise<{ ok: true; queued: boolean } | { ok: false; error: string }> => {
  let data: { error?: string; queued?: boolean } = {};
  try {
    data = (await resp.json()) as { error?: string; queued?: boolean };
  } catch {
    // ignore
  }
  if (resp.status === 200 || resp.status === 202) {
    return { ok: true, queued: data.queued === true || resp.status === 202 };
  }
  return {
    ok: false,
    error:
      typeof data.error === "string" && data.error
        ? data.error
        : `注入失败（HTTP ${resp.status}）`,
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
 * 路由一条入向消息。幂等由调用方（inbound）按 message_id 去重。
 */
export const routeInboundMessage = async (
  msg: FeishuInboundMessage,
): Promise<InjectResultPayload> => {
  // 1) 过滤
  if (msg.chat_type !== "p2p") {
    return { kind: "skipped", messageId: msg.message_id, error: SKIP_NOT_P2P };
  }
  let ownerOpenId: string;
  try {
    ownerOpenId = (await deps.getBotAppInfo()).ownerOpenId;
  } catch (err) {
    const error = `无法获取 bot 身份：${err instanceof Error ? err.message : String(err)}`;
    await emitInjectResult({ kind: "failed", messageId: msg.message_id, error });
    return { kind: "failed", messageId: msg.message_id, error };
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
    await emitInjectResult({ kind: "failed", messageId: msg.message_id, error });
    return { kind: "failed", messageId: msg.message_id, error };
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
      await emitInjectResult({
        kind: "sent",
        messageId: msg.message_id,
      });
      return { kind: "sent", messageId: msg.message_id };
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

  // 4) 定位 taskId
  let taskId: string | undefined;
  if (msg.root_id) {
    const hit = await deps.findTaskByMessageId(msg.root_id);
    if (hit) taskId = hit.taskId;
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
        const info = await deps.getBotAppInfo();
        await deps.sendTextMessage(
          info.ownerOpenId,
          `已开新对话：${created.title}`,
        );
      } catch {
        // 提示失败不阻断注入
      }
    } else {
      const lines = active.map(
        (t, i) => `${i + 1}. ${t.title || t.id}`,
      );
      const tip = `有 ${active.length} 个进行中的对话，请回复对应卡片来指定：\n${lines.join("\n")}`;
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

  // 5) 注入
  const boot = await loadBridgeBootContext();
  const bootArgs = boot
    ? { apiKey: boot.apiKey, model: boot.model }
    : undefined;

  const pending = deps.getPendingAsk(taskId);
  if (pending) {
    const askResult = await deps.injectPendingAskText(
      taskId,
      text || "(附图/附件)",
      bootArgs,
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
    const error = "缺少 API Key 或默认模型，请先在设置页配置";
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

  const resp = await deps.handleChatReplyInject(
    taskId,
    {
      text,
      images: parsed.images.length > 0 ? parsed.images : undefined,
      attachments:
        parsed.attachments.length > 0 ? parsed.attachments : undefined,
      skills,
      bootArgs,
    },
    // review P0#1：feishuMessageId 进 extraMeta → 入队条目携带 → flush 钩子精确匹配
    {
      userReplyMetaExtra: {
        source: "feishu",
        feishuMessageId: msg.message_id,
      },
    },
  );
  const parsedResp = await parseHttpInject(resp);
  if (!parsedResp.ok) {
    await notifyOwnerError(parsedResp.error);
    const payload: InjectResultPayload = {
      kind: "failed",
      messageId: msg.message_id,
      taskId,
      error: parsedResp.error,
    };
    await emitInjectResult(payload);
    return payload;
  }
  const payload: InjectResultPayload = {
    kind: parsedResp.queued ? "queued" : "sent",
    messageId: msg.message_id,
    taskId,
    // 撤回出队：queued 时 recall 用 text 匹配队列条目
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
