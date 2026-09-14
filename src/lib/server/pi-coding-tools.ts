/**
 * pi 后端的「规范编码工具」适配层（把 pi 原生工具名收敛到 cursor 的规范名）
 *
 * 规范工具面（prompt 里写死的、cursor / pi / 未来 cc/codex 都对齐）：
 *   read / grep / glob / shell / edit / write / delete / task
 *
 * pi 原生是 read / bash / edit / write / grep / find / ls，其中：
 *   - read / grep / edit / write 名字一致、用 pi 原生实现包一层同名 custom（只加输出预算
 *     withModelBudget、不改行数语义；在 createAgentSession.tools 里仍留名，custom 后注册胜出）
 *   - bash → shell、find → glob：这里包成 customTools 重命名（排除 pi 原生的 bash/find）。
 *     shell 的执行内核复用 pi 原生 createLocalBashOperations（detached spawn + 超时/取消
 *     killProcessTree 整树杀），本层只保留薄壳职责：改名、宿主环境变量清洗、超时语义收敛
 *   - delete：pi 没有、这里补一个（node fs.rm）
 *   - task（子 agent 分派）：pi 无子 agent，在 custom-agent-backend.ts 里用进程内嵌套会话实现
 *
 * 参数形状：prompt / artifact-writer 按 Cursor 写死（fileText / globPattern / oldText 顶层）。
 * pi 校验在 execute 之前、多余字段会炸。所以 prepareArguments 把 Cursor 别名收成
 * pi 规范字段再交给原生 execute（customTools 同名会盖掉 builtin）。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { glob } from "glob";
import { stripHostInjectedEnv } from "./host-env";
import { dataRoot } from "./data-root";
import { isAskWaitCommand } from "./ask-wait";
import {
  Number as TBNumber,
  Object as TBObject,
  Optional as TBOptional,
  String as TBString,
} from "typebox/type";
import {
  createEditToolDefinition,
  createGrepToolDefinition,
  createLocalBashOperations,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withModelBudget, type ModelBudgetSpill } from "./tool-output-budget";

const asTool = (d: unknown): ToolDefinition => d as ToolDefinition;

const DEFAULT_SHELL_TIMEOUT_MS = 60_000;
const MIN_SHELL_TIMEOUT_MS = 1_000;
const MAX_SHELL_TIMEOUT_MS = 10 * 60 * 1000;
/** ask-wait curl 要挂到用户答题，不能夹在 10 分钟上限里 */
export const ASK_WAIT_SHELL_TIMEOUT_MS = 86_400_000;

/**
 * Node `exec` 的 timeout 是毫秒。模型（Cursor / Claude 习惯）经常传秒：15、30、60。
 * 真实踩坑：模型传 timeout:15 → 被当成 15ms → curl 立刻被杀 → 模型误判「这台机器不能出网」。
 * 未传 → 60s；<1000 当秒；≥1000 当毫秒；再夹到 1s~10min。
 */
export const resolveShellTimeoutMs = (raw: unknown): number => {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_SHELL_TIMEOUT_MS;
  }
  const asMs = raw < 1000 ? raw * 1000 : raw;
  return Math.min(MAX_SHELL_TIMEOUT_MS, Math.max(MIN_SHELL_TIMEOUT_MS, asMs));
};

/** ask-wait 那条 curl 无视模型给的 120s，按 24h 挂 */
export const resolveShellTimeoutMsForCommand = (
  command: string,
  raw: unknown,
): number => {
  if (isAskWaitCommand(command)) return ASK_WAIT_SHELL_TIMEOUT_MS;
  return resolveShellTimeoutMs(raw);
};

/**
 * pi 原生本地 shell 执行后端（包级导出、给 extension 复用官方行为的口子）：
 * detached spawn + 超时/abort 时 killProcessTree 整树杀——比裸 exec 只杀 bash 包装进程强，
 * 长驻命令超时不再留孙进程孤儿。模块级单例即可（无会话状态）。
 */
const localBash = createLocalBashOperations();
/** 输出收集上限（对齐原 maxBuffer 10MB） */
const MAX_SHELL_OUTPUT_BYTES = 10 * 1024 * 1024;

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

/**
 * 盖掉 pi 原生 write/edit/read/grep：同名 customTools 后注册胜出。
 * grep 跟 prompt 形状一致（pattern/path/glob）、仍走 pi 原生实现（createGrepToolDefinition），
 * 加同名包装只为套输出预算（withModelBudget）——D1 之前 native grep 是 50KB 上限、这里再收紧到 32KB。
 * 每项都包 withModelBudget：进模型前截断，事件落盘链不动。
 * spill 有 taskId → 超预算全量落盘 + 后缀给路径（V2）；无 → V1 后缀。
 */
export const buildNativeToolAliasWrappers = (
  cwd: string,
  spill?: ModelBudgetSpill,
): ToolDefinition[] => [
  withModelBudget(withPrepare(createWriteToolDefinition(cwd), prepareWriteArgs), spill),
  withModelBudget(withPrepare(createEditToolDefinition(cwd), prepareEditPathArgs), spill),
  withModelBudget(withPrepare(createReadToolDefinition(cwd), prepareReadArgs), spill),
  withModelBudget(asTool(createGrepToolDefinition(cwd)), spill),
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
    execute: async (
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ) => {
      const p = params as {
        command?: unknown;
        timeout?: unknown;
        workingDirectory?: unknown;
      };
      const command = typeof p.command === "string" ? p.command : "";
      const timeout = resolveShellTimeoutMsForCommand(command, p.timeout);
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
      // 声明在 try 外：超时/abort 抛错后 catch 仍能把已产生的部分输出带回给模型排障
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        const { exitCode } = await localBash.exec(command, workCwd, {
          onData: (data) => {
            if (total >= MAX_SHELL_OUTPUT_BYTES) return;
            chunks.push(data);
            total += data.length;
          },
          // pi 原生 exec 的 timeout 单位是秒；timeout 已收敛为 ms
          timeout: timeout / 1000,
          // 对齐 VS Code getUnixShellEnvironment：宿主注入变量（ELECTRON_RUN_AS_NODE /
          // PORT / FLOWSHIP_DATA_DIR 等）不泄进 agent shell，否则用户命令启动 Electron
          // 二进制会静默秒退、next build 会报 generate is not a function（见 host-env.ts）
          env: stripHostInjectedEnv(),
          signal: signal ?? undefined,
        });
        const out = Buffer.concat(chunks).toString().trim();
        // 失败时把退出码显式写进文本：details 字段只有宿主能看，模型只看 content
        const exitNote = exitCode ? `\n（exit code ${exitCode}）` : "";
        return {
          content: [{ type: "text", text: (out || "(无输出)") + exitNote }],
          details: { exitCode: exitCode ?? -1 },
        };
      } catch (err) {
        // pi 原生内核的超时抛 Error("timeout:<秒>")、abort 抛 Error("aborted")，都算被杀
        const message = err instanceof Error ? err.message : String(err);
        const killed = message.startsWith("timeout:") || message === "aborted";
        return {
          content: [
            {
              type: "text",
              text: formatShellFailureText({
                timeoutMs: timeout,
                killed,
                stdout: Buffer.concat(chunks).toString(),
                message: killed ? undefined : message,
              }),
            },
          ],
          details: { exitCode: 1 },
        };
      }
    },
  });

/**
 * 旁路（群非属主答疑）只读守卫 —— 执行层门禁（review P0 的回归护栏）
 *
 * 背景：旁路 agent 跑的是群里非属主的一句话（不可信输入），用的却是任务属主的
 * 凭据和工作区。只靠提示词拦，模型一听话（或被注入 `忽略边界`）就会真写盘、
 * 真读走凭据文件。所以读类工具只做两件事：允许任务答疑必需的读，拒绝碰
 * 凭据、拒绝逃出工作区；拒绝时给一句话指引（走 pg-exec / 找任务所有者）。
 */

/** 旁路禁读：company-env.json（同名即拦，任意位置） */
const BYPASS_BLOCKED_BASENAMES = new Set(["company-env.json"]);

/** 解析后的绝对路径是否命中旁路禁读（纯函数、可单测） */
export const isBypassBlockedReadPath = (resolvedAbsPath: string): boolean => {
  const normalized = path.normalize(resolvedAbsPath);
  if (BYPASS_BLOCKED_BASENAMES.has(path.basename(normalized))) return true;
  // 数据目录根的 config.json（设置页落盘，含 provider key / git token 等）精确拦；
  // 工作区里的同名项目文件不受影响（钳制规则保证到不了数据目录）。
  return normalized === path.normalize(path.join(dataRoot(), "config.json"));
};

/** 搜索/读取基址钳制：只允许 cwd 或本任务数据目录内（纯函数、可单测） */
export const clampBypassBasePath = (
  cwd: string,
  raw: string,
  taskId?: string,
): { ok: true; abs: string } | { ok: false; reason: string } => {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === ".") return { ok: true, abs: path.normalize(cwd) };
  if (trimmed.startsWith("~")) {
    return { ok: false, reason: "旁路只读：路径只能是工作目录内的相对路径。" };
  }
  const abs = path.isAbsolute(trimmed)
    ? path.normalize(trimmed)
    : path.resolve(cwd, trimmed);
  const roots = [
    path.normalize(cwd),
    ...(taskId ? [path.normalize(path.join(dataRoot(), "tasks", taskId))] : []),
  ];
  const inside = roots.some((r) => abs === r || abs.startsWith(r + path.sep));
  if (!inside) {
    return {
      ok: false,
      reason: `旁路只读：只能看工作目录${taskId ? "或本任务目录" : ""}内的东西（${trimmed} 越界）。`,
    };
  }
  return { ok: true, abs };
};

const BYPASS_GUARD_HINT =
  "需要查数走只读 shell 的 pg-exec（只允许 SELECT），特殊用法找任务所有者。";

/** 从已归一化参数里取第一个字符串字段 */
const firstParamString = (params: unknown, keys: readonly string[]): string | undefined => {
  const obj = params as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") return v;
  }
  return undefined;
};

/** read 守卫：凭据文件拦 + 目录钳制（只放 cwd / 本任务目录；事件日志和产出都在里面） */
export const checkBypassRead =
  (cwd: string, taskId?: string) =>
  (params: unknown): string | null => {
    const raw = firstParamString(params, ["path", "file_path", "target_file", "filePath"]);
    if (!raw || !raw.trim()) return "path 不能为空";
    if (raw.trim().startsWith("~")) {
      return "旁路只读：路径只能是工作目录或本任务目录内的相对路径。";
    }
    const abs = path.isAbsolute(raw.trim())
      ? path.normalize(raw.trim())
      : path.resolve(cwd, raw.trim());
    if (isBypassBlockedReadPath(abs)) {
      return `旁路只读：company-env.json / config.json 凭据文件不允许读。${BYPASS_GUARD_HINT}`;
    }
    const clamped = clampBypassBasePath(cwd, abs, taskId);
    if (!clamped.ok) return clamped.reason;
    return null;
  };

/** grep / glob 基址守卫：钳制 + 凭据文件拦 */
export const checkBypassSearchBase =
  (cwd: string, taskId?: string) =>
  (params: unknown): string | null => {
    const raw = firstParamString(params, ["path", "targetDirectory", "target_directory"]);
    if (raw === undefined || !raw.trim()) return null;
    const clamped = clampBypassBasePath(cwd, raw, taskId);
    if (!clamped.ok) return clamped.reason;
    if (isBypassBlockedReadPath(clamped.abs)) {
      return `旁路只读：凭据文件不在搜索范围内。${BYPASS_GUARD_HINT}`;
    }
    return null;
  };

/** 给 ToolDefinition 套一层前置拒绝（不碰原实现，owner 链路零影响） */
const withBypassGuard = (
  def: ToolDefinition,
  check: (params: unknown) => string | null,
): ToolDefinition => {
  const prev = (
    def as unknown as { execute: (...args: unknown[]) => Promise<unknown> }
  ).execute.bind(def);
  return asTool({
    ...(def as unknown as Record<string, unknown>),
    execute: async (...args: unknown[]) => {
      const reason = check(args[1]);
      if (reason) {
        return { content: [{ type: "text", text: reason }], details: undefined };
      }
      return prev(...args);
    },
  });
};

// ----------------- 只读 shell（旁路专用） -----------------

/** 只读 shell 允许的本地查看命令（单条、无拼接；文件参数另做钳制） */
const READONLY_SAFE_BINS = new Set([
  "ls",
  "pwd",
  "cat",
  "tail",
  "head",
  "grep",
  "wc",
  "echo",
]);

/**
 * 旁路 git 只读动词：答疑看改动、看分支用。不碰工作树、不碰远端。
 * checkout/switch/push/pull/merge 等写操作不在表里、天然拒绝；
 * 线上分支相关（切/合/推 main、master、production 这类）以提示词为准、让模型找属主确认。
 */
const READONLY_GIT_VERBS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "rev-parse",
]);
/** git 逃逸 / 落盘 flag：一律拒绝（-C 换目录、--git-dir/--work-tree 指到仓外、--no-index 可读任意文件、--output 落盘写文件） */
const GIT_BANNED_FLAG_RE =
  /^(-C|--git-dir($|=)|--work-tree($|=)|--no-index($|=)|--output($|=))/;

/** pg-exec 脚本 token（node 后跟的脚本名，防 evil.js 等冒充） */
const PG_EXEC_TOKEN_RE = /(^|\s|["'])((?:\S*\/)?pg-exec\.mjs)(?=[\s"']|$)/;
/** 写 SQL 关键字（与 scripts/pg-exec.mjs 的 WRITE_RE 同口径，旁路实例是否只读都拦） */
const BYPASS_WRITE_SQL_RE =
  /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|CREATE|ALTER|GRANT|REVOKE|COPY|VACUUM|REINDEX|CLUSTER|REFRESH|CALL|DO|LOCK|COMMENT)\b/i;

const stripSqlComments = (sql: string): string =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

/**
 * 按 shell 引号规则切 token（单/双引号内整体保留、反斜杠转义）。
 * 引号未闭合返回 null（调用方直接拒绝）。只为找拼接符/重定向符，不做完整 shell 解析。
 */
export const splitShellTokens = (input: string): string[] | null => {
  const tokens: string[] = [];
  let cur = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      cur += ch;
      escaped = false;
      started = true;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch as "'" | '"';
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (started) {
        tokens.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (quote) return null;
  if (escaped) cur += "\\";
  if (started) tokens.push(cur);
  return tokens;
};

/** 引号感知扫描：未被单/双引号包裹的 target 字符（转义视为包裹内） */
export const hasUnquotedChars = (s: string, targets: ReadonlySet<string>): boolean => {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch as "'" | '"';
      continue;
    }
    if (targets.has(ch)) return true;
  }
  return false;
};
// 本地查看命令里不允许出现的未引用字符（& 覆盖 && 与后台 &，| 覆盖 || 与管道；
// \n \r 和 ; 等价必须拦；$ 不拦不行——shell 会先展开 $VAR，校验时看到的相对路径执行时指到工作区外）
const LOCAL_UNQUOTED_DENY = new Set([";", "&", "|", ">", "<", "`", "\n", "\r", "$"]);
// pg-exec 调用头（SQL 不在里面）：分号、换行、$ 都要拦
const HEAD_UNQUOTED_DENY = new Set([";", "&", "|", ">", "<", "`", "\n", "\r", "$"]);
// SQL 参数内：分号（语句结尾）与比较符放行，只拦后台/管道/反引号
const SQL_UNQUOTED_DENY = new Set(["&", "|", "`"]);
const hasSmuggledExecution = (s: string): boolean => s.includes("`") || s.includes("$(");

const READONLY_SHELL_DENY_SUFFIX =
  "旁路只读 shell 只允许：pg-exec 只读查询（SELECT）、ls/cat/tail/head/grep/wc/pwd/echo 本地查看（工作目录内）、git 只读查看（status/log/diff/show/branch/rev-parse）。改代码、跑脚本、调远程、发请求、动线上分支找任务所有者。";

export interface ReadonlyShellCheck {
  ok: boolean;
  reason?: string;
  workCwd?: string;
  timeoutMs?: number;
}

/**
 * 旁路只读 shell 校验（纯函数、可单测；默认拒绝）。
 * 允许：① pg-exec 只读查询；② 单条本地查看命令（文件参数钳在 cwd 内）；
 * ③ git 只读动词（status/log/diff/show/branch/rev-parse，看改动看分支）。
 * 其余一律拒绝并给跑法（ask-wait 刻意不放：子串匹配等于万能钥匙，见下）。
 */
export const validateReadonlyShellCommand = (
  cwd: string,
  command: unknown,
  workingDirectory: unknown,
  timeout: unknown,
): ReadonlyShellCheck => {
  const rawCmd = typeof command === "string" ? command.trim() : "";
  if (!rawCmd) return { ok: false, reason: "command 不能为空" };
  const timeoutMs = resolveShellTimeoutMsForCommand(rawCmd, timeout);
  // 工作目录钳在 cwd 内（绝对路径越界、~ 一律拒绝）
  const root = path.normalize(cwd);
  let workCwd = root;
  const workRaw = typeof workingDirectory === "string" ? workingDirectory.trim() : "";
  if (workRaw) {
    if (workRaw.startsWith("~")) {
      return { ok: false, reason: "旁路只读：workingDirectory 只能是工作目录内的相对路径。" };
    }
    const abs = path.isAbsolute(workRaw) ? path.normalize(workRaw) : path.resolve(cwd, workRaw);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return { ok: false, reason: "旁路只读：workingDirectory 只能在工作目录内。" };
    }
    workCwd = abs;
  }
  // 注意：旁路没有 ask_user，故意不放 ask-wait 白名单。isAskWaitCommand 只是子串匹配
  //（"/ask-wait?" + "token="），放行等于给任意命令开万能钥匙；owner 链路走全量 shell 不受影响。
  // ---- pg-exec 只读查询：node <…/>pg-exec.mjs [--env/--user/--database] -- 'SQL' ----
  if (PG_EXEC_TOKEN_RE.test(rawCmd)) {
    if (/(^|\s)--config(\s|=|$)/.test(rawCmd)) {
      return { ok: false, reason: "旁路只读：pg-exec 禁止 --config（用默认配置路径）；SQL 只允许 SELECT。" };
    }
    if (/ssh-exec\.mjs/.test(rawCmd)) {
      return { ok: false, reason: "旁路只读：远程 SSH 命令一律不跑，需要看服务端日志找任务所有者。" };
    }
    const sepMatch = /(^|\s)--(\s|$)/.exec(rawCmd);
    if (!sepMatch || sepMatch.index === undefined) {
      return {
        ok: false,
        reason:
          "旁路只读：pg-exec 的 SQL 必须放在 -- 后作单个带引号参数，如 node \"<pg-exec>\" --env <环境> -- 'SELECT ...'。",
      };
    }
    const head = rawCmd.slice(0, sepMatch.index);
    const sqlPartRaw = rawCmd.slice(sepMatch.index).replace(/(^|\s)--(\s|$)/, "");
    if (hasSmuggledExecution(rawCmd)) {
      return { ok: false, reason: "旁路只读：命令里不允许 `...` / $(...)。" };
    }
    if (hasUnquotedChars(head, HEAD_UNQUOTED_DENY) || head.includes("$(")) {
      return { ok: false, reason: "旁路只读：pg-exec 调用部分不允许拼接其他命令或重定向。" };
    }
    const headTokens = splitShellTokens(head);
    if (!headTokens) return { ok: false, reason: "旁路只读：命令引号未闭合。" };
    // 单横线（-h 等）也不放：pg-exec 只认 --env/--user/--database，横线开头的一律按 flag 查表
    const dashTokens = headTokens.filter((t) => t.startsWith("-"));
    if (
      dashTokens.some((t) => {
        const name = t.split("=")[0];
        return name !== "--env" && name !== "--user" && name !== "--database";
      })
    ) {
      return { ok: false, reason: "旁路只读：pg-exec 只允许 --env / --user / --database（禁止 --config 等）。" };
    }
    // SQL 必须独占一个带引号参数（防 `-- 'SELECT 1'; rm -rf /` 这类尾巴拼接），末尾分号允许
    const sqlArgMatch = /^\s*('([\s\S]*)'|"([\s\S]*)")\s*;?\s*$/.exec(sqlPartRaw);
    if (!sqlArgMatch) {
      return {
        ok: false,
        reason:
          "旁路只读：pg-exec 的 SQL 必须独占一个带引号参数，如 node \"<pg-exec>\" --env <环境> -- 'SELECT ...'（-- 后不许跟别的命令）。",
      };
    }
    const sql = (sqlArgMatch[2] ?? sqlArgMatch[3] ?? "").trim();
    if (!sql) return { ok: false, reason: "旁路只读：-- 后必须给 SQL。" };
    if (hasUnquotedChars(sqlPartRaw, SQL_UNQUOTED_DENY) || sqlPartRaw.includes("$(")) {
      return { ok: false, reason: "旁路只读：SQL 参数里不允许 &、|、`...` / $(...)。" };
    }
    if (BYPASS_WRITE_SQL_RE.test(stripSqlComments(sql))) {
      return { ok: false, reason: "旁路只读：查库只允许 SELECT（禁止 INSERT/UPDATE/DELETE/DDL）。" };
    }
    return { ok: true, workCwd, timeoutMs };
  }
  if (/ssh-exec\.mjs/.test(rawCmd)) {
    return { ok: false, reason: "旁路只读：远程 SSH 命令一律不跑，需要看服务端日志找任务所有者。" };
  }
  // ---- 本地安全查看命令（单条、无拼接、无重定向、无命令替换）----
  const tokens = splitShellTokens(rawCmd);
  if (!tokens) return { ok: false, reason: "旁路只读：命令引号未闭合。" };
  if (tokens.length === 0) return { ok: false, reason: "command 不能为空" };
  if (hasUnquotedChars(rawCmd, LOCAL_UNQUOTED_DENY) || rawCmd.includes("$(")) {
    return {
      ok: false,
      reason: `旁路只读：不允许拼接、管道、重定向、` + "`...` / $(...)。" + READONLY_SHELL_DENY_SUFFIX,
    };
  }
  const bin = path.basename(tokens[0] ?? "");
  // ---- git 只读查看：看改动、看分支；写操作不在动词表里、天然拒绝 ----
  if (bin === "git") {
    if (tokens.some((t) => GIT_BANNED_FLAG_RE.test(t))) {
      return {
        ok: false,
        reason:
          "旁路只读：git 禁止 -C / --git-dir / --work-tree / --no-index / --output（防目录逃逸、任意文件读取与落盘）。",
      };
    }
    const verb = tokens.slice(1).find((t) => t && !t.startsWith("-"));
    if (!verb || !READONLY_GIT_VERBS.has(verb)) {
      return {
        ok: false,
        reason: `旁路只读：git 只允许 ${[...READONLY_GIT_VERBS].join(" / ")}（只读查看）。改分支、推代码、动线上分支找任务所有者。`,
      };
    }
    return { ok: true, workCwd, timeoutMs };
  }
  if (!READONLY_SAFE_BINS.has(bin)) {
    return { ok: false, reason: `旁路只读：不允许跑 ${tokens[0] ?? ""}。${READONLY_SHELL_DENY_SUFFIX}` };
  }
  // 文件参数钳在 cwd 内 + 凭据文件拦（grep 的第一个非 flag 参数是 pattern，跳过它）
  const nonFlag = tokens.slice(1).filter((t) => t && !t.startsWith("-"));
  const pathArgs = bin === "grep" ? nonFlag.slice(1) : nonFlag;
  if ((bin === "cat" || bin === "tail" || bin === "head") && pathArgs.length === 0) {
    return { ok: false, reason: `旁路只读：${bin} 必须带工作目录内的文件参数。` };
  }
  if (bin === "grep" && nonFlag.length === 0) {
    return { ok: false, reason: "旁路只读：grep 必须带 pattern（文件参数只能在工作目录内）。" };
  }
  for (const arg of pathArgs) {
    if (arg.startsWith("~")) {
      return { ok: false, reason: "旁路只读：文件参数只能是工作目录内的相对路径。" };
    }
    // shell 会展开 $VAR / `...` / $(...)：引号包着也一样展开，文件参数里出现一律拒绝
    //（grep 的 pattern 已跳过，echo 不走这里，所以 "cost$" 这类 pattern 不受影响）
    if (arg.includes("$") || arg.includes("`") || arg.includes("$(")) {
      return { ok: false, reason: "旁路只读：文件参数里不允许 $环境变量 / `...` / $(...)。" };
    }
    const abs = path.isAbsolute(arg) ? path.normalize(arg) : path.resolve(cwd, arg);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return { ok: false, reason: `旁路只读：文件参数只能在工作目录内（${arg} 越界）。` };
    }
    if (isBypassBlockedReadPath(abs)) {
      return { ok: false, reason: `旁路只读：company-env.json 凭据文件不允许读。${BYPASS_GUARD_HINT}` };
    }
  }
  return { ok: true, workCwd, timeoutMs };
};

/** 旁路只读 shell：同名 "shell"（白名单不用改），先校验再交给全量实现 */
const readonlyShellTool = (cwd: string): ToolDefinition => {
  const full = shellTool(cwd);
  const fullExecute = (
    full as unknown as { execute: (...args: unknown[]) => Promise<unknown> }
  ).execute.bind(full);
  return asTool({
    ...(full as unknown as Record<string, unknown>),
    name: "shell",
    label: "跑命令（只读）",
    description:
      "旁路只读 shell：只允许 pg-exec 只读查询（SELECT），或 ls、cat、tail、head、grep、wc、pwd、echo 本地查看（工作目录内）。不允许拼接/管道/重定向，不允许改文件、跑构建、调远程、发请求。timeout 为秒，默认 60。",
    execute: async (...args: unknown[]) => {
      const params = (args[1] ?? {}) as {
        command?: unknown;
        timeout?: unknown;
        workingDirectory?: unknown;
      };
      const checked = validateReadonlyShellCommand(cwd, params.command, params.workingDirectory, params.timeout);
      if (!checked.ok) {
        return { content: [{ type: "text", text: checked.reason ?? READONLY_SHELL_DENY_SUFFIX }], details: { exitCode: 1 } };
      }
      // workingDirectory 已钳住：归一化后写回，全量实现不再二次发散
      return fullExecute(args[0], { ...(params as object), workingDirectory: checked.workCwd }, args[2], args[3], args[4]);
    },
  });
};

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
 * 只读轮次的 customTools：read（凭据文件守卫 + 目录钳制）/ grep·glob（基址钳制）+ 只读 shell（纯函数白名单校验）。
 * 只读 = 不推进、不改东西；查数据（pg-exec SELECT、读本地日志）是读操作，允许。
 * 写类（write/edit/delete）、子代理 task、系统工具、MCP 全不给；裸 shell 不给，只给校验版。
 * 白名单数组（custom-agent-backend 的 tools 白名单与这里保持一致）。
 */
export const READONLY_CUSTOM_TOOL_NAMES = [
  "read",
  "grep",
  "glob",
  "shell",
] as const;
export const buildReadOnlyToolDefs = (
  cwd: string,
  spill?: ModelBudgetSpill,
): ToolDefinition[] => {
  const taskId = spill?.taskId;
  const all = buildNativeToolAliasWrappers(cwd, spill);
  const read = all.find((d) => (d as { name?: unknown }).name === "read");
  const grep = all.find((d) => (d as { name?: unknown }).name === "grep");
  if (!read || !grep) throw new Error("buildReadOnlyToolDefs: 缺少 read/grep 原生包装");
  return [
    withModelBudget(withBypassGuard(read, checkBypassRead(cwd, taskId)), spill),
    withModelBudget(withBypassGuard(grep, checkBypassSearchBase(cwd, taskId)), spill),
    withModelBudget(withBypassGuard(globTool(cwd), checkBypassSearchBase(cwd, taskId)), spill),
    withModelBudget(readonlyShellTool(cwd), spill),
  ];
};

/**
 * pi 后端的规范编码工具（shell / glob / delete / task + 盖掉原生 write/edit/read/grep 的别名包装）。
 * task 子 agent 靠传入的 runSubagent 回调。自研的 shell/glob/delete/task 全包 withModelBudget
 *（shell 10MB 收集是真黑洞、task 子 agent 回包无上限）；别名包装里已包过、这里不再重包。
 */
export const buildCodingToolDefs = (
  cwd: string,
  runSubagent: (prompt: string) => Promise<string>,
  spill?: ModelBudgetSpill,
): ToolDefinition[] => [
  withModelBudget(shellTool(cwd), spill),
  withModelBudget(globTool(cwd), spill),
  withModelBudget(deleteTool(cwd), spill),
  withModelBudget(taskTool(runSubagent), spill),
  ...buildNativeToolAliasWrappers(cwd, spill),
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
