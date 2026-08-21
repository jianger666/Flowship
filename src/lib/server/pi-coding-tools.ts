/**
 * pi 后端的「规范编码工具」适配层（把 pi 原生工具名收敛到 cursor 的规范名）
 *
 * 规范工具面（prompt 里写死的、cursor / pi / 未来 cc/codex 都对齐）：
 *   read / grep / glob / shell / edit / write / delete / task
 *
 * pi 原生是 read / bash / edit / write / grep / find / ls，其中：
 *   - read / grep / edit / write 名字一致、直接走 pi 原生（在 createAgentSession.tools 里留）
 *   - bash → shell、find → glob：这里包成 customTools 重命名（排除 pi 原生的 bash/find）
 *   - delete：pi 没有、这里补一个（node fs.rm）
 *   - task（子 agent 分派）：pi 无子 agent，在 custom-agent-backend.ts 里用进程内嵌套会话实现
 *
 * 参数形状：prompt / artifact-writer 按 Cursor 写死（fileText / globPattern / oldText 顶层）。
 * pi 校验在 execute 之前、多余字段会炸。所以 prepareArguments 把 Cursor 别名收成
 * pi 规范字段再交给原生 execute（customTools 同名会盖掉 builtin）。
 */

import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { glob } from "glob";
import {
  Number as TBNumber,
  Object as TBObject,
  Optional as TBOptional,
  String as TBString,
} from "typebox/type";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const execAsync = promisify(exec);

const asTool = (d: unknown): ToolDefinition => d as ToolDefinition;

const DEFAULT_SHELL_TIMEOUT_MS = 60_000;
const MIN_SHELL_TIMEOUT_MS = 5_000;
const MAX_SHELL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Node `exec` 的 timeout 是毫秒。模型（Cursor / Claude 习惯）经常传秒：15、30、60。
 * 真实踩坑：模型传 timeout:15 → 被当成 15ms → curl 立刻被杀 → 模型误判「这台机器不能出网」。
 * 未传 → 60s；<1000 当秒；≥1000 当毫秒；再夹到 5s~10min。
 */
export const resolveShellTimeoutMs = (raw: unknown): number => {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_SHELL_TIMEOUT_MS;
  }
  const asMs = raw < 1000 ? raw * 1000 : raw;
  return Math.min(MAX_SHELL_TIMEOUT_MS, Math.max(MIN_SHELL_TIMEOUT_MS, asMs));
};

/** 超时被杀时把「不是断网」说清楚，避免模型把 15ms kill 编成环境隔离。 */
export const formatShellFailureText = (opts: {
  timeoutMs: number;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
  message?: string;
}): string => {
  const out = [opts.stdout, opts.stderr].filter(Boolean).join("\n");
  if (opts.killed) {
    const hint = `命令超时被终止（${opts.timeoutMs}ms）。shell 跑在本机、可以访问外网；请加大 timeout（单位秒）后重试。`;
    return out ? `${hint}\n${out}` : hint;
  }
  return out || opts.message || "命令执行失败";
};

// ----------------- Cursor 参数别名 → pi 规范字段 -----------------
// prompt 教 fileText / globPattern；pi schema 要 content / pattern。校验在 execute 前，
// 别名必须先收成规范名、再删掉多余键，否则 TypeBox additionalProperties 会拒。

const PATH_ALIASES = ["file_path", "target_file", "filePath"] as const;
const CONTENT_ALIASES = ["fileText", "file_text", "contents"] as const;
const GLOB_PATTERN_ALIASES = ["globPattern", "glob_pattern"] as const;
const DIR_ALIASES = ["targetDirectory", "target_directory"] as const;
const WORKING_DIR_ALIASES = ["working_directory", "cwd"] as const;

const asArgsRecord = (input: unknown): Record<string, unknown> | null =>
  input !== null && typeof input === "object" && !Array.isArray(input)
    ? { ...(input as Record<string, unknown>) }
    : null;

const firstString = (
  obj: Record<string, unknown>,
  keys: readonly string[],
): string | undefined => {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") return v;
  }
  return undefined;
};

const stripKeys = (obj: Record<string, unknown>, keys: readonly string[]): void => {
  for (const k of keys) delete obj[k];
};

/** 规范字段缺了才用别名填；规范字段已在就保留（含空串）。 */
const fillStringIfMissing = (
  obj: Record<string, unknown>,
  canonical: string,
  aliases: readonly string[],
): void => {
  if (typeof obj[canonical] === "string") return;
  const alt = firstString(obj, aliases);
  if (alt !== undefined) obj[canonical] = alt;
};

export const prepareWriteArgs = (input: unknown): unknown => {
  const a = asArgsRecord(input);
  if (!a) return input;
  fillStringIfMissing(a, "content", CONTENT_ALIASES);
  fillStringIfMissing(a, "path", PATH_ALIASES);
  stripKeys(a, [...CONTENT_ALIASES, ...PATH_ALIASES]);
  return a;
};

export const prepareReadArgs = (input: unknown): unknown => {
  const a = asArgsRecord(input);
  if (!a) return input;
  fillStringIfMissing(a, "path", PATH_ALIASES);
  stripKeys(a, PATH_ALIASES);
  return a;
};

/** 路径别名；顶层 oldText/newText → edits[] 交给原生 edit.prepareArguments */
export const prepareEditPathArgs = (input: unknown): unknown => {
  const a = asArgsRecord(input);
  if (!a) return input;
  fillStringIfMissing(a, "path", PATH_ALIASES);
  stripKeys(a, PATH_ALIASES);
  return a;
};

export const prepareGlobArgs = (input: unknown): unknown => {
  const a = asArgsRecord(input);
  if (!a) return input;
  fillStringIfMissing(a, "pattern", GLOB_PATTERN_ALIASES);
  fillStringIfMissing(a, "path", DIR_ALIASES);
  stripKeys(a, [...GLOB_PATTERN_ALIASES, ...DIR_ALIASES]);
  return a;
};

export const prepareShellArgs = (input: unknown): unknown => {
  const a = asArgsRecord(input);
  if (!a) return input;
  fillStringIfMissing(a, "workingDirectory", WORKING_DIR_ALIASES);
  stripKeys(a, WORKING_DIR_ALIASES);
  return a;
};

const withPrepare = (
  def: unknown,
  prepare: (input: unknown) => unknown,
): ToolDefinition => {
  const d = asTool(def);
  const prev = d.prepareArguments;
  return asTool({
    ...d,
    prepareArguments: (input: unknown) => {
      const first = prepare(input);
      return prev ? prev(first) : first;
    },
  });
};

/** 盖掉 pi 原生 write/edit/read：同名 customTools 后注册胜出 */
export const buildNativeToolAliasWrappers = (cwd: string): ToolDefinition[] => [
  withPrepare(createWriteToolDefinition(cwd), prepareWriteArgs),
  withPrepare(createEditToolDefinition(cwd), prepareEditPathArgs),
  withPrepare(createReadToolDefinition(cwd), prepareReadArgs),
];

// ----------------- shell（= pi 的 bash） -----------------

const shellTool = (cwd: string): ToolDefinition =>
  asTool({
    name: "shell",
    label: "跑命令",
    description:
      "在任务工作目录运行一条 shell 命令，返回 stdout / stderr 与退出码。命令在本机执行、可以访问外网（curl / wget / npm 等）。timeout 为秒，默认 60；大于等于 1000 的值按毫秒理解。",
    parameters: TBObject({
      command: TBString(),
      timeout: TBOptional(TBNumber()),
      workingDirectory: TBOptional(TBString()),
    }),
    prepareArguments: prepareShellArgs,
    execute: async (_toolCallId: string, params: unknown) => {
      const p = params as {
        command?: unknown;
        timeout?: unknown;
        workingDirectory?: unknown;
      };
      const command = typeof p.command === "string" ? p.command : "";
      const timeout = resolveShellTimeoutMs(p.timeout);
      const workCwdRaw =
        typeof p.workingDirectory === "string" ? p.workingDirectory.trim() : "";
      const workCwd = workCwdRaw
        ? path.isAbsolute(workCwdRaw)
          ? workCwdRaw
          : path.resolve(cwd, workCwdRaw)
        : cwd;
      if (!command.trim()) {
        return {
          content: [{ type: "text", text: "command 不能为空" }],
          details: { exitCode: 1 },
        };
      }
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: workCwd,
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
        });
        const out = [stdout, stderr].filter(Boolean).join("\n");
        return {
          content: [{ type: "text", text: out || "(无输出)" }],
          details: { exitCode: 0 },
        };
      } catch (err) {
        const e = err as {
          stdout?: string;
          stderr?: string;
          code?: number;
          killed?: boolean;
          message?: string;
        };
        return {
          content: [
            {
              type: "text",
              text: formatShellFailureText({
                timeoutMs: timeout,
                killed: e.killed === true,
                stdout: e.stdout,
                stderr: e.stderr,
                message: e.message,
              }),
            },
          ],
          details: { exitCode: typeof e.code === "number" ? e.code : 1 },
        };
      }
    },
  });

// ----------------- glob（= pi 的 find） -----------------

const globTool = (cwd: string): ToolDefinition =>
  asTool({
    name: "glob",
    label: "找文件名",
    description:
      "按 glob 模式（支持 ** 与 *）在任务工作目录下找匹配的文件路径、返回相对路径列表（最多 500 条）。",
    parameters: TBObject({
      pattern: TBString(),
      path: TBOptional(TBString()),
    }),
    prepareArguments: prepareGlobArgs,
    execute: async (_toolCallId: string, params: unknown) => {
      const p = params as { pattern?: unknown; path?: unknown };
      const pattern = typeof p.pattern === "string" ? p.pattern.trim() : "";
      if (!pattern) {
        return {
          content: [{ type: "text", text: "pattern 不能为空" }],
          details: undefined,
        };
      }
      const base =
        typeof p.path === "string" && p.path.trim()
          ? path.resolve(cwd, p.path.trim())
          : cwd;
      try {
        const files = await glob(pattern, { cwd: base, absolute: false, nodir: true });
        const list = files.slice(0, 500);
        return {
          content: [
            {
              type: "text",
              text: list.length ? list.join("\n") : "(无匹配文件)",
            },
          ],
          details: { count: list.length },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `glob 失败：${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: undefined,
        };
      }
    },
  });

// ----------------- task（子 agent 分派、进程内嵌套会话） -----------------

const taskTool = (runSubagent: (prompt: string) => Promise<string>): ToolDefinition =>
  asTool({
    name: "task",
    label: "分派子任务",
    description:
      "把一段独立子任务交给一个全新的子 agent 完成、返回其最终结果。用于把大任务拆小、隔离上下文。",
    parameters: TBObject({
      prompt: TBString(),
      description: TBOptional(TBString()),
      subagentType: TBOptional(TBString()),
      model: TBOptional(TBString()),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      const p = params as { prompt?: unknown };
      const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
      if (!prompt) {
        return {
          content: [{ type: "text", text: "task 的 prompt 不能为空" }],
          details: undefined,
        };
      }
      try {
        const out = await runSubagent(prompt);
        return {
          content: [{ type: "text", text: out || "(子任务无输出)" }],
          details: undefined,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `子任务失败：${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: undefined,
        };
      }
    },
  });

// ----------------- delete（pi 无、补一个） -----------------

const deleteTool = (cwd: string): ToolDefinition =>
  asTool({
    name: "delete",
    label: "删文件 / 目录",
    description:
      "删除任务工作目录下的文件或目录（相对路径基于 cwd、也接受绝对路径）。删除不可逆、谨慎使用。",
    parameters: TBObject({ path: TBString() }),
    prepareArguments: prepareReadArgs,
    execute: async (_toolCallId: string, params: unknown) => {
      const p = params as { path?: unknown };
      const target = typeof p.path === "string" ? p.path.trim() : "";
      if (!target) {
        return {
          content: [{ type: "text", text: "path 不能为空" }],
          details: undefined,
        };
      }
      const abs = path.isAbsolute(target) ? target : path.resolve(cwd, target);
      try {
        await fs.rm(abs, { recursive: true, force: false });
        return {
          content: [{ type: "text", text: `已删除 ${target}` }],
          details: undefined,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `删除失败：${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: undefined,
        };
      }
    },
  });

/**
 * pi 后端的规范编码工具（shell / glob / delete / task + 盖掉原生 write/edit/read 的别名包装）。
 * grep 形状跟 prompt 一致、仍走 pi 原生。task 子 agent 靠传入的 runSubagent 回调。
 */
export const buildCodingToolDefs = (
  cwd: string,
  runSubagent: (prompt: string) => Promise<string>,
): ToolDefinition[] => [
  shellTool(cwd),
  globTool(cwd),
  deleteTool(cwd),
  taskTool(runSubagent),
  ...buildNativeToolAliasWrappers(cwd),
];

/** 供 subagent 提示 / 其它处复用：规范编码工具名清单（含原生同名 + 这里补的） */
export const CANONICAL_CODING_TOOL_NAMES = [
  "read",
  "grep",
  "glob",
  "shell",
  "edit",
  "write",
  "delete",
  "task",
] as const;
