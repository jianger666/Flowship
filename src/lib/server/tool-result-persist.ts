/**
 * 工具完成结果 → tool_result 事件 meta（Phase 1「看得见」）
 *
 * - output 上限 8KB；超限截断并落全量到 tool-outputs/<callId>.txt
 *   （预览：shell 取「头 2KB + …(省略 N 字符)… + 尾约 6KB」，报错常在尾部；其余工具只取头部）
 * - edit/write 额外带 filePath + diff（diff 上限 16KB；无 SDK diff 则只摘要）
 * - shell 额外带 exitCode / executionTime
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { RESERVED_MCP_NAMES } from "@/lib/mcp-config";
import { isMcpToolName } from "@/lib/mcp-tool-name";
import { humanizeToolErrorText } from "@/lib/tool-error-text";

import { renameWithRetry } from "./data-root";
import { stringifyMeta } from "./task-stream";
import { taskDir, TOOL_OUTPUTS_DIR } from "./task-fs-core";
import { normalizeToolName } from "./normalize-tool-name";

/** tool_result.meta.output 上限（UTF-8 字节） */
export const TOOL_RESULT_OUTPUT_LIMIT = 8 * 1024;
/** edit/write tool_result.meta.diff 上限（UTF-8 字节） */
export const TOOL_RESULT_DIFF_LIMIT = 16 * 1024;

/** 单任务 tool-outputs 保留上限：文件数 / 总字节（写入时 best-effort 删最老） */
export const TOOL_OUTPUTS_MAX_FILES = 200;
export const TOOL_OUTPUTS_MAX_BYTES = 50 * 1024 * 1024;

const utf8ByteLength = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * 按 UTF-8 字节上限取前缀，落在 Unicode code point 边界
 *（不把多字节字符 / surrogate pair 切一半）。
 */
const sliceUtf8Prefix = (s: string, maxBytes: number): string => {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  // 续字节 10xxxxxx：回退到字符起始
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }
  return buf.subarray(0, end).toString("utf8");
};

/**
 * 硬截断：含后缀的总 UTF-8 字节 ≤ limit（后缀计入配额，与 types.ts「上限 8KB」契约一致）。
 * 后缀形如 `…(truncated N chars)`，N = 被省略的正文 UTF-16 码元数（与历史展示一致）。
 * limit 过小塞不下后缀时退化为按字节前缀截断。
 * ASCII 正文下 1 字符 ≈ 1 字节，行为与旧实现基本一致。
 */
export const truncateToLimit = (s: string, limit: number): string => {
  if (utf8ByteLength(s) <= limit) return s;
  if (limit <= 0) return "";
  // 迭代收敛：suffix 位数随 body 变化，通常 1～2 轮即稳
  let bodyBudget = Math.min(utf8ByteLength(s), limit);
  for (let i = 0; i < 4; i++) {
    const body = sliceUtf8Prefix(s, bodyBudget);
    const omitted = s.length - body.length;
    const suffix = `…(truncated ${omitted} chars)`;
    const suffixBytes = utf8ByteLength(suffix);
    if (suffixBytes >= limit) {
      return sliceUtf8Prefix(s, limit);
    }
    const nextBudget = Math.min(utf8ByteLength(s), limit - suffixBytes);
    if (nextBudget === bodyBudget) {
      return body + suffix;
    }
    bodyBudget = nextBudget;
  }
  const body = sliceUtf8Prefix(s, bodyBudget);
  const omitted = s.length - body.length;
  const suffix = `…(truncated ${omitted} chars)`;
  const out = body + suffix;
  return utf8ByteLength(out) <= limit ? out : sliceUtf8Prefix(out, limit);
};

/**
 * 按 UTF-8 字节上限取后缀，起点落在 Unicode code point 边界
 * （与 {@link sliceUtf8Prefix} 对称：不把多字节字符 / surrogate pair 切一半）。
 */
const sliceUtf8Suffix = (s: string, maxBytes: number): string => {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let start = buf.length - maxBytes;
  // 起点落在续字节 10xxxxxx 上：前进到下一个字符起点（丢掉被切开的那个字符）
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
    start++;
  }
  return buf.subarray(start).toString("utf8");
};

/** shell 预览保留的头部字节数（其余配额给尾部） */
export const SHELL_PREVIEW_HEAD_BYTES = 2 * 1024;

/**
 * 头 + 尾预览（U3a-06，shell 用）：头 {@link SHELL_PREVIEW_HEAD_BYTES} 字节
 * + `\n…(省略 N 字符)…\n` + 尾（吃满剩余配额，约 6KB），总 UTF-8 字节 ≤ limit。
 *
 * 为什么：测试 / 构建的报错几乎都在输出尾部，旧的只取头 8KB 让用户看到的全是进度噪声。
 * 头尾切口都落在 code point 边界；N = 被省略的正文 UTF-16 码元数（与 `…(truncated N chars)` 同口径）。
 * limit 太小放不下「头 + 标记 + 尾」时退化为 {@link truncateToLimit}（只留头部）。
 */
export const truncateHeadTail = (
  s: string,
  limit: number,
  headBytes: number = SHELL_PREVIEW_HEAD_BYTES,
): string => {
  if (utf8ByteLength(s) <= limit) return s;
  if (limit <= 0) return "";
  // 标记 ≈ 24 字节 + 数字位数；留出 64 字节余量保证尾部至少有内容，否则没必要拆头尾
  if (limit <= headBytes + 64) return truncateToLimit(s, limit);

  const head = sliceUtf8Prefix(s, headBytes);
  const rest = s.slice(head.length);
  // 标记长度取决于 N 的位数、N 取决于尾长：先按 40 字节估，超了再按实际超出量收紧，通常 1 轮即稳
  let tailBudget = limit - utf8ByteLength(head) - 40;
  for (let i = 0; i < 4 && tailBudget > 0; i++) {
    const tail = sliceUtf8Suffix(rest, tailBudget);
    const omitted = s.length - head.length - tail.length;
    const marker = `\n…(省略 ${omitted} 字符)…\n`;
    const total =
      utf8ByteLength(head) + utf8ByteLength(marker) + utf8ByteLength(tail);
    if (total <= limit) return head + marker + tail;
    tailBudget -= total - limit;
  }
  return truncateToLimit(s, limit);
};

/** 预览取法：默认只取头部；shell 报错常在尾部，用头 + 尾 */
export type OutputPreviewMode = "head" | "head-tail";

const previewOutput = (
  s: string,
  limit: number,
  mode: OutputPreviewMode,
): string =>
  mode === "head-tail" ? truncateHeadTail(s, limit) : truncateToLimit(s, limit);

/** SDK 原始工具名 → 预览取法（与 finishMeta 里认 shell 的口径一致：rawName === "shell"） */
const previewModeFor = (rawName: string): OutputPreviewMode =>
  rawName === "shell" ? "head-tail" : "head";

/** 供单测 / 清理策略用的文件统计 */
export type ToolOutputFileStat = {
  name: string;
  mtimeMs: number;
  size: number;
};

/**
 * 纯函数：超限时选出要删的最老文件名（按 mtime 升序）。
 * 先按文件数砍到 maxFiles，再按总字节继续砍，直到两者都满足。
 */
export const selectToolOutputsToPrune = (
  files: ToolOutputFileStat[],
  limits: { maxFiles: number; maxBytes: number } = {
    maxFiles: TOOL_OUTPUTS_MAX_FILES,
    maxBytes: TOOL_OUTPUTS_MAX_BYTES,
  },
): string[] => {
  if (files.length === 0) return [];
  const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);
  let totalBytes = sorted.reduce((s, f) => s + f.size, 0);
  const toDelete: string[] = [];
  let remaining = sorted;
  while (
    remaining.length > limits.maxFiles ||
    totalBytes > limits.maxBytes
  ) {
    const oldest = remaining[0];
    if (!oldest) break;
    toDelete.push(oldest.name);
    totalBytes -= oldest.size;
    remaining = remaining.slice(1);
  }
  return toDelete;
};

/** 写入后顺手清理：超 200 文件或 50MB 删最老；失败只打日志 */
export const pruneToolOutputsDir = async (taskId: string): Promise<void> => {
  const dir = getToolOutputsDir(taskId);
  let entries: Array<{ name: string; mtimeMs: number; size: number }>;
  try {
    const names = await fs.readdir(dir);
    entries = await Promise.all(
      names.map(async (name) => {
        const st = await fs.stat(path.join(dir, name));
        return {
          name,
          mtimeMs: st.mtimeMs,
          size: st.size,
        };
      }),
    );
  } catch (err) {
    // 目录不存在等 → 无需清
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    console.warn(`[tool-result] 列举 tool-outputs 失败 task=${taskId}`, err);
    return;
  }
  const victims = selectToolOutputsToPrune(entries);
  for (const name of victims) {
    try {
      await fs.unlink(path.join(dir, name));
    } catch (err) {
      console.warn(
        `[tool-result] 删旧 tool-output 失败 task=${taskId} file=${name}`,
        err,
      );
    }
  }
};

export type ToolResultStatus = "success" | "error" | "interrupted";

export type ToolResultMeta = {
  callId: string;
  /** 归一化工具名（MCP → mcp:server:tool） */
  name: string;
  status: ToolResultStatus;
  /** 结果文本（可能已截断） */
  output: string;
  /** output 是否被截断 */
  truncated?: boolean;
  /** 截断时全量落盘相对路径：tool-outputs/<callId>.txt */
  fullPath?: string;
  /** shell：退出码 */
  exitCode?: number;
  /** shell：SDK 报告的执行耗时 ms */
  executionTime?: number;
  /** edit / write：目标文件路径 */
  filePath?: string;
  /** edit：SDK diffString（unified）/ pi 的 details.patch；write 通常无此字段 */
  diff?: string;
  /** diff 是否被截断 */
  diffTruncated?: boolean;
};

/** 空 / 全非法字符时的固定回退（写读两侧一致；禁止 Date.now 非确定性） */
export const UNKNOWN_CALL_ID_FALLBACK = "call_unknown";

/** callId → 安全文件名（防路径穿越 / 奇怪字符） */
export const sanitizeCallIdForPath = (callId: string): string => {
  const cleaned = callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  return cleaned.length > 0 ? cleaned : UNKNOWN_CALL_ID_FALLBACK;
};

export const getToolOutputsDir = (taskId: string): string =>
  path.join(taskDir(taskId), TOOL_OUTPUTS_DIR);

export const toolOutputRelPath = (callId: string): string =>
  `${TOOL_OUTPUTS_DIR}/${sanitizeCallIdForPath(callId)}.txt`;

type ResultEnvelope = {
  status?: string;
  value?: Record<string, unknown>;
  error?: unknown;
  /** pi 的返回是 `{ content, details }`，没有 status / value 信封（details 里才有 diff / isError） */
  details?: unknown;
};

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;

/** 从 SDK tool_call result 抽可读输出文本 */
export const extractToolOutputText = (
  toolName: string,
  result: unknown,
): string => {
  if (result == null) return "";
  if (typeof result === "string") return humanizeToolErrorText(result) || result;

  const env = asRecord(result) as ResultEnvelope | null;
  if (!env) return stringifyMeta(result);

  if (env.status === "error") {
    return (
      humanizeToolErrorText(env.error ?? result) ||
      stringifyMeta(env.error ?? result)
    );
  }

  // pi customTools：{ content: [{ type: "text", text }], details }，没有 status 信封
  if (Array.isArray((env as Record<string, unknown>).content)) {
    const human = humanizeToolErrorText(result);
    if (human) return human;
  }

  const value = env.value;
  if (!value) return stringifyMeta(result);

  // shell：拼 stdout + stderr
  if (
    toolName === "shell" ||
    typeof value.stdout === "string" ||
    typeof value.stderr === "string"
  ) {
    const stdout = typeof value.stdout === "string" ? value.stdout : "";
    const stderr = typeof value.stderr === "string" ? value.stderr : "";
    if (stdout && stderr) return `${stdout}\n${stderr}`;
    return stdout || stderr;
  }

  // read
  if (typeof value.content === "string") return value.content;

  // write 摘要（无 diff 时给前端可展开的一句话）
  if (toolName === "write") {
    const p = typeof value.path === "string" ? value.path : "";
    const lines =
      typeof value.linesCreated === "number" ? value.linesCreated : undefined;
    const size =
      typeof value.fileSize === "number" ? value.fileSize : undefined;
    const parts = [
      p ? `wrote ${p}` : "wrote file",
      lines !== undefined ? `${lines} lines` : null,
      size !== undefined ? `${size} bytes` : null,
    ].filter(Boolean);
    return parts.join(" · ");
  }

  // edit 无 diffString 时的行数摘要
  if (toolName === "edit") {
    const added =
      typeof value.linesAdded === "number" ? `+${value.linesAdded}` : null;
    const removed =
      typeof value.linesRemoved === "number" ? `-${value.linesRemoved}` : null;
    if (added || removed) return `edit ${[added, removed].filter(Boolean).join(" ")}`;
  }

  return stringifyMeta(value);
};

/**
 * Flowship 自有工具名（= flowship-tools.ts 的 `flowShipTools`）。pi 里是裸名；
 * Cursor 里被 SDK 注册成合成 MCP server，展示名是 `mcp:custom-user-tools:<name>`（旧会话 `mcp:flowshipChat:`）。
 *
 * 不直接 import flowShipTools：它会把 task-fs / schedule-store 等一大串模块拖进每个只想判状态的调用方。
 * 名单漂移由 tests/tool-result-persist.test.ts 的契约用例守（遍历 flowShipTools 逐个断言）。
 */
const FLOWSHIP_OWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "submit_work",
  "ask_user",
  "submit_mr",
  "set_feishu_testers",
  "set_plan_batches",
  "create_custom_action",
  "share_to_group",
  "notify_group_testers",
  "expect_group_reply",
  "wait",
  "schedule",
]);

/** 自有工具的裸名（`schedule` / `mcp:custom-user-tools:schedule` → `schedule`）；不是自有工具返回 null */
const ownToolBaseName = (name: string): string | null => {
  if (FLOWSHIP_OWN_TOOL_NAMES.has(name)) return name;
  if (!name.startsWith("mcp:")) return null;
  // mcp:<server>:<tool>——server 必须正好是保留的合成名（不做前缀匹配，第三方 MCP 不沾光）
  const rest = name.slice("mcp:".length);
  const i = rest.indexOf(":");
  if (i <= 0) return null;
  const base = rest.slice(i + 1);
  return RESERVED_MCP_NAMES.has(rest.slice(0, i)) &&
    FLOWSHIP_OWN_TOOL_NAMES.has(base)
    ? base
    : null;
};

export const isFlowshipOwnToolName = (name: string): boolean =>
  ownToolBaseName(name) !== null;

/** 自有工具的 JSON 正文再大也只是几行状态，超过这个长度肯定不是它们的失败回包，不值得 parse */
const OWN_TOOL_FAIL_PAYLOAD_MAX_CHARS = 64 * 1024;

/**
 * 抽 result 里的文本段（只读、不改）：
 * - pi：`{ content: [{ type:"text", text }] }`
 * - Cursor 把自有工具当 MCP 回传：`{ status, value: { content: [{ text: { text } }] } }`
 */
const collectResultTextParts = (env: ResultEnvelope): string[] => {
  const out: string[] = [];
  const push = (content: unknown): void => {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      const p = asRecord(part);
      if (!p) continue;
      if (typeof p.text === "string") out.push(p.text);
      else {
        const nested = asRecord(p.text);
        if (nested && typeof nested.text === "string") out.push(nested.text);
      }
    }
  };
  push((env as Record<string, unknown>).content);
  push(env.value?.content);
  return out;
};

/**
 * 自有工具的「业务失败」：`text(JSON.stringify({ ok: false, … }))` 是**正常返回**（不抛、isError 也不置），
 * 不特判的话工具行和组头全亮绿 ✓（V4-03）。
 *
 * 判据收得很紧：必须是自有工具（调用方保证）、正文 trim 后首字符是 `{`、能 parse 成对象、`ok === false`。
 * 「正文里碰巧含 "ok":false 字样」「ok 是字符串 / 0」「半截 JSON」一律不算。
 */
const ownToolPayloadFailed = (env: ResultEnvelope): boolean => {
  for (const raw of collectResultTextParts(env)) {
    const t = raw.trim();
    if (!t.startsWith("{") || t.length > OWN_TOOL_FAIL_PAYLOAD_MAX_CHARS) continue;
    try {
      const parsed = JSON.parse(t) as unknown;
      if (asRecord(parsed)?.ok === false) return true;
    } catch {
      // 非 JSON / 半截——不是失败回包
    }
  }
  return false;
};

/** 「任务已被新 agent 接管、本次调用忽略」（chat-pending 的 CALLER_MISMATCH_ERROR；契约测试守文案一致） */
const CALLER_MISMATCH_TEXT = "任务已被新 agent 接管、本次调用忽略";

/**
 * 自有工具的**纯文本**失败前缀（R7-01）：这些分支 `return text("…")` 是正常返回（不抛、isError 也不置，
 * Cursor 路径的 MCP 信封里也没有错误信号），JSON 判据（{@link ownToolPayloadFailed}）接不住，工具行 / 组头会亮绿 ✓。
 *
 * 按**工具**分表、**精确前缀**（含全角冒号）、只看正文开头——不做「失败 / 错误」模糊匹配：
 * 误判代价不对称（把成功标红比漏标更糟），定时标题、shell 输出里碰巧出现的字都不能算。
 * 文案出处：flowship-tools.ts（schedule / create_custom_action / wait / ask_user / share_to_group）与 chat-pending.ts；
 * tests/own-tool-plain-failure.test.ts 守「表里每条前缀都在源码里」和「真实 handler 的失败回包被判成 error」。
 * 新增会返回纯文本失败的自有工具分支时，要同步这张表。
 */
export const OWN_TOOL_PLAIN_FAILURE_PREFIXES: Readonly<
  Record<string, readonly string[]>
> = {
  schedule: [
    "定时不可用：",
    "参数错误：",
    "取消失败：",
    "创建失败：",
    CALLER_MISMATCH_TEXT,
  ],
  create_custom_action: ["label 不能为空", "主 skill「", "挂载失败："],
  wait: ["参数错误："],
  ask_user: [CALLER_MISMATCH_TEXT, "任务已被接管/通知失败、请重试"],
  share_to_group: [CALLER_MISMATCH_TEXT],
  // submit_work 的失败文案全来自 flowship-tools.ts 的 mapSubmitWorkNotifyToToolText：
  // error / busy →「交卷未受理：…」、stale →「该 action 已结束/已被后续操作取代…」、no_notifier →「交卷未受理：任务当前没有活跃会话桥…」
  // （第四轮 Q7a-01：之前只列了 mismatch，每个 action 必经的收尾工具被拒时仍亮绿勾）
  submit_work: [CALLER_MISMATCH_TEXT, "交卷未受理：", "该 action 已结束/已被后续操作取代"],
};

const ownToolPlainFailed = (toolName: string, env: ResultEnvelope): boolean => {
  const base = ownToolBaseName(toolName);
  const prefixes = base ? OWN_TOOL_PLAIN_FAILURE_PREFIXES[base] : undefined;
  if (!prefixes) return false;
  for (const raw of collectResultTextParts(env)) {
    const t = raw.trimStart();
    if (prefixes.some((p) => t.startsWith(p))) return true;
  }
  return false;
};

/**
 * 判定 tool_result status。认三套形状（V4-03：原来只认前两套之一）：
 * - Cursor：`msgStatus === "error"` / `{status:"error"}` / MCP `value.isError`（对齐 run-perf）；
 * - pi：`ev.isError` 只在 execute **抛错**时为真，MCP 桥返回 `details:{ isError:true }` 不抛——要看 details；
 * - Flowship 自有工具的业务失败 `{"ok":false,…}`（见 {@link ownToolPayloadFailed}）
 *   与纯文本失败（`创建失败：…` 等，见 {@link OWN_TOOL_PLAIN_FAILURE_PREFIXES}）。
 */
export const resolveToolResultStatus = (
  msgStatus: string,
  toolName: string,
  result: unknown,
): ToolResultStatus => {
  if (msgStatus === "error") return "error";
  const env = asRecord(result) as ResultEnvelope | null;
  if (env?.status === "error") return "error";
  if (
    isMcpToolName(toolName) &&
    env?.value &&
    env.value.isError === true
  ) {
    return "error";
  }
  if (env && asRecord(env.details)?.isError === true) return "error";
  if (
    env &&
    isFlowshipOwnToolName(toolName) &&
    (ownToolPayloadFailed(env) || ownToolPlainFailed(toolName, env))
  ) {
    return "error";
  }
  return "success";
};

/**
 * 原子写 tool-outputs 全量文件（tmp + rename，与 writeMeta 同款）。
 *
 * 只建 `tool-outputs/` 这一层、**不 recursive**（第三轮 review D4b-02）：任务目录不存在 = 任务已被删，
 * 此时迟到的 tool-result 落盘若 recursive 建目录，会把一个没有 meta 的 `<taskDir>/tool-outputs/` 复活出来。
 * 非 recursive 的 mkdir 在父目录（taskDir）缺失时抛 ENOENT——调用方都已 try/catch 降级
 * （spillModelFullOutput 返回 null、persistTruncatedOutput 退回截断展示），不会拖垮工具执行。
 * `tool-outputs/` 已存在（EEXIST）是常态，吞掉。
 */
const writeToolOutputAtomic = async (
  absPath: string,
  full: string,
): Promise<void> => {
  try {
    await fs.mkdir(path.dirname(absPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
  }
  const tmpPath = `${absPath}.tmp.${process.pid}.${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  try {
    await fs.writeFile(tmpPath, full, "utf-8");
    await renameWithRetry(tmpPath, absPath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
};

/**
 * 模型截断层（tool-output-budget V2）落真实全量：与 UI 共用同一个文件
 * `tool-outputs/<callId>.txt`——模型后缀里的绝对路径和 UI「查看完整输出」指向同一份全文。
 *
 * 时序保证：withModelBudget 在 `execute` 返回前 await 本函数，所以后到的
 * buildToolResultMeta 一定能看到完整文件（不会读到半截）。失败返回 null、
 * 调用方降级成 V1 后缀（缩小范围重取），绝不拖垮工具执行。
 */
export const spillModelFullOutput = async (
  taskId: string,
  callId: string,
  full: string,
): Promise<{ absPath: string; relPath: string } | null> => {
  const rel = toolOutputRelPath(callId);
  const abs = path.join(taskDir(taskId), rel);
  try {
    await writeToolOutputAtomic(abs, full);
    // best-effort 清旧文件（超 200 / 50MB），与 persistTruncatedOutput 同策略
    void pruneToolOutputsDir(taskId);
    return { absPath: abs, relPath: rel };
  } catch (err) {
    console.warn(
      `[tool-result] 模型全量落盘失败 task=${taskId} callId=${callId}`,
      err,
    );
    return null;
  }
};

/**
 * execute 返回对象 → 落盘绝对路径（同进程内引用直连）。
 *
 * 用途（P2-2 fast path）：buildToolResultMeta 收到的是 execute 返回值的同一引用
 * （pi 会话事件 → SDKMessage → emitToolResult 全程传引用、不序列化），有映射就不用
 * 靠「outputText 长度猜有没有落盘」、省掉 8~64KB 频段每次一次 stat miss。
 * 引用丢失（exotic）时 lookup 返回 undefined，调用方回退长度门 + 读盘兜底——
 * 映射永远只是加速，不承载正确性。value 是我们自己写的落盘路径，非外部输入。
 */
const modelSpillByResult = new WeakMap<object, string>();

export const registerModelSpillResult = (
  result: object,
  absPath: string,
): void => {
  modelSpillByResult.set(result, absPath);
};

export const modelSpillPathForResult = (result: unknown): string | undefined =>
  typeof result === "object" && result !== null
    ? modelSpillByResult.get(result)
    : undefined;

/**
 * 读模型截断层落的真实全量；缺文件 → null（走老 persistTruncatedOutput 兜底）。
 * 其它读错也当 null（UI 降级展示截断版，不挡事件落盘）。
 */
export const readSpilledModelOutput = async (
  taskId: string,
  callId: string,
): Promise<string | null> => {
  try {
    return await fs.readFile(
      path.join(taskDir(taskId), toolOutputRelPath(callId)),
      "utf-8",
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn(
        `[tool-result] 读模型全量落盘失败 task=${taskId} callId=${callId}`,
        err,
      );
    }
    return null;
  }
};

/** 超限时写全量到 tool-outputs/；返回截断后的 output + 标记 */
export const persistTruncatedOutput = async (
  taskId: string,
  callId: string,
  full: string,
  limit: number = TOOL_RESULT_OUTPUT_LIMIT,
  /** 预览取法：shell 传 "head-tail"（报错常在尾部），其余默认只取头部 */
  mode: OutputPreviewMode = "head",
): Promise<{ output: string; truncated?: boolean; fullPath?: string }> => {
  if (utf8ByteLength(full) <= limit) return { output: full };
  const rel = toolOutputRelPath(callId);
  const abs = path.join(taskDir(taskId), rel);
  try {
    await writeToolOutputAtomic(abs, full);
    // 写入后 best-effort 清旧文件（超 200 / 50MB）
    void pruneToolOutputsDir(taskId);
  } catch (err) {
    console.warn(
      `[tool-result] 落全量输出失败 task=${taskId} callId=${callId}`,
      err,
    );
    // 写盘失败仍截断展示，但不带 fullPath——前端不应出「查看完整输出」（点开会 404）
    return {
      output: previewOutput(full, limit, mode),
      truncated: true,
    };
  }
  return {
    output: previewOutput(full, limit, mode),
    truncated: true,
    fullPath: rel,
  };
};

type InlineBuildArgs = {
  callId: string;
  /** SDK msg.name（可能是 mcp） */
  rawName: string;
  args?: unknown;
  result?: unknown;
  msgStatus: string;
};

type BuildArgs = InlineBuildArgs & {
  taskId: string;
};

/** SDK 原始工具名 → 归一化展示名（MCP → mcp:server:tool）；落盘版与内存版共用 */
const resolveResultToolName = (input: InlineBuildArgs): string => {
  const argsRec = asRecord(input.args) ?? {};
  return normalizeToolName({
    type: input.rawName,
    name: input.rawName,
    args: {
      providerIdentifier:
        typeof argsRec.providerIdentifier === "string"
          ? argsRec.providerIdentifier
          : undefined,
      toolName:
        typeof argsRec.toolName === "string" ? argsRec.toolName : undefined,
    },
  });
};

/**
 * 按绝对路径读落盘文件：只认「本次调用应有的那个文件」，对不上直接 null。
 * （映射 value 是我们自己写的，理论上恒对得上；这里是防呆——文件名只由
 * sanitize 后的 callId 决定，拼不出目录穿越。）
 */
const readSpillFileAbs = async (
  absPath: string,
  taskId: string,
  callId: string,
): Promise<string | null> => {
  if (absPath !== path.join(taskDir(taskId), toolOutputRelPath(callId))) {
    return null;
  }
  try {
    return await fs.readFile(absPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn(
        `[tool-result] 读模型全量落盘失败 task=${taskId} callId=${callId}`,
        err,
      );
    }
    return null;
  }
};

/** 落盘全文 → UI 用的 8KB 预览定稿（防御：文件理论上恒超 8KB，矮了就原样给） */
const previewOfSpilled = (
  spilled: string,
  callId: string,
  mode: OutputPreviewMode,
): { output: string; truncated?: boolean; fullPath?: string } => {
  if (utf8ByteLength(spilled) <= TOOL_RESULT_OUTPUT_LIMIT) {
    return { output: spilled };
  }
  return {
    output: previewOutput(spilled, TOOL_RESULT_OUTPUT_LIMIT, mode),
    truncated: true,
    fullPath: toolOutputRelPath(callId),
  };
};

/** 组装 tool_result meta（含截断落盘副作用） */
export const buildToolResultMeta = async (
  input: BuildArgs,
): Promise<ToolResultMeta> => {
  const name = resolveResultToolName(input);

  const status = resolveToolResultStatus(input.msgStatus, name, input.result);
  // 抽文本按 SDK 原始工具名（shell/read/edit…）；MCP 走 stringify 兜底
  const outputText = extractToolOutputText(input.rawName, input.result);
  // shell 预览取头 + 尾（报错常在尾部）；其余工具只取头部
  const mode = previewModeFor(input.rawName);
  // V2 fast path：同一引用直连落盘路径（P2-2）——8~64KB 频段（如 read 到的源码文件）
  // 不截断不落盘，老长度门每次都要 stat miss 一次；有映射直接读盘做预览。
  const knownSpill = modelSpillPathForResult(input.result);
  if (knownSpill !== undefined) {
    const spilled = await readSpillFileAbs(knownSpill, input.taskId, input.callId);
    if (spilled !== null) {
      return finishMeta(input, name, status, previewOfSpilled(spilled, input.callId, mode));
    }
    // 掉盘（被 prune/手删）→ 继续走下面老路兜底
  }
  // V2：模型截断层已把工具真实全量落盘（tool-outputs/<callId>.txt）→ UI 直接复用同一份
  // 全文做 8KB 预览，绝不覆盖（覆盖会把真实全量洗成 32KB 截断版）。落盘只发生在原文超
  // 32KB 时，此时 outputText（32KB+后缀）必超 8KB——小输出跳过这次 stat，省一次磁盘 IO。
  if (utf8ByteLength(outputText) > TOOL_RESULT_OUTPUT_LIMIT) {
    const spilled = await readSpilledModelOutput(input.taskId, input.callId);
    if (spilled !== null) {
      return finishMeta(input, name, status, previewOfSpilled(spilled, input.callId, mode));
    }
  }
  const persisted = await persistTruncatedOutput(
    input.taskId,
    input.callId,
    outputText,
    TOOL_RESULT_OUTPUT_LIMIT,
    mode,
  );
  return finishMeta(input, name, status, persisted);
};

/**
 * 组装 tool_result meta 的**纯内存版**：不落 `tool-outputs/` 全量文件、不读盘。
 *
 * 给子代理过程记录用（`subagent-transcript`）：子代理自己的工具调用不进主事件流，
 * 记录里只留 8KB 预览（超限截断并标 `truncated`、**不带 fullPath**——界面据此不出「加载完整输出」，
 * 点开必 404 的入口比没有更糟）。不落全量文件还有一层原因：`tool-outputs/` 有「最多 200 个 / 50MB」的
 * 淘汰（见 pruneToolOutputsDir），子代理动辄几十次读文件，会把主会话的全量输出挤掉。
 * 抽文本 / 判状态 / shell·edit·write 附加字段与落盘版同一套（共用 finishMeta）。
 */
export const buildInlineToolResultMeta = (
  input: InlineBuildArgs,
): ToolResultMeta => {
  const name = resolveResultToolName(input);
  const status = resolveToolResultStatus(input.msgStatus, name, input.result);
  const outputText = extractToolOutputText(input.rawName, input.result);
  const persisted =
    utf8ByteLength(outputText) > TOOL_RESULT_OUTPUT_LIMIT
      ? {
          output: previewOutput(
            outputText,
            TOOL_RESULT_OUTPUT_LIMIT,
            previewModeFor(input.rawName),
          ),
          truncated: true as const,
        }
      : { output: outputText };
  return finishMeta(input, name, status, persisted);
};

/** output 定稿后补 shell/edit/write 附加字段（V2 复用落盘与老 persist 共用） */
const finishMeta = (
  input: InlineBuildArgs,
  name: string,
  status: ToolResultStatus,
  persisted: { output: string; truncated?: boolean; fullPath?: string },
): ToolResultMeta => {
  const argsRec = asRecord(input.args) ?? {};
  const meta: ToolResultMeta = {
    callId: input.callId,
    name,
    status,
    output: persisted.output,
  };
  if (persisted.truncated) {
    meta.truncated = true;
    if (persisted.fullPath) meta.fullPath = persisted.fullPath;
  }

  const env = asRecord(input.result) as ResultEnvelope | null;
  const value = env?.value;

  // shell 附加字段
  if (input.rawName === "shell" && value) {
    if (typeof value.exitCode === "number") meta.exitCode = value.exitCode;
    if (typeof value.executionTime === "number") {
      meta.executionTime = value.executionTime;
    }
  }

  // edit / write：filePath + diff（有 SDK diffString 才带；不自己盘上 diff）
  if (input.rawName === "edit" || input.rawName === "write") {
    const pathFromArgs =
      (typeof argsRec.path === "string" && argsRec.path) ||
      (typeof argsRec.target_file === "string" && argsRec.target_file) ||
      (typeof argsRec.file_path === "string" && argsRec.file_path) ||
      undefined;
    const pathFromValue =
      value && typeof value.path === "string" ? value.path : undefined;
    const filePath = pathFromArgs || pathFromValue;
    if (filePath) meta.filePath = filePath;

    if (input.rawName === "edit") {
      // Cursor：value.diffString；pi（自定义提供方）：没有 status/value 信封，
      // unified diff 在 details.patch（details.diff 是带行号的展示串，不是 unified、前端渲染会错位）（V4-02）
      const piPatch = asRecord(env?.details)?.patch;
      const diffStr =
        value && typeof value.diffString === "string"
          ? value.diffString
          : typeof piPatch === "string"
            ? piPatch
            : undefined;
      if (diffStr) {
        if (utf8ByteLength(diffStr) > TOOL_RESULT_DIFF_LIMIT) {
          meta.diff = truncateToLimit(diffStr, TOOL_RESULT_DIFF_LIMIT);
          meta.diffTruncated = true;
        } else {
          meta.diff = diffStr;
        }
      }
    }
  }

  return meta;
};
