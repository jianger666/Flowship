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

import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import { glob } from "glob";
import { stripHostInjectedEnv } from "./host-env";
import { stripGitTokenEnv } from "./git-token-env";
import { dataRoot } from "./data-root";
import { isAskWaitCommand } from "./ask-wait";
import {
  Number as TBNumber,
  Object as TBObject,
  Optional as TBOptional,
  String as TBString,
} from "typebox/type";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createGrepToolDefinition,
  createLocalBashOperations,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  parseSubagentRequest,
  SUBAGENT_TOOL_DESCRIPTION,
  SubagentUsageError,
  type SubagentRequest,
} from "@/lib/subagent-spec";
import { withModelBudget, type ModelBudgetSpill } from "./tool-output-budget";
import { buildMergeTestMrTool } from "./bypass-merge-mr";

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

const shellTool = (
  cwd: string,
  opts: { omitGitToken?: boolean } = {},
): ToolDefinition =>
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
      // 宿主注入变量剔除后的 env。GitLab token 变量（FLOWSHIP_GITLAB_TOKEN）不在黑名单里、默认继承——
      // 属主的会话（task / chat / 属主 one-shot）靠它调 GitLab API（见 git-token-env.ts）。
      // 谁会摘掉（omitGitToken）——真实接线情况（N3-01）：
      //   - 需求群「非属主答疑旁路」（restricted-question.ts）：显式传 `omitGitToken: true`，
      //     经 agent-backend facade → custom-agent-backend → buildCodingToolDefs 传到这里；
      //     它的 `task` 子代理的 bash 另走 buildGitTokenFreeBashTool（同一规则，否则能绕）。
      //   - 判据是「显式标记」而不是「无 callerToken」：属主自己的 startOneShotQuestion 同样没有
      //     callerToken（没有交卷 / 提问身份），却是全权限的属主通道、不该被摘。
      // ⚠️ 只覆盖 pi provider：Cursor provider 的 shell 由 SDK 拉起、原样继承 server env，摘不掉
      // （见 git-token-env.ts 头部）。这里**只摘环境变量、不阻止读文件**：pi 的 `read` / shell 照样能读
      // config.json（M1-02）/ ~/.ssh——只是收掉最显眼的一条路，不是边界。
      const baseEnv = stripHostInjectedEnv();
      const shellEnv = opts.omitGitToken ? stripGitTokenEnv(baseEnv) : baseEnv;
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
          env: shellEnv,
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
 * 凭据、拒绝逃出工作区；拒绝时给一句话指引（找任务所有者）。
 */

/** 旁路禁读：company-env.json（同名即拦，任意位置） */
const BYPASS_BLOCKED_BASENAMES = new Set(["company-env.json"]);

/**
 * 这两个平台的默认文件系统大小写不敏感（APFS / NTFS 默认配置）：`CONFIG.JSON` 与 `config.json` 是同一个文件。
 * 只对它们做词法 casefold；linux 保持大小写敏感（那里 `CONFIG.JSON` 是另一个文件，不该连坐）。
 * 代价：darwin 上用了「大小写敏感」卷的人，`CONFIG.JSON` 这种别的文件会被多拦——偏严、不漏。
 */
const foldsPathCase = (platform: NodeJS.Platform): boolean => platform === "darwin" || platform === "win32";

/**
 * 数据目录根里**固定文件名**的受保护文件（只用于 dev+ino 比对）。
 * `config.json.corrupt-<ts>` / `.tmp.*` 没有固定名字，要 readdir 才能枚举，不值得放进每次工具调用的路径——它们的硬链接不在此列（残余）。
 */
const BYPASS_PROTECTED_DATA_FILES = [
  "company-env.json",
  "config.json",
  "config.json.bak",
  "config.json.bak.shrink",
] as const;

/**
 * 已存在的路径是否与某个受保护文件是同一个文件（dev + ino 相同；stat 跟随符号链接）。
 * 补的是词法判断看不到的变体：硬链接 / 符号链接换了个名字、大小写不敏感文件系统上词法 casefold 没覆盖到的写法。
 * IO 约束：调用方（read / grep / glob 守卫、shell 的路径参数）都是同步的，这里与 `probeShellPath` 同样用 `statSync`；
 * 词法已命中的不会走到这里；只有「已存在的普通文件」才会多 stat 至多 4 次（目录、不存在的路径一次 stat 就返回）。
 * 任何 stat 失败（不存在 / ENOTDIR / 名字过长 / 含 NUL / 无权限）都安静回退成 false——这里只是在词法之外多一道，不是唯一一道，不能抛。
 * 残余：设置保存是「写临时文件再 rename 覆盖」，`config.json` 的 inode 每次保存都变，保存之前做的硬链接指向旧 inode、认不出；
 * 竞态（检查之后链接才被造出来）在纯校验里消除不了——旁路没有写工具，造链接得靠工作区里本来就有的东西。
 */
const isProtectedDataFileByInode = (p: string): boolean => {
  try {
    const st = statSync(p, { bigint: true, throwIfNoEntry: false });
    // ino 为 0 的文件系统（部分网络 / 虚拟盘）上 dev+ino 不可信，宁可不比，别让所有文件互相「相同」
    if (!st || !st.isFile() || st.ino === 0n) return false;
    const dir = path.resolve(dataRoot());
    for (const name of BYPASS_PROTECTED_DATA_FILES) {
      const ref = statSync(path.join(dir, name), { bigint: true, throwIfNoEntry: false });
      if (ref && ref.ino === st.ino && ref.dev === st.dev) return true;
    }
  } catch {
    // 回退到词法判断的结果（调用方已经在词法上判过一遍，这里没命中）
  }
  return false;
};

/**
 * 解析后的绝对路径是否命中旁路禁读（可单测；`platform` 可注入，默认 `process.platform`）。
 * 两层（K3-07）：① 词法——文件名 / 数据目录根里的 config.json 族，darwin / win32 下文件名与目录两侧 casefold
 * （`CONFIG_FILE_FAMILY_RE` 全是小写字面量，所以拿 casefold 之后的文件名去匹配即可）；② 已存在的路径再比 dev+ino。
 * ① 是纯函数；② 会 stat（同步），失败安静回退。
 */
export const isBypassBlockedReadPath = (
  resolvedAbsPath: string,
  platform: NodeJS.Platform = process.platform,
): boolean => {
  const normalized = path.normalize(resolvedAbsPath);
  const fold = foldsPathCase(platform) ? (s: string) => s.toLowerCase() : (s: string) => s;
  const base = fold(path.basename(normalized));
  if (BYPASS_BLOCKED_BASENAMES.has(base)) return true;
  // 数据目录根的 config.json（设置页落盘，含 provider key / git token 等）精确拦；
  // 它的备份 / 中间产物同样含明文凭据，一并拦（见 CONFIG_FILE_FAMILY_RE）。
  // 工作区里的同名项目文件不受影响（钳制规则保证到不了数据目录）。
  // 目录比较两侧都 `path.resolve`：`FLOWSHIP_DATA_DIR` 带尾斜杠 / 含 `..` 段时 `path.normalize` 会留下尾斜杠，
  // 与 `path.dirname(文件)`（永远没有尾斜杠）对不上，整个守卫就悄悄失灵。
  if (
    fold(path.dirname(path.resolve(normalized))) === fold(path.resolve(dataRoot())) &&
    CONFIG_FILE_FAMILY_RE.test(base)
  ) {
    return true;
  }
  return isProtectedDataFileByInode(normalized);
};

/**
 * config.json 及其衍生文件名（只在数据目录根里匹配）：
 * - `config.json.bak`：设置 PUT 覆盖前的上一版（里面是**已轮换掉的旧 key**）
 * - `config.json.bak.shrink`：「收缩写」之前的原子备份（见 settings-fs），同样是旧版完整配置
 * - `config.json.corrupt-<ts>`：读到损坏 JSON 时留的原文备份
 * - 以上任一 + `.tmp.<pid>.<rand>`：`writePrivateFileAtomic` 的临时文件（崩溃残留里也是明文）
 */
const CONFIG_FILE_FAMILY_RE =
  /^config\.json(?:\.(?:bak(?:\.shrink)?|corrupt-\d+))?(?:\.tmp\..+)?$/;

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
  "特殊用法找任务所有者。";

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

/**
 * 子 agent 执行回调：入参已解析好（prompt / 类型 / 原始 model / effort），
 * signal 是父工具调用的取消信号（父会话被停时中止子会话）。
 * 用法错误（model / effort 无效）抛 SubagentUsageError，其它异常算子会话失败。
 */
export type SubagentRunner = (
  request: SubagentRequest,
  signal: AbortSignal | undefined,
  /** toolCallId = 父会话里这次 `task` 调用的 callId（子代理过程记录据此绑到事件流卡片） */
  ctx?: { toolCallId?: string },
) => Promise<string>;

/** 描述文案与 Cursor 的 `subagent` 共用（subagent-spec），两边行为一致 */
export const TASK_TOOL_DESCRIPTION = SUBAGENT_TOOL_DESCRIPTION;

const taskTool = (runSubagent: SubagentRunner): ToolDefinition =>
  asTool({
    name: "task",
    label: "分派子任务",
    description: TASK_TOOL_DESCRIPTION,
    parameters: TBObject({
      prompt: TBString(),
      description: TBOptional(TBString()),
      subagentType: TBOptional(TBString()),
      model: TBOptional(TBString()),
      effort: TBOptional(TBString()),
    }),
    execute: async (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ) => {
      const parsed = parseSubagentRequest(params);
      // 抛错 = pi 标成工具错误（isError）、message 原样回给模型；
      // 之前这里把错误当普通文本返回、界面上显示「成功」
      if (!parsed.ok) throw new SubagentUsageError(parsed.error);
      // resume 只有 Cursor 路径的 `subagent` 支持（pi 的子会话是一次性内存会话，跑完即弃、没有可接的）。
      // 模型从 Cursor 那边的习惯带过来传了也别静默当成新任务跑——明说不支持，让它自己把背景写进 prompt
      if (parsed.request.resume) {
        throw new SubagentUsageError(
          "当前环境的 task 不支持 resume（子任务是一次性的）；去掉 resume，把需要的背景写进 prompt 另起一个新的子任务。",
        );
      }
      // 同理：后台运行也只有 Cursor 路径的 chat 会话支持（pi 的子任务在工具调用里同步跑完）
      if (parsed.request.runInBackground) {
        throw new SubagentUsageError(
          "当前环境的 task 不支持 run_in_background（子任务在这次调用里同步跑完）；去掉 run_in_background，直接等它返回结果。",
        );
      }
      let out: string;
      try {
        out = await runSubagent(parsed.request, signal, { toolCallId });
      } catch (err) {
        if (err instanceof SubagentUsageError) throw err;
        throw new Error(
          `子任务失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return {
        content: [{ type: "text", text: out || "(子任务无输出)" }],
        details: undefined,
      };
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
 * 只读轮次的 customTools：read（凭据文件守卫 + 目录钳制）/ grep·glob（基址钳制）+ merge_test_mr
 *（服务端执行、只合 test 分支）。不推进、不改文件。
 * 写类（write/edit/delete）、子代理 task、系统工具、MCP、shell 全不给。
 * 白名单数组（custom-agent-backend 的 tools 白名单与这里保持一致）。
 * 注：旁路 honor-system 后不再走本数组（两端默认全开），此处转单元覆盖留着，哪天收紧直接接回去。
 *
 * ⚠ 只读 shell（`readonlyShellTool` + `validateReadonlyShellCommand` 那套约 1700 行白名单守卫）已在 v1.9.33 删除：
 * 它没有调用方（没人传 `readOnly: true`），原定期限到了、不再顺延。最后一版带它的是 tag `v1.9.32`
 *（`git show v1.9.32:src/lib/server/pi-coding-tools.ts`）。要给只读轮次重新加 shell，先读 docs/HANDOFF.md
 * 「只读 shell 守卫整段删除」一节的「接线前必做清单」（路径操作数 realpath 再钳、git 外部程序选项拒绝等），别直接照搬旧版。
 */
export const READONLY_CUSTOM_TOOL_NAMES = [
  "read",
  "grep",
  "glob",
  "merge_test_mr",
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
    // 合 test MR：服务端执行（token 不出服务端），目标分支守卫见 bypass-merge-mr
    withModelBudget(buildMergeTestMrTool(), spill),
  ];
};

/**
 * pi 后端的规范编码工具（shell / glob / delete / task + 盖掉原生 write/edit/read/grep 的别名包装）。
 * task 子 agent 靠传入的 runSubagent 回调。自研的 shell/glob/delete/task 全包 withModelBudget
 *（shell 10MB 收集是真黑洞、task 子 agent 回包无上限）；别名包装里已包过、这里不再重包。
 */
export const buildCodingToolDefs = (
  cwd: string,
  runSubagent: SubagentRunner,
  spill?: ModelBudgetSpill,
  /**
   * `omitGitToken: true` = shell 的 env 摘掉 FLOWSHIP_GITLAB_TOKEN（需求群非属主答疑旁路用，
   * 判据与接线见 shellTool 里的注释）。默认（属主会话）照常继承。
   */
  opts: { omitGitToken?: boolean } = {},
): ToolDefinition[] => [
  withModelBudget(shellTool(cwd, { omitGitToken: opts.omitGitToken === true }), spill),
  withModelBudget(globTool(cwd), spill),
  withModelBudget(deleteTool(cwd), spill),
  withModelBudget(taskTool(runSubagent), spill),
  ...buildNativeToolAliasWrappers(cwd, spill),
];

/**
 * 摘掉 GitLab token 的 pi 原生 `bash`——给「无 GitLab 凭证」会话的 general 子代理用。
 *
 * 为什么需要：子代理（task 工具起的内层会话）用的是 pi **原生** bash（SUBAGENT_TOOLS 里的 "bash"），
 * 它的 env 是 pi 的 getShellEnv()（整份 process.env，连宿主注入变量都不剔）、不经 shellTool——
 * 只摘父会话的 shell 工具，旁路让模型派个 general 子代理 `printenv` 照样拿到 PAT。
 * 用 spawnHook 摘变量、其余行为（截断 / 超时 / 渲染）全部沿用原生实现；同名 customTool 会盖掉原生 builtin。
 * 同 shellTool：只摘环境变量、不阻止读文件（子代理的 read 一样能读 config.json）。
 */
export const buildGitTokenFreeBashTool = (cwd: string): ToolDefinition =>
  asTool(
    createBashToolDefinition(cwd, {
      spawnHook: (ctx) => ({ ...ctx, env: stripGitTokenEnv(ctx.env) }),
    }),
  );

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
