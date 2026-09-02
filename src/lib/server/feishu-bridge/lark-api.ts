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
import type { BotAppInfo, BotSelfInfo, SendMessageResult } from "./types";
import { isTransientLarkError, LarkApiError } from "./types";

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

const realExec: ExecFn = (file, args, opts) =>
  execFileAsync(file, args, opts) as Promise<{ stdout: string; stderr: string }>;

/**
 * 单测护栏：vitest 下默认禁止真起 lark-cli 子进程。
 *
 * 同族 flaky 第二次复现后立的闸（2026-07-27）：测试漏 mock larkApi 时会真 spawn CLI +
 * 打飞书网络——单跑侥幸能过、全量并发下必超时，表现成「随机 flaky」而不是「漏 mock」。
 * 闸设在**真正的提交点**（execFile 紧前）：漏 mock 立刻炸且报清楚是哪条命令，
 * 而不是退化成随机超时。真机冒烟（FEISHU_BRIDGE_LIVE=1）豁免。
 */
const denyRealExec: ExecFn = async (file, args) => {
  throw new Error(
    `[feishu-bridge/lark-api] 单测禁止真起 lark-cli 子进程：${file} ${args.slice(0, 3).join(" ")}。` +
      `请 mock lark-api 模块 / 注入 larkApi 依赖，或用 __setLarkExecForTest 提供假 exec。`,
  );
};

/** vitest 环境且非真机冒烟 → 默认走 deny 闸 */
const defaultExec = (): ExecFn =>
  process.env.VITEST && process.env.FEISHU_BRIDGE_LIVE !== "1"
    ? denyRealExec
    : realExec;

let execImpl: ExecFn = defaultExec();

/** 单测替换 execFile；传 null 恢复默认（vitest 下 = deny 闸）。生产勿调 */
export const __setLarkExecForTest = (fn: ExecFn | null): void => {
  execImpl = fn ?? defaultExec();
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
 * 命令标签（`api POST /open-apis/im/v1/chats` / `im +messages-send`）——
 * 取到第一个 `--flag` 为止。挂在 LarkApiError 上，错误里才看得出是哪次调用挂的。
 */
export const describeLarkCommand = (args: string[]): string => {
  const head: string[] = [];
  for (const a of args) {
    if (a.startsWith("--")) break;
    head.push(a);
  }
  return head.join(" ");
};

/**
 * 从 CLI stdout/stderr / 抛错对象抽出结构化 LarkApiError。
 * 飞书权限失败常见字段：permission_violations、console_url；
 * 参数校验失败（99992402）真正有信息量的是 field_violations + log_id。
 */
export const normalizeLarkError = (
  err: unknown,
  fallbackMsg = "lark-cli 调用失败",
  api?: string,
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
    const logId =
      (typeof errorObj.log_id === "string" && errorObj.log_id) ||
      (typeof payload.log_id === "string" && payload.log_id) ||
      undefined;
    const fieldViolations =
      errorObj.field_violations ??
      payload.field_violations ??
      errorObj.fieldViolations;
    return new LarkApiError(msg, {
      code,
      permissionViolations: violations,
      consoleUrl,
      logId,
      fieldViolations,
      api,
      raw: payload,
    });
  }

  if (e.killed) {
    return new LarkApiError(`lark-cli 超时（${LARK_TIMEOUT_MS}ms）`, {
      code: e.code,
      api,
      raw: { stdout: e.stdout, stderr: e.stderr },
    });
  }

  return new LarkApiError(e.message || fallbackMsg, {
    code: e.code,
    api,
    raw: { stdout: e.stdout, stderr: e.stderr },
  });
};

/**
 * 给错误补一句上下文，同时**原样保住** code / log_id / field_violations 等诊断字段。
 * 直接 `new Error(hint + err.message)` 会把这些字段全丢掉，排查时只剩一句白话。
 */
export const prefixLarkError = (err: unknown, hint: string): LarkApiError => {
  const e = err instanceof LarkApiError ? err : normalizeLarkError(err);
  return new LarkApiError(`${hint}：${e.message}`, {
    code: e.code,
    permissionViolations: e.permissionViolations,
    consoleUrl: e.consoleUrl,
    logId: e.logId,
    fieldViolations: e.fieldViolations,
    api: e.api,
    raw: e.raw,
  });
};

/** 解析成功响应：要求 ok!==false，返回 data 或整包 */
const unwrapOk = (parsed: unknown, api?: string): JsonRecord => {
  const rec = asRecord(parsed);
  if (!rec) {
    throw new LarkApiError("lark-cli 返回非 JSON 对象", { api, raw: parsed });
  }
  if (rec.ok === false) {
    throw normalizeLarkError({ stdout: JSON.stringify(rec) }, undefined, api);
  }
  // 部分 API 直接 { code:0, data }；CLI 包一层 { ok, data }
  if (typeof rec.code === "number" && rec.code !== 0) {
    throw normalizeLarkError({ stdout: JSON.stringify(rec) }, undefined, api);
  }
  return rec;
};

// ----------------- 瞬时传输失败的安全重试 -----------------

/** 最多重试次数（不含首次尝试） */
const LARK_MAX_RETRIES = 2;

/** 退避基数：300ms → 900ms。串行队列在退避期间是被占住的，不能拖长 */
const DEFAULT_RETRY_BASE_MS = 300;
let retryBaseMs = DEFAULT_RETRY_BASE_MS;

/** 单测把退避调到 0；传 null 复原（真等 1.2s 会撑掉用例预算） */
export const __setLarkRetryBaseForTest = (ms: number | null): void => {
  retryBaseMs = ms ?? DEFAULT_RETRY_BASE_MS;
};

/**
 * 判定用的全文：CLI 的传输层报错有时在 message 里、有时只在 stdout / stderr 里
 * （`normalizeLarkError` 解析不出 JSON 时原样塞进 raw），两处都要看。
 */
const larkErrorText = (err: LarkApiError): string => {
  const raw = err.raw as { stdout?: unknown; stderr?: unknown } | undefined;
  return [
    err.message,
    typeof raw?.stdout === "string" ? raw.stdout : "",
    typeof raw?.stderr === "string" ? raw.stderr : "",
  ].join("\n");
};

/**
 * 这次失败是否发生在「业务请求真正发出去之前」。
 *
 * 用户实测报文：`API call failed: Post "https://accounts.feishu.cn/oauth/v3/token": EOF`
 * ——挂在**取 token 那一跳**，业务请求一个字节都还没发出去，重试零副作用；
 * 所以连发消息 / 建群这种写操作在这条通道里也能安全重试。
 */
const isPreRequestTransportFailure = (text: string): boolean =>
  /accounts\.feishu\.cn|oauth\/v\d+\/token/i.test(text);

/**
 * 命令本身是否幂等（重试不会攒出第二份副作用）。
 *
 * ⛔ 写操作（发消息 / 建群 / 建卡）在「请求已发出、响应回来的路上断了」时无法区分
 * 成功与失败——盲目重试就是群里两张重复卡、工作项两个孤儿群（本仓真踩过，
 * 见 docs/feishu-group-collab.md）。写操作只走上面那条「确定还没发出去」的通道。
 */
const isIdempotentLarkCommand = (args: string[]): boolean => {
  if (args[0] === "auth" && args[1] === "status") return true;
  return args[0] === "api" && (args[1] ?? "").toUpperCase() === "GET";
};

/**
 * 要不要重试：**瞬时传输错误**且（命令幂等 或 失败在发请求之前）。
 * 业务错误（权限 / 参数 / bot 不在群）重试多少次都是同一个结果——一次都不重试。
 */
const shouldRetryLark = (args: string[], err: LarkApiError): boolean =>
  isTransientLarkError(err) &&
  (isPreRequestTransportFailure(larkErrorText(err)) ||
    isIdempotentLarkCommand(args));

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

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
    // 命令标签随错误一起上抛：飞书参数校验类报错的 message 是无信息量的
    // 「field validation failed」，不带上「哪条命令」根本没法定位
    const api = describeLarkCommand(finalArgs);
    // 瞬时传输失败重试：闸在 shouldRetryLark（幂等命令 / 确定没发出去的失败才重试）
    for (let attempt = 0; ; attempt += 1) {
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
            api,
            raw: { stdout, stderr },
          });
        }
        return unwrapOk(parsed, api);
      } catch (err) {
        const normalized =
          err instanceof LarkApiError ? err : normalizeLarkError(err, undefined, api);
        if (attempt >= LARK_MAX_RETRIES || !shouldRetryLark(finalArgs, normalized)) {
          throw normalized;
        }
        const delay = retryBaseMs * 3 ** attempt;
        console.warn(
          `[feishu-bridge/lark-api] ${api} 瞬时失败、${delay}ms 后重试（第 ${attempt + 1}/${LARK_MAX_RETRIES} 次）：${normalized.message}`,
        );
        await sleep(delay);
      }
    }
  });

/**
 * 裸调 OpenAPI：`lark-cli api <METHOD> <path> --as bot --data/--params --json`
 *
 * `as` 默认 bot；`user` 用于只有本人身份才答得出的查询（如「我还在不在这个群里」）。
 */
export const larkApi = async (
  method: string,
  apiPath: string,
  opts: {
    data?: unknown;
    params?: unknown;
    file?: string;
    as?: RunLarkOpts["as"];
  } = {},
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
  return runLark(args, opts.as ? { as: opts.as } : {});
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
 * 发纯文本到群聊（`--chat-id`，与私聊 `--user-id` 互斥）。
 *
 * 群里 @ 人用飞书文本消息的 `<at user_id="ou_xxx">名字</at>` 内联标签
 * （拼接由调用方做、见 group-route.mentionTag）。
 */
export const sendTextMessageToChat = async (
  chatId: string,
  text: string,
): Promise<SendMessageResult> => {
  const rec = await runLark([
    "im",
    "+messages-send",
    "--chat-id",
    chatId,
    "--text",
    text,
  ]);
  return extractSendResult(rec);
};

/**
 * 飞书 `post` 消息的 content JSON：整段走 `md` 标签。
 * 官方推荐发 Markdown 用这条（CommonMark + GFM）；`text` 类型不会渲染 `**` / `` ` `` / 列表。
 * `<at user_id="ou_xxx">名</at>` 写进 markdown 正文即可 @，不要再并排塞别的 post 标签
 *（`md` 必须独占一段）。
 */
export const buildPostMarkdownContent = (markdown: string): string =>
  JSON.stringify({
    zh_cn: {
      content: [[{ tag: "md", text: markdown }]],
    },
  });

/**
 * 往群聊发一段会渲染的 Markdown（`--msg-type post`）。
 * 群里 @ 答疑走这条；短状态回执（推进失败 / 没产物）仍用 {@link sendTextMessageToChat}。
 */
export const sendPostMarkdownToChat = async (
  chatId: string,
  markdown: string,
): Promise<SendMessageResult> => {
  const rec = await runLark([
    "im",
    "+messages-send",
    "--chat-id",
    chatId,
    "--msg-type",
    "post",
    "--content",
    buildPostMarkdownContent(markdown),
  ]);
  return extractSendResult(rec);
};

/**
 * 把一段文本以「文件消息」发进群聊（需求群分享的完整产物走这条）。
 *
 * 为什么要先落一次临时盘：lark-cli 的 `--file` 只吃 **cwd 相对路径**——绝对路径和 `..`
 * 会被直接拒（`--help` 明写、实测同）。而群里显示的文件名就是这个 basename，
 * 所以按展示名建一个一次性子目录、把文件写进去、以该目录为 cwd 只传 basename。
 *
 * 每次发送独占一个子目录：两个任务同时分享同名产物时不会互相盖文件。
 * 发完（含失败）一律删目录——临时文件不该在 dataRoot 里越攒越多。
 */
export const sendFileMessageToChat = async (
  chatId: string,
  filename: string,
  content: string,
): Promise<SendMessageResult> => {
  // basename 兜底：文件名由业务层拼（需求名 + action 标题），这里再挡一道路径穿越
  const safeName = path.basename(filename).trim() || "shared.md";
  const dir = path.join(
    await getBridgeDataDir(),
    "share-doc",
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(path.join(dir, safeName), content, "utf-8");
    const rec = await runLark(
      ["im", "+messages-send", "--chat-id", chatId, "--file", safeName],
      { cwd: dir },
    );
    return extractSendResult(rec);
  } finally {
    // 清理失败不影响已经发出去的消息，也不该盖掉真正的发送错误
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
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

/**
 * 发一张静态交互卡（清理卡 / 控制面板卡）：建卡实体 → 发 interactive 消息。
 * 与流式卡（card-stream）不同：一次成型、不开 streaming_mode。
 */
export const sendInteractiveCard = async (
  openId: string,
  cardJson: unknown,
): Promise<SendMessageResult & { card_id: string }> => {
  const created = await createCardEntity(cardJson);
  const sent = await sendCardMessage(openId, created.card_id);
  return { ...sent, card_id: created.card_id };
};

/**
 * 往群聊发卡片消息（`--chat-id`，与私聊 `--user-id` 互斥）。
 * 需求群分享闭环复用建卡实体能力，只换投递目标。
 */
export const sendCardMessageToChat = async (
  chatId: string,
  cardId: string,
): Promise<SendMessageResult> => {
  const content = JSON.stringify({
    type: "card",
    data: { card_id: cardId },
  });
  const rec = await runLark([
    "im",
    "+messages-send",
    "--chat-id",
    chatId,
    "--msg-type",
    "interactive",
    "--content",
    content,
  ]);
  return extractSendResult(rec);
};

/** 建卡实体 → 发到群聊（需求群分享用） */
export const sendInteractiveCardToChat = async (
  chatId: string,
  cardJson: unknown,
): Promise<SendMessageResult & { card_id: string }> => {
  const created = await createCardEntity(cardJson);
  const sent = await sendCardMessageToChat(chatId, created.card_id);
  return { ...sent, card_id: created.card_id };
};

/**
 * 创建群聊：`POST /open-apis/im/v1/chats?user_id_type=open_id`
 * bot 建群时自动入群；`user_id_list` ≤50 / `bot_id_list` ≤5（这里兜底裁剪）。
 *
 * **建群是唯一能带人 / 带 bot 的时机**——事后拉人、拉 bot 在免审 scope 下全不可用。
 * 同事的 open_id / app_id 由「需求群成员自动注册表」提供
 *（`feishu-group-registry`，按 email 反查；没命中就少带一个人、不报错）。
 */
export const createImChat = async (opts: {
  name: string;
  userIdList?: string[];
  /** 同事各自 Flowship 自建应用的 app_id（cli_xxx）；本机 bot 建群自动入群、不必带 */
  botIdList?: string[];
}): Promise<{ chat_id: string }> => {
  const rec = await larkApi("POST", "/open-apis/im/v1/chats", {
    params: { user_id_type: "open_id" },
    data: {
      name: opts.name,
      ...(opts.userIdList && opts.userIdList.length > 0
        ? { user_id_list: opts.userIdList.slice(0, 50) }
        : {}),
      ...(opts.botIdList && opts.botIdList.length > 0
        ? { bot_id_list: opts.botIdList.slice(0, 5) }
        : {}),
    },
  });
  const data = asRecord(rec.data) ?? rec;
  const chatId =
    (typeof data.chat_id === "string" && data.chat_id) ||
    (typeof data.chatId === "string" && data.chatId) ||
    "";
  if (!chatId) {
    throw new LarkApiError("建群成功但缺少 chat_id", { raw: rec });
  }
  return { chat_id: chatId };
};

// ----------------- 群可达性探针（需求群「死绑定」检测） -----------------

/** 群信息最小归一 */
export interface LarkChatInfo {
  chatId: string;
  /** 群名——分享回执里「发到哪个群了」就靠它 */
  name?: string;
}

/**
 * 获取群信息（`GET /open-apis/im/v1/chats/:chat_id`、bot 身份）。
 *
 * scope 与建群同族（`im:chat`）——建得出群基本就读得出群信息，所以这条是
 * 免审权限下最有把握的一个群查询。失败照常上抛，由调用方决定降级姿态
 *（读不到群名 ≠ 群没了，别在这里替调用方下结论）。
 */
export const fetchChatInfo = async (chatId: string): Promise<LarkChatInfo> => {
  const rec = await larkApi(
    "GET",
    `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
  );
  const data = asRecord(rec.data) ?? rec;
  const name =
    (typeof data.name === "string" && data.name.trim()) ||
    (typeof data.chat_name === "string" && data.chat_name.trim()) ||
    "";
  return { chatId, ...(name ? { name } : {}) };
};

/**
 * 判断**本人**（user 身份）还在不在这个群里。
 * `GET /open-apis/im/v1/chats/:chat_id/members/is_in_chat`，走 `--as user`。
 *
 * 为什么是 user 身份：这个接口判定的是「调用者自己」在不在群——tenant token 问的是
 * 机器人（我们场景里机器人一直在群，问了也是白问），只有 user token 才问得出
 * 「建群的那个人现在还在不在」。
 *
 * ⚠️ 群成员列表（`/members`）这条路走不通：免审 scope 下实测缺
 * `im:chat.members:read`（99991672），且不收 `member_id_type=app_id`。
 * 所以本人在不在群只能靠这个「问自己」的接口。scope 不够时照常抛，
 * 调用方按「判定不了」处理，绝不能猜。
 */
export const probeSelfInChat = async (chatId: string): Promise<boolean> => {
  const rec = await larkApi(
    "GET",
    `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members/is_in_chat`,
    { as: "user" },
  );
  const data = asRecord(rec.data) ?? rec;
  const v = data.is_in_chat ?? data.isInChat;
  if (typeof v !== "boolean") {
    // 拿不到那个布尔位 = 判定不了，绝不默认成 true / false
    throw new LarkApiError("is_in_chat 响应缺少判定字段", {
      api: "api GET /open-apis/im/v1/chats/:id/members/is_in_chat",
      raw: rec,
    });
  }
  return v;
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
 * CLI：`im images create --data '{"image_type":"message"}' --file image=<相对名>`
 *
 * ⚠️ lark-cli 的 `--file` **只接受 cwd 相对路径**——传绝对路径会报
 * `cannot open file` / `unsafe file path`（对齐 downloadMessageResource 的相对路径 + cwd 手法）。
 */
export const uploadImage = async (filePath: string): Promise<string> => {
  const abs = path.resolve(filePath);
  const cwd = path.dirname(abs);
  const base = path.basename(abs);
  const rec = await runLark(
    [
      "im",
      "images",
      "create",
      "--data",
      JSON.stringify({ image_type: "message" }),
      "--file",
      `image=${base}`,
    ],
    { cwd },
  );
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

// ----------------- auth status（本机凭据快照、零网络零 scope） -----------------

/**
 * `lark-cli auth status --json` 归一后的本机凭据快照。
 *
 * 只读本地凭据文件——不打飞书网络、不要任何 scope，所以它是「本机身份」的**首选**来源。
 * 实测形状：
 * `{ appId, brand, defaultAs, identity, identities: { bot: { status, available },
 *   user: { status, available, openId, userName, … } } }`
 */
export interface LarkAuthStatus {
  /** 自建应用 app_id（cli_xxx） */
  appId: string;
  /** 本人飞书 IM open_id（`identities.user.openId`）；user 身份没登录时为空串 */
  userOpenId: string;
  /** 本人姓名（`identities.user.userName`） */
  userName?: string;
  /** bot 身份可用——判「到底是没授权、还是授权着但这次调用挂了」的唯一依据 */
  botAvailable: boolean;
  /** 应用展示名：当前 CLI 版本不下发，将来给了就能省掉一次应用信息接口 */
  appName?: string;
}

/** 取第一个非空字符串字段（CLI 的 camelCase / snake_case 都可能出现） */
const pickString = (rec: JsonRecord | null, ...keys: string[]): string => {
  if (!rec) return "";
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
};

/** `auth status` 原始 JSON → 快照（纯函数、单测直接喂真实样本） */
export const parseLarkAuthStatus = (status: JsonRecord): LarkAuthStatus => {
  const identities = asRecord(status.identities);
  const user = identities ? asRecord(identities.user) : null;
  const bot = identities ? asRecord(identities.bot) : null;
  const userName = pickString(user, "userName", "user_name");
  const appName = pickString(status, "appName", "app_name");
  return {
    appId: pickString(status, "appId", "app_id"),
    userOpenId: pickString(user, "openId", "open_id"),
    ...(userName ? { userName } : {}),
    // available 是 CLI 的权威字段；老版本没有它时退 status === "ready"
    botAvailable:
      bot?.available === true || pickString(bot, "status") === "ready",
    ...(appName ? { appName } : {}),
  };
};

/** 跑一次 `auth status` 并归一；CLI 挂了照常上抛 */
const readLarkAuthStatus = async (): Promise<LarkAuthStatus> =>
  // auth status 不支持 --as（CLI 会报 unknown flag）
  parseLarkAuthStatus(await runLark(["auth", "status"], { as: "none" }));

/**
 * 探测本机凭据实况；CLI 没装 / 跑挂了返 **null**（= 状态未知、**不等于**未登录）。
 * 调用方据此区分「真没授权」和「授权着但这次调用失败」。
 */
export const probeLarkAuthStatus = async (): Promise<LarkAuthStatus | null> => {
  try {
    return await readLarkAuthStatus();
  } catch (err) {
    console.warn(
      "[feishu-bridge/lark-api] 读 auth status 失败（登录态未知）:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
};

// ----------------- 应用信息接口（身份 / 名字的降级来源） -----------------

/**
 * `GET /open-apis/application/v6/applications/<app_id>`：owner open_id + 应用名。
 *
 * ⚠️ 要「应用信息读取」权限、且真打飞书网络——**不能当身份主来源**：2026-07-27 实测
 * test 实例这条间歇性返回 `EOF`，把整条群分享链拖成「飞书机器人未登录」（报文带
 * token 字样被误分类）。只在 auth status 给不出时兜底。
 */
const fetchApplicationInfo = async (
  appId: string,
): Promise<{ ownerOpenId: string; appName?: string }> => {
  const rec = await larkApi(
    "GET",
    `/open-apis/application/v6/applications/${encodeURIComponent(appId)}`,
    { params: { lang: "zh_cn" } },
  );
  const data = asRecord(rec.data) ?? rec;
  const app = asRecord(data.app) ?? data;
  const appName = pickString(app, "app_name", "appName");
  return {
    ownerOpenId:
      pickString(asRecord(app.owner), "owner_id") ||
      pickString(app, "creator_id"),
    ...(appName ? { appName } : {}),
  };
};

// ----------------- bot 应用信息（本人 open_id 来源） -----------------

let botInfoCache: BotAppInfo | null = null;

/**
 * 本机「应用 + 属主」身份：app_id + 本人 open_id。
 *
 * 取 open_id 的降级链：
 * 1. `auth status` 的 `identities.user.openId`——零 API / 零 scope / 零网络，**首选**
 * 2. 应用信息接口的 `owner.owner_id`——只在 user 身份没登录时兜底
 *
 * 两者指向同一个人（自建应用的 owner 就是本机登录用户），所以优先便宜可靠的那条。
 * app_id 恒取自 auth status：应用信息接口挂了也不影响它。
 */
export const getBotAppInfo = async (): Promise<BotAppInfo> => {
  if (botInfoCache) return botInfoCache;
  const status = await readLarkAuthStatus();
  if (!status.appId) {
    throw new LarkApiError("auth status 未返回 appId", { raw: status });
  }
  if (status.userOpenId) {
    botInfoCache = {
      appId: status.appId,
      ownerOpenId: status.userOpenId,
      ...(status.appName ? { appName: status.appName } : {}),
    };
    return botInfoCache;
  }

  let info: { ownerOpenId: string; appName?: string };
  try {
    info = await fetchApplicationInfo(status.appId);
  } catch (err) {
    // 两条来源都断了：报文里要点出「user 身份没登录」这条真正可操作的线索，
    // 否则用户只看到一句网络 / 权限报错、想不到 `lark-cli auth login` 就能修
    throw prefixLarkError(err, "取本机 open_id 失败（auth status 无 user 身份）");
  }
  if (!info.ownerOpenId) {
    throw new LarkApiError("应用信息缺少 owner.owner_id", { raw: info });
  }
  botInfoCache = {
    appId: status.appId,
    ownerOpenId: info.ownerOpenId,
    ...(info.appName ? { appName: info.appName } : {}),
  };
  return botInfoCache;
};

/**
 * 机器人自身信息（`GET /open-apis/bot/v3/info`）：open_id + 展示名。
 *
 * 与 `BotAppInfo`（应用信息接口、owner = 本人）不是一回事：
 * - `openId`：群消息里 `@机器人` 的 mention id 是**机器人自己的** open_id，判「有没有 @ 我」只能用它
 * - `appName`：群成员列表 / 「添加机器人」搜索框里看到的名字——引导用户手动加 bot 时要给准确的这个
 *
 * 免审基础 scope（不需要应用信息读取权限），一次调用喂两个用途、只缓存成功结果。
 * 探测失败返 null——调用方各自降级（@ 判定按应用名字面匹配、展示名退 app_id），不因此丢消息。
 */
let botSelfCache: BotSelfInfo | null = null;

const fetchBotSelfInfo = async (): Promise<BotSelfInfo | null> => {
  if (botSelfCache) return botSelfCache;
  try {
    const rec = await larkApi("GET", "/open-apis/bot/v3/info");
    const data = asRecord(rec.data) ?? rec;
    const bot = asRecord(data.bot) ?? data;
    const openId =
      (typeof bot.open_id === "string" && bot.open_id) ||
      (typeof bot.openId === "string" && bot.openId) ||
      "";
    const appName =
      (typeof bot.app_name === "string" && bot.app_name.trim()) ||
      (typeof bot.appName === "string" && bot.appName.trim()) ||
      "";
    if (!openId && !appName) return null;
    botSelfCache = { openId, appName: appName || undefined };
    return botSelfCache;
  } catch (err) {
    console.warn(
      "[feishu-bridge/lark-api] 取机器人自身信息失败（群 @ 判定降级按名字匹配）:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
};

/** 机器人自己的 open_id；取不到返 null */
export const getBotOpenId = async (): Promise<string | null> =>
  (await fetchBotSelfInfo())?.openId || null;

// ----------------- bot 展示名（降级链单一来源） -----------------

/** 解析到的真名（进程内缓存——bot 名不会变） */
let botDisplayNameCache: string | null = null;

/**
 * 应用信息接口取名失败后的冷却时间。
 *
 * 既不能每次都重试（群里每条 @ 消息都要问一次名字、每次都起子进程），也不能失败一次
 * 就永久放弃：这条实测会**间歇性** `EOF`（2026-07-27 本机连打两次、一次挂一次好），
 * 永久放弃会让引导弹窗后半辈子都只显示 app_id。
 */
const APP_INFO_NAME_RETRY_MS = 5 * 60 * 1000;
/** 下次允许重试应用信息接口的时刻（0 = 随时可试） */
let appInfoNameRetryAt = 0;

/**
 * 本机 bot 的展示名 = 群成员列表 /「添加机器人」搜索框里看到的那个名字。
 * **拿不到真名返 null**——调用方各自决定退 app_id 还是泛称，别在这里编个假名字。
 *
 * 降级链（越靠前越便宜）：
 * 1. `bot/v3/info` 的 app_name：免审基础 scope、正是群里显示的名字。但**不是每个
 *    自建应用都有**——实测 test 实例这条返回空包 `{"ok":true,"data":{}}`
 * 2. `auth status` 的应用名：零网络（当前 CLI 不下发、以后给了自动用上）
 * 3. 应用信息接口的 app_name：要权限 + 打网络，失败后冷却 5 分钟再试
 */
export const getBotDisplayName = async (): Promise<string | null> => {
  if (botDisplayNameCache) return botDisplayNameCache;

  const self = await fetchBotSelfInfo();
  if (self?.appName) {
    botDisplayNameCache = self.appName;
    return botDisplayNameCache;
  }

  const status = await probeLarkAuthStatus();
  if (status?.appName) {
    botDisplayNameCache = status.appName;
    return botDisplayNameCache;
  }

  // 身份路径要是已经退过应用信息接口，名字早在手里了——别再打一次网络
  if (botInfoCache?.appName) {
    botDisplayNameCache = botInfoCache.appName;
    return botDisplayNameCache;
  }

  if (status?.appId && Date.now() >= appInfoNameRetryAt) {
    try {
      const name = (await fetchApplicationInfo(status.appId)).appName;
      if (name) {
        botDisplayNameCache = name;
        return botDisplayNameCache;
      }
    } catch (err) {
      console.warn(
        "[feishu-bridge/lark-api] 应用信息接口取 bot 名失败（冷却后再试）:",
        err instanceof Error ? err.message : err,
      );
    }
    appInfoNameRetryAt = Date.now() + APP_INFO_NAME_RETRY_MS;
  }
  return null;
};

// ----------------- 本机身份（需求群成员注册表用） -----------------

/** `auth status` 里能直接读到的本机身份（无需任何额外 API / scope） */
export interface LarkLocalIdentity {
  /** 本机自建应用 app_id（cli_xxx）——注册表里的 botAppId */
  appId: string;
  /** 本人飞书 IM open_id——注册表里的 openId、也是别人建群拉你用的 id */
  openId: string;
  /** 本人姓名（CLI 登录态自带、纯展示） */
  userName?: string;
}

let localIdentityCache: LarkLocalIdentity | null = null;

/**
 * 本机用户身份：`auth status` 的 `appId` + `identities.user.{openId,userName}`。
 *
 * 与 `getBotAppInfo()` 同源（应用 owner = 本机登录用户），差别只在语义与失败姿态：
 * 这里是**增强路径**的探针，user 身份没登录（只有 bot）就返 null、不抛、不兜底，
 * 缺了就不注册；`getBotAppInfo()` 是身份主路径，会再退一次应用信息接口。
 */
export const getLarkLocalIdentity =
  async (): Promise<LarkLocalIdentity | null> => {
    if (localIdentityCache) return localIdentityCache;
    const status = await probeLarkAuthStatus();
    if (!status?.appId || !status.userOpenId) return null;
    localIdentityCache = {
      appId: status.appId,
      openId: status.userOpenId,
      ...(status.userName ? { userName: status.userName } : {}),
    };
    return localIdentityCache;
  };

/** 单测清 bot 信息缓存 */
export const __resetBotAppInfoCacheForTest = (): void => {
  botInfoCache = null;
  botSelfCache = null;
  localIdentityCache = null;
  botDisplayNameCache = null;
  appInfoNameRetryAt = 0;
};
