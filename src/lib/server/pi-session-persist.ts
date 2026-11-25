/**
 * pi 会话文件（`<data>/pi-sessions/*.jsonl`）落盘前脱敏。
 *
 * # 为什么需要
 * pi 的 AgentSession 在每条 `message_end` 时调 `sessionManager.appendMessage(message)`，SessionManager 把整条消息
 * `JSON.stringify` 追加进会话文件——这条路径**不经过 Flowship 的任何脱敏**：
 * - 工具结果里的截图 base64（`desktop_screenshot` / `browser_screenshot`，一张 100KB~1.5MB）原样落盘——整屏截图可能是聊天记录、邮件、密码框……
 * - assistant 消息里 tool_call 的入参原样落盘：`desktop_type.text`（打进任意应用的字，含密码）、`browser_type.text` 等。
 * Flowship 自己的事件流（events.jsonl）早就脱敏了（`redact-args` / `image-redact`），而「输入的文字只记长度进审计，绝不进日志」
 * 是对用户的承诺——pi 的会话文件同样是落在用户硬盘上的日志，不能是漏网之处。
 *
 * # 做法
 * 包装 SessionManager **公开**的 `appendMessage`：交给它之前先拿到一份脱敏后的拷贝（写时复制，**不改入参**）。
 * 不碰 `_persist` / `_rewriteFile` 这些私有方法（升级 pi 时它们随时会变）。
 *
 * 为什么只改这一个口子就够、且不影响当前这一轮的模型：
 * - 当前轮模型下一次调用用的是 agent-core 自己 state 里的消息（完整，截图还在），SessionManager 的 entries 只用于落盘 / resume / compaction 后重建上下文；
 * - 代价：重启 app 后 resume、或 compaction 之后，历史里的截图是占位文字、历史入参里的明文是「已隐藏 N 字符」——
 *   旧截图本来就过时，要看模型会重新截；打出去的字也不需要再被读回来。
 *
 * # 脱敏本身出错：fail-closed
 * `redactOnPersist` 里脱敏抛了错 → 这条消息改成 {@link failClosedPiMessage} 的占位骨架再落盘（只留配对用的 id / 名字、usage 数字，
 * 文字 / 入参 / 图片 / details 一律不带），异常不抛进 pi 的事件循环、日志只记角色与异常类型。**绝不**回退到「写原文」，
 * 也不是「吞掉异常继续」——前者泄密，后者（没处理就返回原消息）等于同一件事。
 *
 * # 已知没盖到的
 * - 升级前已经落盘的会话文件不会回头改写；
 * - compaction 摘要是模型写的文字，模型若把「我输入了密码 xxx」写进摘要，这里管不到；
 * - `browser_storage reveal` 的明文 cookie 在**结果文本**里（不是入参），也没处理。
 *
 * 复用 `redactBrowserArgs`（browser_* / desktop_* 入参脱敏，幂等、写时复制）与 `stripImageBlocks`（≥2KB 的图片块 → 占位文字），不再平行写一份。
 * tests/pi-session-persist.test.ts 用真实的 pi SessionManager 钉死「磁盘上没有明文 / base64、调用方手里的消息没被改」，
 * 并有一条对照用例证明「不包装就会落明文」——pi 哪天自己处理了或改了写盘入口，测试会红。
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { stripImageBlocks } from "./browser/image-redact";
import { redactBrowserArgs } from "./browser/redact-args";

type PersistMessage = Parameters<SessionManager["appendMessage"]>[0];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * 一条 pi 消息 → 落盘用的脱敏版本（纯函数）。没有要藏的东西时返回**原引用**；有就返回浅拷贝，入参一个字不动：
 * - assistant：content 里 `toolCall` 块的 `arguments` 套 {@link redactBrowserArgs}（`desktop_type.text` / `desktop_key` 里会打出字符的按键 /
 *   `browser_type.text` / `browser_fill_form` …；其它工具的入参不动）；
 * - toolResult：content 里的图片块换成占位文字（所有工具都换——`read` 读到的图片同样不值得把 base64 留在会话文件里）；
 * - 其它角色（user / custom / bashExecution …）原样：用户自己发的图要留着，resume 后模型还能看到。
 */
export const redactPiMessageForPersist = <M>(message: M): M => {
  if (!isRecord(message)) return message;
  if (message.role === "assistant" && Array.isArray(message.content)) {
    let changed = false;
    const content = message.content.map((block: unknown) => {
      if (!isRecord(block) || block.type !== "toolCall") return block;
      const next = redactBrowserArgs(block.name, block.arguments);
      if (next === block.arguments) return block;
      changed = true;
      return { ...block, arguments: next };
    });
    return changed ? ({ ...message, content } as M) : message;
  }
  if (message.role === "toolResult") {
    const content = stripImageBlocks(message.content);
    return content === message.content ? message : ({ ...message, content } as M);
  }
  return message;
};

/** 脱敏失败时占位消息里的那句话（也是测试断言的锚点） */
export const PI_PERSIST_REDACTION_FAILED_TEXT = "[该条消息因脱敏失败，内容已省略]";

const STOP_REASONS_KEPT = new Set(["stop", "length", "toolUse", "error", "aborted"]);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 万不得已的占位：谁都认得的合法 user 消息（只有「脱敏失败」一句话，不含原消息的任何东西） */
const placeholderMessage = (): PersistMessage =>
  ({
    role: "user",
    content: [{ type: "text", text: PI_PERSIST_REDACTION_FAILED_TEXT }],
    timestamp: Date.now(),
  }) as PersistMessage;

/**
 * 脱敏本身抛了错时，这条消息**落盘用的骨架**（fail-closed：宁可丢内容，也不把没脱敏的原文写盘）。
 *
 * 只从原消息里取「结构必需的标量」，任何内容性的东西一律不带：
 * - toolResult：保留 toolCallId / toolName / isError（resume 后和 assistant 的 toolCall 还能配对），内容换成一句占位，details 丢掉；
 * - assistant：保留 toolCall 的 id / name（配对用）但 `arguments` 清空，文字 / thinking 块换成一句占位；usage 只取数字、stopReason 只认合法值；
 * - 其它 / 不是对象 / 连读属性都抛：一条只有占位文字的 user 消息。
 * 本函数自己**不会抛**（读属性也包在 try 里：getter / Proxy 都可能抛）。
 */
export const failClosedPiMessage = (message: unknown): PersistMessage => {
  try {
    if (!isRecord(message)) return placeholderMessage();
    const timestamp = typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : Date.now();
    const stub = [{ type: "text", text: PI_PERSIST_REDACTION_FAILED_TEXT }];
    if (message.role === "toolResult") {
      return {
        role: "toolResult",
        toolCallId: str(message.toolCallId),
        toolName: str(message.toolName),
        content: stub,
        isError: message.isError === true,
        timestamp,
      } as PersistMessage;
    }
    if (message.role === "assistant") {
      const calls = (Array.isArray(message.content) ? message.content : [])
        .filter((b: unknown): b is Record<string, unknown> => isRecord(b) && b.type === "toolCall")
        .map((b: Record<string, unknown>) => ({ type: "toolCall", id: str(b.id), name: str(b.name), arguments: {} }));
      const usage = isRecord(message.usage) ? message.usage : {};
      const cost = isRecord(usage.cost) ? usage.cost : {};
      const stopReason = str(message.stopReason);
      return {
        role: "assistant",
        content: [...stub, ...calls],
        api: str(message.api),
        provider: str(message.provider),
        model: str(message.model),
        usage: {
          input: num(usage.input),
          output: num(usage.output),
          cacheRead: num(usage.cacheRead),
          cacheWrite: num(usage.cacheWrite),
          totalTokens: num(usage.totalTokens),
          cost: {
            input: num(cost.input),
            output: num(cost.output),
            cacheRead: num(cost.cacheRead),
            cacheWrite: num(cost.cacheWrite),
            total: num(cost.total),
          },
        },
        stopReason: STOP_REASONS_KEPT.has(stopReason) ? stopReason : "stop",
        timestamp,
      } as PersistMessage;
    }
  } catch {
    // 读原消息的属性都抛了：落到最后的占位
  }
  return placeholderMessage();
};

/** 异常的类型名（日志用）。**不要**带 message：JSON.parse 之类的报错信息里会有被处理内容的片段 */
const errorKind = (err: unknown): string => {
  try {
    return err instanceof Error ? err.name : typeof err;
  } catch {
    return "unknown";
  }
};

const roleForLog = (message: unknown): string => {
  try {
    return isRecord(message) && typeof message.role === "string" ? message.role : "?";
  } catch {
    return "?";
  }
};

/**
 * 让这个 SessionManager 写盘（以及记进它自己 entries）的消息都是 {@link redactPiMessageForPersist} 之后的版本。
 * 原地包装实例的 `appendMessage` 并返回同一个实例；`inMemory` 的会话不落盘，不需要包。
 *
 * 脱敏**抛错**时 fail-closed：改写成 {@link failClosedPiMessage} 的占位骨架再落盘（不写原文）、也不把异常抛进 pi 的事件循环
 * （那会让一条脱敏的 bug 把整轮带崩）；日志只记消息角色与异常类型，不带异常信息、更不带消息内容。
 */
export const redactOnPersist = <T extends SessionManager>(sm: T): T => {
  const original = sm.appendMessage.bind(sm);
  sm.appendMessage = (message: PersistMessage): string => {
    let safe: PersistMessage;
    try {
      safe = redactPiMessageForPersist(message);
    } catch (err) {
      console.warn(
        `[pi-session-persist] 脱敏失败（${errorKind(err)}），该条消息以占位骨架落盘、原文不写盘 role=${roleForLog(message)}`,
      );
      safe = failClosedPiMessage(message);
    }
    return original(safe);
  };
  return sm;
};

/** 新建一个会落盘的 pi 会话（custom-agent-backend 不得直接调 `SessionManager.create`，tests/pi-session-persist.test.ts 扫源码守着） */
export const createPersistedPiSession = (cwd: string, sessionDir: string): SessionManager =>
  redactOnPersist(SessionManager.create(cwd, sessionDir));

/** 续接一个落盘的 pi 会话（同上，不得直接调 `SessionManager.open`） */
export const openPersistedPiSession = (file: string, sessionDir: string, cwd: string): SessionManager =>
  redactOnPersist(SessionManager.open(file, sessionDir, cwd));
