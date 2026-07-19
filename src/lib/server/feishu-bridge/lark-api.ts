/**
 * lark-cli execFile 封装（全部 `--as bot --json`）
 *
 * - 二进制：优先 `<dataRoot>/tools/bin/lark-cli`，不存在则 PATH 回落 `lark-cli`
 * - 进程级串行队列（防并发打爆 CLI，写法对齐 meegle-queue）
 * - 单次超时 30s；错误归一化成 LarkApiError（抽出 permission_violations / console_url）
 */

import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { getLarkCliBin } from "@/lib/server/feishu-cli";

import { getBridgeDataDir } from "./bridge-config";
import type { BotAppInfo, SendMessageResult } from "./types";
import { LarkApiError } from "./types";

const execFileAsync = promisify(nodeExecFile);

/** 单次 CLI 超时 */
const LARK_TIMEOUT_MS = 30_000;
/** stdout 上限——卡片 JSON 可能较大 */
const LARK_MAX_BUFFER = 16 * 1024 * 1024;

// ----------------- 串行队列（挂 globalThis，dev 多 chunk 共享） -----------------

const LARK_CHAIN_KEY = "__flowshipLarkBridgeChainV1__";

type LarkChainState = { current: Promise<void> };

const getLarkChain = (): LarkChainState => {
  const g = globalThis as unknown as Record<string, LarkChainState | undefined>;
  if (!g[LARK_CHAIN_KEY]) g[LARK_CHAIN_KEY] = { current: Promise.resolve() };
  return g[LARK_CHAIN_KEY]!;
};

/** 把一次 lark 子进程调用排进进程级单飞队列 */
export const enqueueLark = <T>(run: () => Promise<T>): Promise<T> => {
  const state = getLarkChain();
  const result = state.current.then(run, run);
  state.current = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

// ----------------- exec 可注入（单测 mock） -----------------

type ExecFn = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number; cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

let execImpl: ExecFn = (file, args, opts) =>
  execFileAsync(file, args, opts) as Promise<{ stdout: string; stderr: string }>;

/** 单测替换 execFile；生产勿调 */
export const __setLarkExecForTest = (fn: ExecFn | null): void => {
  execImpl = fn ?? ((file, args, opts) =>
    execFileAsync(file, args, opts) as Promise<{ stdout: string; stderr: string }>);
};

// ----------------- 二进制解析 -----------------

let cachedBin: string | null = null;

/** 解析可用的 lark-cli 路径（带缓存；测试可清） */
export const resolveLarkCliBin = async (): Promise<string> => {
  if (cachedBin) return cachedBin;
  const preferred = getLarkCliBin();
  try {
    await fs.access(preferred);
    cachedBin = preferred;
    return preferred;
  } catch {
    // 开发机可能只装了 npm 全局 / PATH 上的 lark-cli（本机冒烟实测如此）
    cachedBin = "lark-cli";
    return cachedBin;
  }
};

/** 单测 / 换 dataRoot 后清缓存 */
export const __resetLarkBinCacheForTest = (): void => {
  cachedBin = null;
};

// ----------------- 错误归一化 -----------------

type JsonRecord = Record<string, unknown>;

const tryParseJson = (text: string): unknown => {
  const t = text.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    // CLI 有时 stdout 前带非 JSON 行——尝试抓第一个 {…} 块
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
};

const asRecord = (v: unknown): JsonRecord | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as JsonRecord) : null;

/**
 * 从 CLI stdout/stderr / 抛错对象抽出结构化 LarkApiError。
 * 飞书权限失败常见字段：permission_violations、console_url。
 */
export const normalizeLarkError = (
  err: unknown,
  fallbackMsg = "lark-cli 调用失败",
): LarkApiError => {
  if (err instanceof LarkApiError) return err;

  const e = err as {
    message?: string;
    stdout?: string;
    stderr?: string;
    code?: number | string;
    killed?: boolean;
  };

  const fromStdout = tryParseJson(e.stdout ?? "");
  const fromStderr = tryParseJson(e.stderr ?? "");
  const payload = asRecord(fromStdout) ?? asRecord(fromStderr);

  if (payload) {
    // 形如 { ok:false, error:{ message, permission_violations, console_url, code } }
    const errorObj = asRecord(payload.error) ?? payload;
    const msg =
      (typeof errorObj.message === "string" && errorObj.message) ||
      (typeof payload.msg === "string" && payload.msg) ||
      e.message ||
      fallbackMsg;
    const violations =
      errorObj.permission_violations ??
      payload.permission_violations ??
      errorObj.permissionViolations;
    const consoleUrl =
      (typeof errorObj.console_url === "string" && errorObj.console_url) ||
      (typeof payload.console_url === "string" && payload.console_url) ||
      undefined;
    const code =
      (typeof errorObj.code === "number" || typeof errorObj.code === "string"
        ? errorObj.code
        : undefined) ??
      (typeof payload.code === "number" || typeof payload.code === "string"
        ? payload.code
        : undefined) ??
      e.code;
    return new LarkApiError(msg, {
      code,
      permissionViolations: violations,
      consoleUrl,
      raw: payload,
    });
  }

  if (e.killed) {
    return new LarkApiError(`lark-cli 超时（${LARK_TIMEOUT_MS}ms）`, {
      code: e.code,
      raw: { stdout: e.stdout, stderr: e.stderr },
    });
  }

  return new LarkApiError(e.message || fallbackMsg, {
    code: e.code,
    raw: { stdout: e.stdout, stderr: e.stderr },
  });
};

/** 解析成功响应：要求 ok!==false，返回 data 或整包 */
const unwrapOk = (parsed: unknown): JsonRecord => {
  const rec = asRecord(parsed);
  if (!rec) {
    throw new LarkApiError("lark-cli 返回非 JSON 对象", { raw: parsed });
  }
  if (rec.ok === false) {
    throw normalizeLarkError({ stdout: JSON.stringify(rec) });
  }
  // 部分 API 直接 { code:0, data }；CLI 包一层 { ok, data }
  if (typeof rec.code === "number" && rec.code !== 0) {
    throw normalizeLarkError({ stdout: JSON.stringify(rec) });
  }
  return rec;
};

// ----------------- 底层执行 -----------------

export interface RunLarkOpts {
  /** 工作目录（资源下载要求相对 --output 时用） */
  cwd?: string;
  /**
   * 身份：默认 bot。
   * `auth status` 等命令不认 `--as` → 传 `none`。
   */
  as?: "bot" | "user" | "none";
}

/** 跑一条 lark-cli 命令，返回解析后的 JSON 根对象 */
export const runLark = async (
  args: string[],
  opts: RunLarkOpts = {},
): Promise<JsonRecord> =>
  enqueueLark(async () => {
    const bin = await resolveLarkCliBin();
    // 默认补 --as bot --json（调用方已带 / as:none 则跳过）
    const finalArgs = [...args];
    const as = opts.as ?? "bot";
    if (as !== "none" && !finalArgs.includes("--as")) {
      finalArgs.push("--as", as);
    }
    if (!finalArgs.includes("--json") && !finalArgs.includes("--format")) {
      finalArgs.push("--json");
    }
    try {
      const { stdout, stderr } = await execImpl(bin, finalArgs, {
        timeout: LARK_TIMEOUT_MS,
        maxBuffer: LARK_MAX_BUFFER,
        cwd: opts.cwd,
        env: process.env,
      });
      const parsed = tryParseJson(stdout) ?? tryParseJson(stderr);
      if (!parsed) {
        throw new LarkApiError("lark-cli 无 JSON 输出", {
          raw: { stdout, stderr },
        });
      }
      return unwrapOk(parsed);
    } catch (err) {
      if (err instanceof LarkApiError) throw err;
      throw normalizeLarkError(err);
    }
  });

/**
 * 裸调 OpenAPI：`lark-cli api <METHOD> <path> --as bot --data/--params --json`
 */
export const larkApi = async (
  method: string,
  apiPath: string,
  opts: { data?: unknown; params?: unknown; file?: string } = {},
): Promise<JsonRecord> => {
  const args = ["api", method.toUpperCase(), apiPath];
  if (opts.data !== undefined) {
    args.push("--data", JSON.stringify(opts.data));
  }
  if (opts.params !== undefined) {
    args.push("--params", JSON.stringify(opts.params));
  }
  if (opts.file) {
    args.push("--file", opts.file);
  }
  return runLark(args);
};

// ----------------- 业务封装 -----------------

/** 发纯文本私聊（今晚实测可用） */
export const sendTextMessage = async (
  openId: string,
  text: string,
): Promise<SendMessageResult> => {
  const rec = await runLark([
    "im",
    "+messages-send",
    "--user-id",
    openId,
    "--text",
    text,
  ]);
  return extractSendResult(rec);
};

/**
 * 发卡片消息：content = `{"type":"card","data":{"card_id":"..."}}`
 * （`--dry-run` 已核实拼装）
 */
export const sendCardMessage = async (
  openId: string,
  cardId: string,
): Promise<SendMessageResult> => {
  const content = JSON.stringify({
    type: "card",
    data: { card_id: cardId },
  });
  const rec = await runLark([
    "im",
    "+messages-send",
    "--user-id",
    openId,
    "--msg-type",
    "interactive",
    "--content",
    content,
  ]);
  return extractSendResult(rec);
};

const extractSendResult = (rec: JsonRecord): SendMessageResult => {
  const data = asRecord(rec.data) ?? rec;
  const chatId =
    (typeof data.chat_id === "string" && data.chat_id) ||
    (typeof data.chatId === "string" && data.chatId) ||
    "";
  const messageId =
    (typeof data.message_id === "string" && data.message_id) ||
    (typeof data.messageId === "string" && data.messageId) ||
    "";
  if (!messageId) {
    throw new LarkApiError("发消息成功但缺少 message_id", { raw: rec });
  }
  return { chat_id: chatId, message_id: messageId };
};

/**
 * 创建卡片实体：POST /open-apis/cardkit/v1/cards
 * data = { type: "card_json", data: JSON.stringify(cardJson) }
 */
export const createCardEntity = async (
  cardJson: unknown,
): Promise<{ card_id: string }> => {
  const rec = await larkApi("POST", "/open-apis/cardkit/v1/cards", {
    data: {
      type: "card_json",
      data: JSON.stringify(cardJson),
    },
  });
  const data = asRecord(rec.data) ?? rec;
  const cardId =
    (typeof data.card_id === "string" && data.card_id) ||
    (typeof data.cardId === "string" && data.cardId) ||
    "";
  if (!cardId) {
    throw new LarkApiError("建卡成功但缺少 card_id", { raw: rec });
  }
  return { card_id: cardId };
};

/** 流式更新某 element 的 content（全量文本 + 递增 sequence） */
export const updateCardElementContent = async (
  cardId: string,
  elementId: string,
  content: string,
  sequence: number,
): Promise<void> => {
  await larkApi(
    "PUT",
    `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/${encodeURIComponent(elementId)}/content`,
    { data: { content, sequence } },
  );
};

/**
 * 局部批量更新：actions 为对象数组，内部 JSON.stringify 成官方要求的 string 字段。
 * @see https://open.feishu.cn/document/cardkit-v1/card/batch_update
 */
export const batchUpdateCard = async (
  cardId: string,
  actions: unknown[],
  sequence: number,
): Promise<void> => {
  await larkApi(
    "POST",
    `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/batch_update`,
    {
      data: {
        sequence,
        actions: JSON.stringify(actions),
      },
    },
  );
};

/**
 * 全量更新卡片实体（改 header 用——batch_update 不支持改 header）。
 * PUT /open-apis/cardkit/v1/cards/:card_id
 */
export const updateCardEntity = async (
  cardId: string,
  cardJson: unknown,
  sequence: number,
): Promise<void> => {
  await larkApi("PUT", `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}`, {
    data: {
      card: {
        type: "card_json",
        data: JSON.stringify(cardJson),
      },
      sequence,
    },
  });
};

/** 更新卡片 settings（关 streaming_mode 等）；settings 需 stringify */
export const patchCardSettings = async (
  cardId: string,
  settingsJson: unknown,
  sequence: number,
): Promise<void> => {
  await larkApi(
    "PATCH",
    `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/settings`,
    {
      data: {
        settings: JSON.stringify(settingsJson),
        sequence,
      },
    },
  );
};

/**
 * 上传图片 → image_key。
 * CLI：`im images create --data '{"image_type":"message"}' --file image=<path>`
 */
export const uploadImage = async (filePath: string): Promise<string> => {
  const rec = await runLark([
    "im",
    "images",
    "create",
    "--data",
    JSON.stringify({ image_type: "message" }),
    "--file",
    `image=${filePath}`,
  ]);
  const data = asRecord(rec.data) ?? rec;
  const key =
    (typeof data.image_key === "string" && data.image_key) ||
    (typeof data.imageKey === "string" && data.imageKey) ||
    "";
  if (!key) {
    throw new LarkApiError("上传图片成功但缺少 image_key", { raw: rec });
  }
  return key;
};

/**
 * 下载消息内图片/文件到本地临时路径并返回绝对路径。
 * CLI 要求 `--output` 相对路径 → 在 bridge 目录下以 cwd 执行。
 */
export const downloadMessageResource = async (
  messageId: string,
  fileKey: string,
  type: "image" | "file",
): Promise<string> => {
  const dir = await getBridgeDataDir();
  const safeKey = fileKey.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const outName = `dl-${Date.now()}-${safeKey}`;
  await runLark(
    [
      "im",
      "+messages-resources-download",
      "--message-id",
      messageId,
      "--file-key",
      fileKey,
      "--type",
      type,
      "--output",
      outName,
    ],
    { cwd: dir },
  );
  const abs = path.join(dir, outName);
  // CLI 可能按 Content-Disposition 改扩展名——列目录找前缀匹配
  try {
    await fs.access(abs);
    return abs;
  } catch {
    const entries = await fs.readdir(dir);
    const hit = entries.find((n) => n === outName || n.startsWith(`${outName}.`));
    if (hit) return path.join(dir, hit);
    throw new LarkApiError(`下载完成但找不到输出文件：${outName}`, {
      raw: { dir, entries: entries.slice(0, 20) },
    });
  }
};

/** 给消息加表情回执 */
export const addReaction = async (
  messageId: string,
  emojiType: string,
): Promise<{ reaction_id: string }> => {
  const rec = await runLark([
    "im",
    "reactions",
    "create",
    "--message-id",
    messageId,
    "--data",
    JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
  ]);
  const data = asRecord(rec.data) ?? rec;
  const reactionId =
    (typeof data.reaction_id === "string" && data.reaction_id) ||
    (typeof data.reactionId === "string" && data.reactionId) ||
    "";
  return { reaction_id: reactionId };
};

/** 撤掉自己点的表情 */
export const removeReaction = async (
  messageId: string,
  reactionId: string,
): Promise<void> => {
  await runLark([
    "im",
    "reactions",
    "delete",
    "--message-id",
    messageId,
    "--reaction-id",
    reactionId,
  ]);
};

// ----------------- bot 应用信息（本人 open_id 来源） -----------------

let botInfoCache: BotAppInfo | null = null;

/**
 * app_id 来自 `lark-cli auth status --json`；
 * owner.owner_id 来自 `GET /open-apis/application/v6/applications/<app_id>`——即本人 open_id。
 */
export const getBotAppInfo = async (): Promise<BotAppInfo> => {
  if (botInfoCache) return botInfoCache;
  // auth status 不支持 --as（CLI 会报 unknown flag）
  const status = await runLark(["auth", "status"], { as: "none" });
  const appId =
    (typeof status.appId === "string" && status.appId) ||
    (typeof status.app_id === "string" && status.app_id) ||
    "";
  if (!appId) {
    throw new LarkApiError("auth status 未返回 appId", { raw: status });
  }
  const rec = await larkApi(
    "GET",
    `/open-apis/application/v6/applications/${encodeURIComponent(appId)}`,
    { params: { lang: "zh_cn" } },
  );
  const data = asRecord(rec.data) ?? rec;
  const app = asRecord(data.app) ?? data;
  const owner = asRecord(app.owner);
  const ownerOpenId =
    (owner && typeof owner.owner_id === "string" && owner.owner_id) ||
    (typeof app.creator_id === "string" && app.creator_id) ||
    "";
  if (!ownerOpenId) {
    throw new LarkApiError("应用信息缺少 owner.owner_id", { raw: rec });
  }
  botInfoCache = {
    appId,
    ownerOpenId,
    appName: typeof app.app_name === "string" ? app.app_name : undefined,
  };
  return botInfoCache;
};

/** 单测清 bot 信息缓存 */
export const __resetBotAppInfoCacheForTest = (): void => {
  botInfoCache = null;
};
