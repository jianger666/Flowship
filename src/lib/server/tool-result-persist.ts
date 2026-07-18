/**
 * 工具完成结果 → tool_result 事件 meta（Phase 1「看得见」）
 *
 * - output 上限 8KB；超限截断并落全量到 tool-outputs/<callId>.txt
 * - edit/write 额外带 filePath + diff（diff 上限 16KB；无 SDK diff 则只摘要）
 * - shell 额外带 exitCode / executionTime
 */

import { promises as fs } from "node:fs";
import path from "node:path";

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

export type ToolResultStatus = "success" | "error";

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
  /** edit：SDK diffString（unified）；write 通常无此字段 */
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
};

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;

/** 从 SDK tool_call result 抽可读输出文本 */
export const extractToolOutputText = (
  toolName: string,
  result: unknown,
): string => {
  if (result == null) return "";
  if (typeof result === "string") return result;

  const env = asRecord(result) as ResultEnvelope | null;
  if (!env) return stringifyMeta(result);

  if (env.status === "error") {
    return stringifyMeta(env.error ?? result);
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

/** 判定 tool_result status（对齐 run-perf：MCP isError 当 error） */
export const resolveToolResultStatus = (
  msgStatus: string,
  toolName: string,
  result: unknown,
): ToolResultStatus => {
  if (msgStatus === "error") return "error";
  const env = asRecord(result) as ResultEnvelope | null;
  if (env?.status === "error") return "error";
  if (
    toolName.startsWith("mcp:") &&
    env?.value &&
    env.value.isError === true
  ) {
    return "error";
  }
  return "success";
};

/** 原子写 tool-outputs 全量文件（tmp + rename，与 writeMeta 同款） */
const writeToolOutputAtomic = async (
  absPath: string,
  full: string,
): Promise<void> => {
  await fs.mkdir(path.dirname(absPath), { recursive: true });
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

/** 超限时写全量到 tool-outputs/；返回截断后的 output + 标记 */
export const persistTruncatedOutput = async (
  taskId: string,
  callId: string,
  full: string,
  limit: number = TOOL_RESULT_OUTPUT_LIMIT,
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
      output: truncateToLimit(full, limit),
      truncated: true,
    };
  }
  return {
    output: truncateToLimit(full, limit),
    truncated: true,
    fullPath: rel,
  };
};

type BuildArgs = {
  taskId: string;
  callId: string;
  /** SDK msg.name（可能是 mcp） */
  rawName: string;
  args?: unknown;
  result?: unknown;
  msgStatus: string;
};

/** 组装 tool_result meta（含截断落盘副作用） */
export const buildToolResultMeta = async (
  input: BuildArgs,
): Promise<ToolResultMeta> => {
  const argsRec = asRecord(input.args) ?? {};
  const name = normalizeToolName({
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

  const status = resolveToolResultStatus(input.msgStatus, name, input.result);
  // 抽文本按 SDK 原始工具名（shell/read/edit…）；MCP 走 stringify 兜底
  const outputText = extractToolOutputText(input.rawName, input.result);
  const persisted = await persistTruncatedOutput(
    input.taskId,
    input.callId,
    outputText,
  );

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

    if (input.rawName === "edit" && value) {
      const diffStr =
        typeof value.diffString === "string" ? value.diffString : undefined;
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
