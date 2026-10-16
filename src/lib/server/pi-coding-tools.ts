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

import { lstatSync, promises as fs, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { checkReadonlySql } from "./sql-readonly-guard";

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
      //   - 只读 shell（readonlyShellTool）无条件摘；但它当前没有调用方（readOnly 无人传 true）。
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
 * 凭据、拒绝逃出工作区；拒绝时给一句话指引（走 pg-exec / 找任务所有者）。
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
 * ls / cat / head / tail / grep / wc 的旗标白名单（L4-01）：只放行不带值的布尔旗标 + 数字值，其余一律拒。
 *
 * 为什么：原先本地查看命令把「以 `-` 开头的 token」整体跳过、只对剩下的做路径钳制，于是路径值选项成了漏洞——
 *   `wc --files0-from=<数据目录>/config.json`（`=` 形态以 `-` 开头，整体没人看）、
 *   `grep -f <数据目录>/config.json x file.txt`（`-f` 的值被当成 pattern 槽跳过，真正的 pattern `x` 反倒进了路径钳制）。
 * 审查方实证两条都是 ok:true。路径值选项（`-f` / `--file` / `--files0-from` / `--exclude-from` / `--include-from`、grep 的 `-d` / `-D` 等）
 * 不在白名单里，写法认不出来的一律拒；要读文件就把路径作为操作数传（会过钳制）。
 *
 * 字母表只收「GNU 与 BSD（macOS）里都是不带值的布尔旗标」的字母——两边含义不同或带值的（`ls -I` / `-w` / `-T` / `-D`、`tail -f` / `-F` / `-s`、
 * `grep -f` / `-d` / `-D` / `-X` 等）一律不收。`tail -f` / `-F` 也不收：永远不退出，只会占到超时被杀。
 * 数字值：`head` / `tail` 的 `-n` / `-c`、grep 的 `-A` / `-B` / `-C` / `-m`（`-n5` 粘连、`-n 5` 分开、`--lines=5` 都行；值只认 `[+-]?数字`）；
 * `-NUM` 简写（`head -5`、`grep -3`）也认。grep 的 `-e PATTERN`：值是 pattern（不是文件），给了 `-e` 之后所有操作数都是文件。
 * 另放行 grep 的 `--include=` / `--exclude=` / `--exclude-dir=`（值是 glob、不读文件，`grep -rn --include='*.ts'` 是常用写法，原本就放行）。
 */
interface LocalViewSpec {
  /** 合并簇里允许的布尔短旗标字母 */
  shortBool: string;
  /** 带数字值的短旗标字母 */
  shortNum?: string;
  /** `-NUM` 简写 */
  numShorthand?: boolean;
  /** 值是 pattern 的短旗标字母（grep -e） */
  shortPattern?: string;
  longBool: readonly string[];
  /** `--name=数字` */
  longNum?: readonly string[];
  /** `--name=glob`（值不是路径） */
  longGlob?: readonly string[];
}
const LOCAL_VIEW_SPECS: ReadonlyMap<string, LocalViewSpec> = new Map<string, LocalViewSpec>([
  [
    "ls",
    {
      shortBool: "aAlh1RtrSdFpsinkGCxucUfgoqmb",
      longBool: [
        "--all",
        "--almost-all",
        "--human-readable",
        "--recursive",
        "--reverse",
        "--directory",
        "--classify",
        "--inode",
        "--size",
        "--numeric-uid-gid",
      ],
    },
  ],
  [
    "cat",
    {
      shortBool: "AbEenstTuv",
      longBool: [
        "--number",
        "--number-nonblank",
        "--squeeze-blank",
        "--show-all",
        "--show-ends",
        "--show-tabs",
        "--show-nonprinting",
      ],
    },
  ],
  [
    "head",
    {
      shortBool: "qv",
      shortNum: "nc",
      numShorthand: true,
      longBool: ["--quiet", "--silent", "--verbose"],
      longNum: ["--lines", "--bytes"],
    },
  ],
  [
    "tail",
    {
      shortBool: "qv",
      shortNum: "nc",
      numShorthand: true,
      longBool: ["--quiet", "--silent", "--verbose"],
      longNum: ["--lines", "--bytes"],
    },
  ],
  [
    "wc",
    {
      shortBool: "lwcmL",
      longBool: ["--lines", "--words", "--bytes", "--chars", "--max-line-length"],
    },
  ],
  [
    "grep",
    {
      shortBool: "ivnclLwxHhrREFGPoqsaIbU",
      shortNum: "ABCm",
      numShorthand: true,
      shortPattern: "e",
      longBool: [
        "--ignore-case",
        "--invert-match",
        "--line-number",
        "--count",
        "--files-with-matches",
        "--files-without-match",
        "--word-regexp",
        "--line-regexp",
        "--with-filename",
        "--no-filename",
        "--recursive",
        "--extended-regexp",
        "--fixed-strings",
        "--only-matching",
        "--quiet",
        "--no-messages",
        "--text",
      ],
      longNum: ["--max-count", "--after-context", "--before-context", "--context"],
      longGlob: ["--include", "--exclude", "--exclude-dir"],
    },
  ],
]);
const LOCAL_VIEW_NUM_RE = /^[+-]?[0-9]+$/;
type LocalViewParse =
  | { ok: true; operands: string[]; patternGiven: boolean }
  | { ok: false; reason: string };
/** 按白名单解析 ls / cat / head / tail / grep / wc 的旗标，返回操作数（`--` 之后的也算，含以 `-` 开头的） */
const parseLocalViewArgs = (bin: string, args: readonly string[], spec: LocalViewSpec): LocalViewParse => {
  const reject = (token: string, why: string): LocalViewParse => {
    const shown = token.startsWith("--") && token.includes("=") ? token.slice(0, token.indexOf("=")) : token; // 不回显 = 之后的值（可能是路径）
    return { ok: false, reason: `旁路只读：${bin} 的选项 \`${shown}\` ${why}` };
  };
  const NOT_WHITELISTED =
    `不在只读白名单：${bin} 只放行不带值的布尔旗标和数字值；\`-f\` / \`--file\` / \`--files0-from\` / \`--exclude-from\` 这类路径值选项会读任意文件，一律拒。要读文件请把路径作为操作数传（须在工作目录内）。`;
  const operands: string[] = [];
  let patternGiven = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i] ?? "";
    if (t === "--") {
      for (let j = i + 1; j < args.length; j++) operands.push(args[j] ?? "");
      break;
    }
    if (!t.startsWith("-")) {
      operands.push(t);
      continue;
    }
    if (t === "-") return reject(t, NOT_WHITELISTED); // stdin 标记：只读查看用不上
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      const value = eq === -1 ? undefined : t.slice(eq + 1);
      if (value === undefined && spec.longBool.includes(name)) continue;
      if (value !== undefined && spec.longNum?.includes(name)) {
        if (LOCAL_VIEW_NUM_RE.test(value)) continue;
        return reject(t, "的值必须是数字。");
      }
      if (value !== undefined && spec.longGlob?.includes(name) && value !== "") continue;
      return reject(t, NOT_WHITELISTED);
    }
    if (spec.numShorthand && /^-[0-9]+$/.test(t)) continue;
    // 短旗标簇：布尔字母逐个过；数字值 / pattern 字母吃掉簇里剩下的部分，剩下为空则吃下一个 token。
    // 拒绝文案只回显出问题的那个旗标字母（`-f`），不回显粘在后面的值（可能是路径）
    const cluster = t.slice(1);
    for (let k = 0; k < cluster.length; k++) {
      const c = cluster[k]!;
      if (spec.shortBool.includes(c)) continue;
      if (spec.shortNum?.includes(c)) {
        const rest = cluster.slice(k + 1);
        const value = rest !== "" ? rest : args[++i];
        if (value === undefined) return reject(`-${c}`, "缺值。");
        if (!LOCAL_VIEW_NUM_RE.test(value)) return reject(`-${c}`, "的值必须是数字。");
        break;
      }
      if (spec.shortPattern?.includes(c)) {
        if (cluster.slice(k + 1) === "" && args[++i] === undefined) return reject(`-${c}`, "缺值。");
        patternGiven = true;
        break;
      }
      return reject(`-${c}`, NOT_WHITELISTED);
    }
  }
  return { ok: true, operands, patternGiven };
};

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
/**
 * git 动词之前允许的全局旗标（L4-01 同类，第八轮复核补）：只放确定不带值的布尔旗标，其余一律拒。
 *
 * 为什么：原先取「第一个不以 `-` 开头的 token」当动词，与第七轮 K4-01 在 node / npm / pnpm / bash 上修掉的是同一类——
 * 带值全局选项（空格分隔）的值不以 `-` 开头，被当成了动词。真 git 2.42.0 在临时仓库里实测：
 *   `git --namespace log branch zzz` 校验器看到 `log`，真实动词是 `branch zzz`，创建了分支 zzz；
 *   `git --namespace status checkout other` 看到 `status`，真实执行的是 checkout，切了分支；
 *   `--attr-source <值>` 空格形态同样吃掉下一个 token。
 * 动词之前只许下面这几个：每一个都用真 git 2.42.0 验过「后面的 `rev-parse --is-inside-work-tree` 照常执行、输出 true」，
 * 即它们不吃下一个 token（tests/readonly-shell-git-global-opts-r8.test.ts 的 C 组每次都对表里的全部旗标再验一遍）。
 * 没放进来的：`-c`（配置注入）、`--namespace` / `--attr-source` / `--config-env` / `--exec-path`（含等号形态：不吃下一个 token，
 * 但同样改 git 的行为，没逐项验过）、`-p` / `--paginate`（起 pager 程序）、`--bare`、`--no-lazy-fetch` / `--no-advice`（git 2.42 不认识）。
 * 要加就逐个用真 git 验证后再加，别放开成前缀 / 通配。动词之后的选项是动词自己的，不归这里管（沿用既有口径）。
 * 局限：只在 git 2.42.0 上验过；别的版本里这几个旗标的行为是推演。
 */
const GIT_LEADING_BOOL_FLAGS: ReadonlySet<string> = new Set([
  "--no-pager",
  "-P",
  "--no-optional-locks",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
]);
/** 测试钩子：对照表里的每个旗标都真跑一遍 git */
export const __gitLeadingBoolFlagsForTest: readonly string[] = [...GIT_LEADING_BOOL_FLAGS];

/**
 * `git branch` 只放行列表形态（L4-01）：`branch` 在 READONLY_GIT_VERBS 里是为了「看分支」，
 * 但 `git branch -D x`（删）、`git branch newbranch`（建）、`-m` / `-c` / `-u` / `--set-upstream-to` 等都会改 ref。
 * 旗标按白名单：`-a` / `--all`、`-r` / `--remotes`、`-v` / `--verbose`（含 `-vv`、`-av` 这类只由 a / r / v 组成的簇）、
 * `--list`、`--show-current`、`--contains`（含 `--contains=<提交>`）；别的（含 `-l`、`--merged`、长选项缩写 `--del`）一律拒——
 * git 的 parse-options 接受唯一前缀缩写，按名字黑名单拦不住，所以只认这几个完整写法。
 * 非选项参数（分支名）只在 `--list` / `--contains` 出现时放行：真 git 2.42 实测此时它们是 pattern / 提交名、不会创建；
 * 没有这两个旗标时 `git branch -v nb` / `-vv nb` / `--verbose nb` 会**创建**分支 nb（实测创建了 refs/heads/nb），`-a nb` / `-r nb` 是 fatal（不靠它兜底）。
 * 返回 null = 放行，否则是拒绝原因。
 */
const GIT_BRANCH_LIST_FLAGS: ReadonlySet<string> = new Set([
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "--verbose",
  "--list",
  "--show-current",
  "--contains",
]);
const GIT_BRANCH_CLUSTER_RE = /^-[arv]+$/;
const checkGitBranchArgs = (args: readonly string[]): string | null => {
  const fail = (what: string): string =>
    `旁路只读：git branch 只放行列表形态（-a / -r / -v / --list / --show-current / --contains，--list / --contains 后可跟 pattern / 提交名）：${what}。创建 / 删除 / 改名 / 改 upstream 找任务所有者。`;
  let listMode = false;
  let firstName: string | undefined;
  for (const t of args) {
    if (t.startsWith("-")) {
      const eq = t.indexOf("=");
      const name = eq === -1 ? t : t.slice(0, eq);
      const allowed =
        eq === -1
          ? GIT_BRANCH_LIST_FLAGS.has(t) || GIT_BRANCH_CLUSTER_RE.test(t)
          : name === "--contains" && t.length > eq + 1; // `--contains=<提交>`：值非空
      if (!allowed) return fail(`不允许选项 \`${name}\``);
      if (name === "--list" || name === "--contains") listMode = true;
    } else if (firstName === undefined) {
      firstName = t;
    }
  }
  if (firstName !== undefined && !listMode) {
    return fail(`\`${firstName === "" ? "（空串）" : firstName}\` 没有 --list / --contains 时会被 git 当成要创建的分支名`);
  }
  return null;
};

/** pg-exec 脚本 token（node 后跟的脚本名，防 evil.js 等冒充） */
const PG_EXEC_LITERAL = "pg-exec.mjs";
/**
 * 命令文本里有没有一个 pg-exec.mjs token：等价于原先的正则 `/(^|\s|["'])((?:\S*\/)?pg-exec\.mjs)(?=[\s"']|$)/`，
 * 改成按字面量定位的线性实现（L4-01，第八轮）：原正则的 `\S*\/` 在「很多个引号 + 没有 `/`」的输入上是二次回溯
 * （node 实测，`echo ` 后接 N 个 `'`：N=5000 → 53ms、10000 → 196ms、20000 → 779ms，平方增长；
 * 改之前含 10 万个引号的几条用例在测试里累计跑了 111s）。
 * 等价性：字面量之后必须是空白 / 引号 / 串尾；字面量之前要么是串首、空白、引号（无目录前缀），要么是 `/`
 * ——紧挨着 `/` 时，从这个 `/` 往回走到第一个空白或串首，那里必然有一个满足 `(^|\s)` 的边界，`\S*` 吃掉中间所有非空白，所以必然匹配。
 * tests/readonly-shell-whitelist-r8.test.ts 用 `__hasPgExecTokenForTest` 对原正则做随机等价比对。
 */
const hasPgExecToken = (s: string): boolean => {
  for (let from = s.indexOf(PG_EXEC_LITERAL); from !== -1; from = s.indexOf(PG_EXEC_LITERAL, from + 1)) {
    const after = s[from + PG_EXEC_LITERAL.length];
    if (after !== undefined && !/[\s"']/.test(after)) continue;
    if (from === 0) return true;
    const before = s[from - 1]!;
    if (before === "/" || before === '"' || before === "'" || /\s/.test(before)) return true;
  }
  return false;
};
/** 仅供测试：与原正则做等价比对 */
export const __hasPgExecTokenForTest = hasPgExecToken;
// 旁路 SQL 只读判定见 ./sql-readonly-guard（词法扫描：识别引号 / 注释 / 美元串、只放单条语句、
// 与 scripts/pg-exec.mjs 同口径；旁路对实例是否只读都拦，可写实例没有库侧只读兜底、全靠这道静态门）。

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
/**
 * 本地命令（git / 查看类 / 仓库脚本）的字符层白名单（L4-01，第八轮）——取代原先的 `LOCAL_UNQUOTED_DENY` 黑名单。
 *
 * 为什么是白名单：黑名单每漏一个字符就是一类绕过（`{` `}` 花括号 → `*` `?` `[` 通配 → `~` 波浪线，连续三轮每轮找出一类）。
 * 校验器按字面 token 做路径钳制 / 选项判断，bash 却会先展开再执行；只要被接受命令的 argv 里没有任何会被 bash 展开的字符，
 * 两边看到的就是同一份。所以反过来：只列出「bash 不会对它做任何处理」的字符，其余一律拒。
 *   - 未加引号：只许 `[A-Za-z0-9_@%+=:,./-]`，外加分隔用的空格 / tab。花括号 / 通配 / `~` / `$` / 反斜杠 / 重定向 / 管道 / 换行 /
 *     `#` 注释 / 括号 / `!` / `^` / 非 ASCII ……一个都不在里面（真 bash 3.2 实测 `echo a=~` 会把 `a=~` 里的 ~ 也展开，所以 `~` 不区分词首词中）；
 *   - 单引号内：bash 全当字面量，原样放行；
 *   - 双引号内：bash 不做花括号 / 通配 / 波浪线展开，但会做 `$` 与反引号展开、反斜杠转义（而 splitShellTokens 一律吞掉反斜杠，
 *     校验看到的与 bash 实际用的不是同一个字符串），所以 `$` 反引号 `\` 一律拒；唯一例外是 `$` 紧跟收尾引号（`"cost$"`：bash 当字面量，
 *     真 bash 3.2 实测），这是既有放行行为（grep 行尾锚点）；
 *   - 控制字符（tab / 换行除外）不论在不在引号内一律拒：没有合法用途，bash 内部又拿其中几个当特殊标记，拿不准就拒；
 *   - 扫描对象是「交给 shell 的那串原文」去掉首尾空格 / tab / 换行后的结果（见调用处）：JS 的 trim 还会吞掉 CR / NBSP 等 bash 当普通字符的东西，
 *     不能拿 trim 之后的串去代表 bash 看到的串。
 *
 * 验证过的与没验证的：用真 bash 3.2.57（macOS 的 /bin/bash）做预言机的小 fuzz（tests/readonly-shell-bash-oracle-r8.test.ts，种子固定）
 * 对「被接受的命令」逐条比 argv：固定种子下 783 个候选、300 条被接受、0 条与真 bash 的 argv 不一致（本机跑出的数字）；
 * 这是抽样不是证明，bash 5 / Windows 的 Git Bash 没有跑过（推演上语义相同）。
 */
const LOCAL_UNQUOTED_ALLOWED_RE = /^[A-Za-z0-9_@%+=:,./-]$/;
const showShellChar = (ch: string): string => {
  if (ch === "\n") return "\\n";
  if (ch === "\r") return "\\r";
  if (ch === "\t") return "\\t";
  const code = ch.charCodeAt(0);
  if (code < 0x20 || code === 0x7f || ch === "\u00a0") return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  return ch;
};
/** 扫描本地命令原文；返回 null = 字符层通过，否则是拒绝原因（已带「旁路只读」前缀与允许清单后缀） */
const scanLocalCommandChars = (s: string): string | null => {
  const deny = (why: string) => `旁路只读：${why}${READONLY_SHELL_DENY_SUFFIX}`;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const code = ch.charCodeAt(0);
    if ((code < 0x20 && ch !== "\t" && ch !== "\n") || code === 0x7f) {
      return deny(`命令里含控制字符（${showShellChar(ch)}），没有合法用途。`);
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\" || ch === "`" || (ch === "$" && s[i + 1] !== '"')) {
        return deny(
          `双引号里的「${showShellChar(ch)}」shell 仍会展开 / 转义（$VAR、$(…)、反引号、反斜杠），校验看到的与实际执行的对不上。字面量请改用单引号包住。`,
        );
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t") continue;
    if (!LOCAL_UNQUOTED_ALLOWED_RE.test(ch)) {
      return deny(
        `未加引号的「${showShellChar(ch)}」不在字符白名单里（未加引号只许 [A-Za-z0-9_@%+=:,./-]）：shell 会对它做展开 / 重定向 / 拼接，校验看到的与实际执行的对不上。` +
          "含这类字符的字面量（通配、花括号、~、中文路径等）请用单引号整体包住，如 'a*b'；要拼命令 / 管道 / 重定向的找任务所有者。",
      );
    }
  }
  return null;
};
/**
 * 只去掉首尾的空格 / tab / 换行（bash 的词分隔符里能出现在命令首尾的那几个）。
 * 手写循环而不是 `/^[ \t\n]+|[ \t\n]+$/g`：后者在「中间夹一大段空白」的超长输入上是二次回溯。
 */
const trimAsciiBlank = (s: string): string => {
  const blank = (ch: string | undefined) => ch === " " || ch === "\t" || ch === "\n";
  let a = 0;
  let b = s.length;
  while (a < b && blank(s[a])) a += 1;
  while (b > a && blank(s[b - 1])) b -= 1;
  return s.slice(a, b);
};
// pg-exec 调用头（SQL 不在里面）：分号、换行、$ 都要拦；另外三个是 fuzz 实测补的（N8-01 余项）：
//   `#`：词首的 `#` 是注释，shell 把它连同后面整段（含 `-- 'SELECT 1'`）一起吞掉，实际只执行被截断的前半截
//       （`node pg-exec.mjs --env #x -- 'SELECT 1'` 实测 argv 只剩 `["--env"]`）——校验看到的与执行的对不上；
//       提示词给 agent 的写法里路径是带引号的，头里未加引号的 `#` 没有任何合法用途，所以不区分词首 / 词中一律拦；
//   `(` `)`：未加引号时 bash 报语法错、什么都不会执行，不构成绕过；这里拦只是不放行「必然失败 / 意图不明」的写法。
//       只管未加引号的——仓路径带括号（`Project (copy)`）时按提示词写成 `"…"` 即可、不受影响。
const HEAD_UNQUOTED_DENY = new Set([";", "&", "|", ">", "<", "`", "\n", "\r", "$", "#", "(", ")"]);
// SQL 参数内：分号（语句结尾）与比较符放行，只拦后台/管道/反引号
const SQL_UNQUOTED_DENY = new Set(["&", "|", "`"]);
const hasSmuggledExecution = (s: string): boolean => s.includes("`") || s.includes("$(");

/** 旁路可跑的脚本入口：node / bash / sh（跑仓内文件）、npm / pnpm（只放 run|test，跑 package 脚本） */
const SCRIPT_RUN_BINS = new Set(["node", "bash", "sh"]);
const PKG_RUN_BINS = new Set(["npm", "pnpm"]);
/**
 * 内联代码执行一律拒绝：-e / --eval / -c / -p / --print 等于把代码写进命令里跑，不再是“跑仓库文件”。
 * 单横线的短参数簇含 e / c / p 就拒——`node -p "…"`、`node -pe "…"`、`bash -xc "…"`、`-e'…'` 粘连写法
 * 都是内联执行；原先只认裸 `-e` / `-c` / `--eval`，这几种全部放行并真的执行了（fuzz 实测，落标记文件）。
 * 误杀面：脚本自己的 `-p 3000` 这类参数也会被拒——这里分不清哪些 token 属于解释器、哪些属于脚本，宁可拒、不按位置放过。
 * 「哪个操作数才是脚本」不靠这条判断，由 `pickScriptOperand` 按前导选项白名单解析（K4-01：带值选项的值不能被当成脚本）。
 *
 * H4-10：原先是 `^-[a-zA-Z]*[ecp]` 的前缀匹配，脚本自己的 `-verbose` / `-print` / `-quiet` / `-debug` 这类单横线长参数
 * 被当成簇（`-ve` / `-p` / `-quie` / `-de`）误拒。光补行尾锚不行（`-verbose` 恰好以 `e` 结尾），所以按真正会内联执行的形态分：
 *   - 含 `c` 的纯字母簇：不论多长一律拒。bash / sh 的 `-c` 可以出现在任意长度的合并簇里（`bash -eufxc 'cmd'` 合法、真会执行 cmd），
 *     不能因为簇长就放过；代价是 `-cache` / `-check` / `-clean` 这类脚本参数照旧被拒；
 *   - 含 e / p（不含 c）的纯字母簇：只在 ≤ 3 个字母时当簇拒（node 的 `-e` / `-p` / `-pe` 是 1~2 个字母，这里多放一档到 3：
 *     perl 风格的 `-ne` / `-lpe` 宁可拒）。是「含」不是「只含」：`-xe`、`-eu`、`-ver` 也在内；
 *     更长的（`-verbose` / `-print` / `-quiet` / `-debug` / `-help`）是长参数名，放行；
 *     注意这条规则**没有按 bin 分流**：bash / sh 里 `-e`（errexit）、`-eu` 本身并不是内联执行，却同样被拒——
 *     「≤ 3 个字母且含 e / p」是照 node 的 `-e` / `-p` / `-pe` 定的，bash 的 `bash -eu script.sh` 因此被误拒（偏严、没有放行方向的问题，
 *     HANDOFF 已承认这点；想放行就得在这里按 bin 分流，同时要保住 `bash -xc` / `-eufxc` 这类含 c 的簇照拒）；
 *   - `=` 之前同样按纯字母规则判（`-verbose=true` 放行、`-e=0` 拒）；
 *   - 带别的非字母尾巴的（`-e0`、`-e"…"` 粘连成 `-erequire(…)`、`-p3000`）：无法分清「簇 + 粘连代码」与「长名 + 值」，按旧口径——前导字母含 e / c / p 就拒；
 *   - `--eval` / `--print`（含 `=值`）名字固定，照旧拒。
 */
const INLINE_LONG_FLAG_RE = /^--(?:eval|print)(?:$|=)/;
const SINGLE_DASH_FLAG_RE = /^-([a-zA-Z]+)([\s\S]*)$/;
const isInlineCodeFlag = (t: string): boolean => {
  if (INLINE_LONG_FLAG_RE.test(t)) return true;
  const m = SINGLE_DASH_FLAG_RE.exec(t);
  if (!m) return false;
  const letters = m[1]!;
  const tail = m[2]!;
  if (tail === "" || tail.startsWith("=")) {
    return letters.includes("c") || (letters.length <= 3 && /[ep]/.test(letters));
  }
  return /[ecp]/.test(letters);
};
/**
 * node 的预加载类选项：--import / --loader / --experimental-loader / --require / -r，以及 --test-reporter（F2-08）。
 * reporter 模块同样按 import 加载，值是 data: 时一样被当源码执行（`--test_reporter` 下划线、空格分隔也生效，真 node 22 实测）。
 * 为什么要单独拦：它们的值可以是 `data:` URL，Node 把 URL 里的内容当模块源码直接执行（真 node 22 实测），
 * 与 `-e` 等价，却不在上面那条正则里；`--experimental_loader`（下划线）node 同样认。
 * 只拒 data: 值，不拒预加载本身：`--import ./pre.mjs` / `-r dotenv/config` 是正常的仓库脚本用法，放行行为不变。
 * scheme 大小写不敏感、URL 解析会剥掉首尾空白，所以按 `^\s*data:`（i）判。
 */
const NODE_PRELOAD_FLAG_RE =
  /^(?:--(?:import|loader|experimental[-_]loader|require|test[-_]reporter)|-r)(?:=([\s\S]*))?$/;
/**
 * npm 的 --node-options（F2-08 续）：值原样进子进程的 NODE_OPTIONS，里面写 `--import=data:…` 与上面同理（真 npm 10 实测，
 * `npm run x` / `npm test` 都生效）。它的值是一整串选项而不是单个 URL，不能只看开头，所以整串里出现 data: 就拒；
 * 普通的 `--max-old-space-size=4096` 不受影响。npm 只认连字符写法（下划线实测无效），这里下划线也一并拒，拿不准就拒。
 */
const NODE_OPTIONS_FLAG_RE = /^--node[-_]options(?:=([\s\S]*))?$/;
const hasInlinePreload = (tokens: string[]): boolean =>
  tokens.some((t, i) => {
    // 等号形态取等号后；否则取下一个 token（与 isInlineCodeFlag 同风格：不区分在脚本之前还是之后，宁可拒）
    const valueOf = (m: RegExpExecArray): string => (m[1] !== undefined ? m[1] : (tokens[i + 1] ?? ""));
    const m = NODE_PRELOAD_FLAG_RE.exec(t);
    if (m) return /^\s*data:/i.test(valueOf(m));
    const n = NODE_OPTIONS_FLAG_RE.exec(t);
    return n !== null && /data:/i.test(valueOf(n));
  });
/**
 * 把预加载选项连同它的值从参数里分出来（H4-01）：`rest` 是剩下的参数（真正的脚本操作数在这里面找），`values` 是预加载的值。
 * 值的取法与 `hasInlinePreload` 同口径：`--require=路径` 取等号后，`-r 路径` / `--import 路径` 取下一个 token（缺值记成空串，
 * 由 `checkNodePreloadTarget` 拒掉）；不区分在脚本之前还是之后，宁可拒。
 * 为什么必须分出来：原先「第一个非 flag 参数 = 脚本」会把 `-r ./pre.js` 的值 `./pre.js` 当成脚本，真正的脚本 `../outside/evil.js`
 * 成了没人看的普通参数；`--require=/tmp/evil.js` 这种等号形态以 `-` 开头被整体跳过，预加载目标没有任何钳制（两种写法评审实测都 ok:true）。
 */
const extractNodePreloads = (args: readonly string[]): { values: string[]; rest: string[] } => {
  const values: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i] ?? "";
    const m = NODE_PRELOAD_FLAG_RE.exec(t);
    if (!m) {
      rest.push(t);
      continue;
    }
    if (m[1] !== undefined) {
      values.push(m[1]);
    } else {
      values.push(args[i + 1] ?? "");
      i++;
    }
  }
  return { values, rest };
};
/** URL scheme（至少两个字符，避开 Windows 盘符 `C:\`） */
const URL_SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]+):/;
/**
 * 部署/发布/上线类脚本名：能跑也不给，非属主跑发版必须先找属主确认。
 * 按「词」匹配（deploy.sh 拦、product-list.js / productList 不拦），只是绊马索、不是证明，见 checkBypassRunScript 注释。
 *
 * 切词规则（L4-01，第八轮）：非字母数字一律当分隔符（原先只认 `-_.`，于是 `deploy:prod`、`release:patch`、`ci/publish` 全部放行——
 * npm 脚本名里 `:` 是最常见的命名空间分隔符）；再在驼峰边界（`deployProd` → deploy / Prod；`HTMLDeploy` → HTML / Deploy）
 * 与字母 / 数字边界（`deploy2prod`）处切开；全大写的整词（`DEPLOY`、`RELEASE_NOTES`）本来就是整词。切完逐词小写后与关键字比对。
 * 仍然是整词匹配：`deployer`、`preprod`、`onlinestatus`、`reproduce` 这类不拆的整词不命中（与原先同口径，误杀面不扩大）。
 * 原先是一条带 `i` 标志的正则；加驼峰边界不能再用 `i`（`[A-Z]` 会变成匹配小写），所以改成函数。
 * 单趟扫描、线性复杂度（不用带回溯的正则切词：`[A-Z]+` 后接 `[A-Z][a-z]` 在长串全大写输入上是平方级）。
 */
const DEPLOY_NAME_WORDS: ReadonlySet<string> = new Set(["deploy", "publish", "release", "prod", "production", "online"]);
/** 0 = 分隔符（非字母数字）、1 = 小写、2 = 大写、3 = 数字 */
const charKind = (ch: string | undefined): 0 | 1 | 2 | 3 => {
  if (ch === undefined) return 0;
  if (ch >= "a" && ch <= "z") return 1;
  if (ch >= "A" && ch <= "Z") return 2;
  if (ch >= "0" && ch <= "9") return 3;
  return 0;
};
const isDeployLikeName = (name: string): boolean => {
  if (name.includes("发版") || name.includes("上线")) return true;
  let word = "";
  let prevKind: 0 | 1 | 2 | 3 = 0;
  const flush = (): boolean => {
    const hit = word !== "" && DEPLOY_NAME_WORDS.has(word.toLowerCase());
    word = "";
    return hit;
  };
  for (let i = 0; i < name.length; i++) {
    const ch = name[i]!;
    const kind = charKind(ch);
    if (kind === 0) {
      if (flush()) return true;
      prevKind = 0;
      continue;
    }
    // 词边界：小写→大写（deployProd）、大写串里最后一个大写后接小写（HTMLDeploy → HTML | Deploy）、字母↔数字（deploy2prod）
    const boundary =
      word !== "" &&
      ((prevKind === 1 && kind === 2) ||
        (prevKind === 2 && kind === 2 && charKind(name[i + 1]) === 1) ||
        (prevKind === 3 && kind !== 3) ||
        (prevKind !== 3 && kind === 3));
    if (boundary && flush()) return true;
    word += ch;
    prevKind = kind;
  }
  return flush();
};

/**
 * 预加载目标（`-r` / `--require` / `--import` / `--loader` / `--test-reporter` 的值）校验（H4-01）：
 * 预加载会在脚本之前被 node 真正加载执行，所以它与脚本本身同等对待——钳在工作目录内、不碰凭据文件、不是发布类脚本名。
 * 接受三种写法：① 路径（相对 cwd 解析，绝对路径要落在 cwd 内）；② `file:` URL（转成路径后同样钳制；带主机名 / `%2F` 等畸形的拒）；
 * ③ 包名（`tsx` / `dotenv/config` / `@scope/pkg`）和 `node:` 内置模块——按路径解析后天然落在 cwd 内、不会被误伤。
 * 其它 URL scheme（http(s): 等，node 默认也不会加载）、`~`、`$` / 反引号（shell 展开后与校验看到的不一致）、空值一律拒。
 * 局限：包名由 node 从 cwd 往上逐级找 node_modules，静态校验看不到解析结果，这里只管「字面上不越界」。
 * 路径同样按 `cwd`（不是 shell 实际所在的 `workCwd`）做**纯词法**解析与钳制：按 cwd 而非 workCwd 只会偏严，但纯词法不跟符号链接（工作区里指向仓外的链接会放行）；
 * 两点的完整说明与可利用性见 `checkBypassRunScript` 注释里的「已知残余（K4-10）」。
 * `data:` 值由 `hasInlinePreload` 先拒，不在这里重复。
 */
const checkNodePreloadTarget = (
  root: string,
  cwd: string,
  value: string,
): { ok: boolean; reason?: string } => {
  const deny = (why: string) => ({
    ok: false,
    reason: `旁路只读：预加载（-r / --require / --import / --loader / --test-reporter）的目标只能是工作目录内的文件或包名，${why}（${value || "空值"}）。`,
  });
  const spec = value.trim();
  if (!spec) return deny("缺少值");
  if (spec.startsWith("~")) return deny("不允许 ~ 开头");
  if (spec.includes("$") || spec.includes("`")) return deny("不允许 $环境变量 / `...`");
  let target = spec;
  const scheme = URL_SCHEME_RE.exec(spec);
  if (scheme) {
    const name = scheme[1]!.toLowerCase();
    if (name === "node") return { ok: true };
    if (name !== "file") return deny("不允许 URL（只放 file: / node: / 路径 / 包名）");
    try {
      target = fileURLToPath(spec);
    } catch {
      return deny("file: URL 无法还原成本机路径");
    }
  }
  const abs = path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);
  if (abs !== root && !abs.startsWith(root + path.sep)) return deny("越界了");
  if (isBypassBlockedReadPath(abs)) {
    return { ok: false, reason: `旁路只读：凭据文件不允许碰。${BYPASS_GUARD_HINT}` };
  }
  if (isDeployLikeName(path.basename(abs))) {
    return {
      ok: false,
      reason: "旁路只读：部署/发布/上线类脚本（deploy/publish/release 等）不能作预加载，先找任务所有者确认。",
    };
  }
  return { ok: true };
};

/**
 * 「哪个操作数是脚本 / 子命令」由前导选项白名单解析得出，不靠「第一个不以 `-` 开头的 token」去猜（K4-01，第七轮 review 实证）。
 *
 * 为什么：带值选项（空格分隔）的**值**不以 `-` 开头。原先取第一个非 flag token 当脚本，值就被当成了脚本——它落在工作目录里就过钳制，
 * 真正被执行的下一个 token 成了没人看的普通参数（方向是放行）。真 bash 5 / node 22 / npm 10 / pnpm 10 在临时目录里实测：
 *   `bash -o pipefail ../outside/ok.sh`、`bash +o pipefail …`、`bash -xo pipefail …`（`-o` / `-O` / `+o` 与任何含 o / O 的合并簇都吃下一个参数）；
 *   `node --conditions dev ../outside/evil.js`（也包括 `-C`、`--env-file`、`--max-old-space-size` 等一大批）；
 *   `npm test --prefix ../outside`、`pnpm --dir=../outside run test`（换了 package 根目录）；
 *   `npm --loglevel test run deploy`、`pnpm --reporter test run deploy`：`test` 被当成动词，真正跑的是 `deploy`（发版脚本名检查被绕开）。
 * 所以改成白名单：前导选项只认下面白名单里**确定不带值**的，或白名单里的 `--xxx=值` 写法（L4-01：等号形态原先是「只要带 `=` 就放行」，
 * 实证 `node --env-file=../outside/.env`、`node --inspect=0.0.0.0:9229`、`pnpm --config.script-shell=…` 全放行，现在按名字查表、值按类型校验）；
 * 其余一律拒——包括「选项后面紧跟的恰好是仓内合法脚本」（校验层不认识这个选项，就无从确认哪个操作数才是脚本，保守起见拒）。
 * 脚本之后的 token 是脚本自己的 argv，不在这里管（沿用「argv 不管」的既有口径）；npm 例外：它的选项在脚本名之后同样被 npm 解析，见 checkBypassRunScript。
 */
type OperandPick =
  | { ok: true; operand: string | undefined; rest: string[] }
  | { ok: false; reason: string };

/** node 前导位置里确定不带值的长布尔旗标（`_` 与 `-` 等价，比较前已统一成 `-`）；`--no-xxx` 取反形态另按规则放行 */
const NODE_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "--version",
  "--help",
  "--test",
  "--test-only",
  "--test-update-snapshots",
  "--watch",
  "--watch-preserve-output",
  "--enable-source-maps",
  "--trace-warnings",
  "--trace-deprecation",
  "--trace-uncaught",
  "--throw-deprecation",
  "--pending-deprecation",
  "--preserve-symlinks",
  "--preserve-symlinks-main",
  "--abort-on-uncaught-exception",
  "--expose-gc",
  "--frozen-intrinsics",
  "--experimental-vm-modules",
  "--experimental-strip-types",
  "--experimental-transform-types",
  "--experimental-require-module",
  "--experimental-detect-module",
  "--experimental-test-coverage",
  "--experimental-test-module-mocks",
  "--experimental-test-snapshots",
  "--experimental-sqlite",
  "--experimental-websocket",
  "--experimental-import-meta-resolve",
  "--experimental-wasm-modules",
  "--experimental-json-modules",
]);
/**
 * node 的 `--xxx=值` 里点名拒绝的（只为给出更准的拒绝原因；不在白名单的等号形态本来就拒，见 NODE_EQ_FLAGS）：
 * 它们改的是「实际执行什么」，等号形态也一样绕开检查。
 * `--run=<名>`：执行 package.json 里的脚本，发版脚本名检查（`scripts/deploy.js` 那类）被绕开（真 node 22 实测 `node --run=deploy` 执行 deploy 脚本）；
 * `--experimental-config-file=<文件>`：换一份配置文件，其中的预加载 / 选项不过任何钳制。
 */
const NODE_DENIED_FLAGS: ReadonlySet<string> = new Set(["--run", "--experimental-config-file"]);

/** `--xxx=值` 里值的类型：number = 纯数字；word = 单个词（字母数字 `_.:@/+-`）；any = 任意非空串；path = 工作目录内的文件 */
type EqValueKind = "number" | "word" | "any" | "path";
/**
 * node 前导位置里允许的 `--xxx=值` 写法（L4-01：原先「带 `=` 就放行」，实证 `--env-file=../outside/.env`、`--inspect=0.0.0.0:9229` 都放行）。
 * 只放行「值不会改变实际执行的内容 / 不对外开口 / 不落盘」的几项；`_` 与 `-` 等价，查表前已统一成 `-`。
 * 预加载类（`--import=` / `--require=` / `--loader=` / `--experimental-loader=` / `--test-reporter=`）不在这里：
 * 它们在到达这里之前已被 extractNodePreloads 连值取走，值走 checkNodePreloadTarget。
 * 没放进来的（需要的话逐项加，别放开成前缀 / 通配）：`--inspect*`（对外开调试端口）、`--redirect-warnings` / `--diagnostic-dir` /
 * `--*-prof-dir`（落盘）、`--title`、`--run`、`--experimental-config-file`、`--test-reporter-destination`（落盘）等。
 */
const NODE_EQ_FLAGS: ReadonlyMap<string, EqValueKind> = new Map<string, EqValueKind>([
  ["--conditions", "word"],
  ["--max-old-space-size", "number"],
  ["--stack-trace-limit", "number"],
  ["--test-concurrency", "number"],
  ["--test-timeout", "number"],
  ["--test-name-pattern", "any"],
  ["--test-skip-pattern", "any"],
  ["--env-file", "path"],
  ["--env-file-if-exists", "path"],
]);
/** 校验 `--xxx=值` 的值；返回 null = 通过，否则是接在「前导选项 `x` 」后面的原因 */
const checkEqValue = (kind: EqValueKind, value: string, ctx: OperandCtx | undefined): string | null => {
  if (kind === "number") return /^[0-9]+$/.test(value) ? null : "的值必须是纯数字";
  if (kind === "word") return /^[A-Za-z0-9_.:@/+-]+$/.test(value) ? null : "的值写法不认识（只认字母数字和 _.:@/+-）";
  if (kind === "any") return value !== "" ? null : "缺值";
  // path：必须在工作目录内、不碰凭据文件（与脚本 / 预加载同口径的纯词法钳制）
  if (!ctx) return "的值是文件路径，这里没有工作目录信息，无法钳制";
  if (value.trim() === "") return "缺值";
  if (value.startsWith("~") || value.includes("$") || value.includes("`")) return "的值不允许 ~ 开头 / $ / 反引号";
  const abs = path.isAbsolute(value) ? path.normalize(value) : path.resolve(ctx.cwd, value);
  if (abs !== ctx.root && !abs.startsWith(ctx.root + path.sep)) return "的值越界了：只能是工作目录内的文件";
  if (isBypassBlockedReadPath(abs)) return "的值是凭据文件，不允许碰";
  return null;
};
/** 路径类选项值钳制用的上下文：与脚本 / 预加载同样按 `cwd` 做纯词法解析（局限见 checkBypassRunScript 注释「已知残余（K4-10）」） */
interface OperandCtx {
  root: string;
  cwd: string;
}

/** bash 的长布尔旗标（`--rcfile` / `--init-file` 带值，单独拒；不认识的长选项一律拒） */
const SHELL_BOOLEAN_LONG_FLAGS: ReadonlySet<string> = new Set([
  "--norc",
  "--noprofile",
  "--posix",
  "--login",
  "--restricted",
  "--verbose",
  "--noediting",
  "--debugger",
  "--version",
  "--help",
]);

/**
 * npm / pnpm 前导位置（动词之前、脚本名之前）里确定不带值的布尔旗标。带值的写成 `--xxx=值` 才放行（等号形态自成一个 token，不会吃掉动词）。
 * 不在表里的单横线 / 长选项（`--loglevel test`、`-F foo`）一律拒：空格分隔的值会被当成动词或脚本名。
 */
const PKG_BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "--silent",
  "-s",
  "--quiet",
  "-q",
  "--if-present",
  "--ignore-scripts",
  "--foreground-scripts",
  "--color",
  "--no-color",
  "--no-progress",
  "--no-fund",
  "--no-audit",
  "--no-update-notifier",
  "--workspaces",
  "--include-workspace-root",
  "--offline",
  "--json",
  "--recursive",
  "-r",
  "--parallel",
  "--stream",
  "--sequential",
  "--no-bail",
]);
/**
 * npm / pnpm 里会换 package 根目录 / 配置文件 / 执行脚本的 shell 的长选项，**任意位置**都拒（空格 / 等号 / 缩写都算）：
 * `--prefix`（npm）、`--dir`（pnpm，短写 `-C`）、`--workspace`（短写 `-w`）、`--userconfig` / `--globalconfig`（换配置）、
 * `--script-shell`（换跑 package 脚本的 shell，等于换了可执行文件）。
 * 缩写也算：npm 用 nopt 解析、接受**唯一前缀缩写**（真 npm 10 实测 `npm prefix --prefi=/x` 等价于 `--prefix=/x`），
 * 所以按「选项名是某个禁用名的前缀」判，`--pre` / `--workspac` / `--userconf` 一并拒（pnpm 不缩写，多拒不漏拒）。
 * 位置不区分、`--` 之后也拒：npm 的这些选项出现在脚本名之后同样生效（`npm test --prefix ../outside`），
 * pnpm 在脚本名之后的属于脚本参数，但分不清时宁可拒（沿用「选项排在脚本之后也拒」的既有口径）。
 * L4-01：另按前缀整类拒 `--config.<键>`（pnpm 的任意配置键，见 isDeniedPkgOption），不靠枚举键名。
 */
const PKG_DENIED_LONG_FLAGS = [
  "--prefix",
  "--dir",
  "--workspace",
  "--userconfig",
  "--globalconfig",
  "--script-shell",
] as const;
const isDeniedPkgOption = (t: string): boolean => {
  if (t.startsWith("--")) {
    const eq = t.indexOf("=");
    const name = (eq === -1 ? t : t.slice(0, eq)).replace(/_/g, "-");
    // pnpm 的 `--config.<键>=值` 能设任意配置键（真 pnpm 10 实测 `pnpm --config.node-options=--no-warnings run test` 会把值写进脚本进程的
    // NODE_OPTIONS；`--config.script-shell` 同理换 shell），按前缀整类拒，不枚举键名；大小写不敏感（拿不准就拒）
    if (name.toLowerCase().startsWith("--config.")) return true;
    return name.length > 2 && PKG_DENIED_LONG_FLAGS.some((d) => d.startsWith(name));
  }
  // 单横线：`-C`（--dir）、`-w`（--workspace）及含它们的合并簇（nopt 会把 `-sw x` 拆成 `-s -w x`）
  const short = /^-([A-Za-z]+)(?:=[\s\S]*)?$/.exec(t);
  return short !== null && /[Cw]/.test(short[1]!);
};

/** 前导选项白名单判定：返回 null = 放行，返回字符串 = 拒绝原因（接在「前导选项 `x` 」后面） */
const nodeLeadingFlagVerdict = (t: string, ctx?: OperandCtx): string | null => {
  if (t === "-v" || t === "-h") return null;
  if (!t.startsWith("--")) {
    return "是单横线选项（`-C` 等带值、`-i` 进 REPL），不在白名单，无法确认哪个操作数是脚本";
  }
  const eq = t.indexOf("=");
  const name = (eq === -1 ? t : t.slice(0, eq)).replace(/_/g, "-");
  if (name === "--") return "写法畸形";
  if (NODE_DENIED_FLAGS.has(name)) {
    return "会换掉实际执行的内容（`--run` 跑 package.json 里的脚本、`--experimental-config-file` 换配置文件），绕开脚本检查";
  }
  if (eq !== -1) {
    // `--xxx=值`：值自成一体，不会被后面的操作数当成脚本；但等号形态本身也能改行为（读任意文件 / 对外开端口 / 落盘），所以按名字查表、按类型验值
    const kind = NODE_EQ_FLAGS.get(name);
    if (kind === undefined) {
      return "不在 `--xxx=值` 白名单：node 的等号形态也会改实际行为（`--env-file=` 读任意文件、`--inspect=` 对外开调试端口、`--redirect-warnings=` / `--*-prof-dir=` 落盘……）";
    }
    return checkEqValue(kind, t.slice(eq + 1), ctx);
  }
  if (NODE_BOOLEAN_FLAGS.has(name) || /^--no-[a-z0-9-]+$/.test(name)) return null;
  return "不在布尔旗标白名单：node 带值的选项请写成白名单里的 `--xxx=值`（空格分隔的值会被误认成脚本）";
};
const shellLeadingFlagVerdict = (t: string): string | null => {
  if (t === "-" || t === "+") return "是孤立的 - / +（bash 里等于选项结束标记），无法确认哪个操作数是脚本";
  if (t.startsWith("+")) {
    return "是 + 形态（取消选项；`+o 名字` 同样吃掉下一个参数），跑脚本文件没有合法用途";
  }
  if (t.startsWith("--")) {
    const name = t.split("=")[0]!;
    if (name === "--rcfile" || name === "--init-file") {
      return "带值（--rcfile / --init-file 的值会被误认成脚本）";
    }
    return SHELL_BOOLEAN_LONG_FLAGS.has(t) ? null : "不在白名单，无法确认它带不带值";
  }
  if (/^-[a-zA-Z]+$/.test(t)) {
    // -o / -O 带值，且不限于单独出现：合并簇里含 o / O（`-xo pipefail`）一样吃下一个参数。c 在 isInlineCodeFlag 里已经拒了
    return /[oO]/.test(t) ? "含 o / O（`-o 名字` / `-O 名字` 吃下一个参数，值会被误认成脚本）" : null;
  }
  return "写法不认识，无法确认它带不带值";
};
/**
 * npm / pnpm 允许的 `--xxx=值` 写法（L4-01：原先「带 `=` 就放行」）。`--node-options` 的值是一整串 NODE_OPTIONS，
 * 在 checkBypassRunScript 里另外切开、逐项过预加载钳制与 node 白名单。其余没列进来的（`--registry=` / `--cache=` / `--store-dir=` /
 * `--use-node-version=` …）会改网络 / 缓存 / 工具链来源，一律拒。
 */
const PKG_EQ_FLAGS: ReadonlyMap<string, EqValueKind> = new Map<string, EqValueKind>([
  ["--loglevel", "word"],
  ["--reporter", "word"],
  ["--filter", "any"],
  ["--node-options", "any"],
]);
const pkgLeadingFlagVerdict = (t: string): string | null => {
  if (t.startsWith("--")) {
    const eq = t.indexOf("=");
    const name = (eq === -1 ? t : t.slice(0, eq)).replace(/_/g, "-");
    if (name === "--") return "写法畸形";
    if (eq !== -1) {
      const kind = PKG_EQ_FLAGS.get(name);
      if (kind === undefined) {
        return "不在 `--xxx=值` 白名单（只放 --loglevel= / --reporter= / --filter= / --node-options=；其余等号形态会改网络 / 缓存 / 工具链来源 / 执行脚本的 shell）";
      }
      return checkEqValue(kind, t.slice(eq + 1), undefined);
    }
    if (PKG_BOOLEAN_FLAGS.has(name)) return null;
  } else if (PKG_BOOLEAN_FLAGS.has(t)) {
    return null;
  }
  return "不在布尔旗标白名单：带值的选项请写成白名单里的 `--xxx=值`（空格分隔的值会被误认成动词 / 脚本名，发版脚本名检查就被绕开）";
};

/**
 * 从 `args` 里取第一个操作数：前导选项必须全部过白名单，`--` 是选项结束标记（它后面的第一个 token 就是操作数）。
 * 返回操作数与它之后剩下的 token（pkg 取了动词后还要接着取脚本名）；操作数缺失时 `operand` 为 undefined。
 * 空串也算操作数（`node '' ok.js` 里 node 真会把空串当脚本）——交给调用方按「缺脚本」拒，不跳过。
 */
const pickScriptOperand = (bin: string, args: readonly string[], ctx?: OperandCtx): OperandPick => {
  const isShell = bin === "bash" || bin === "sh";
  const verdictOf = (t: string): string | null =>
    bin === "node" ? nodeLeadingFlagVerdict(t, ctx) : isShell ? shellLeadingFlagVerdict(t) : pkgLeadingFlagVerdict(t);
  for (let i = 0; i < args.length; i++) {
    const t = args[i] ?? "";
    if (t === "--") return { ok: true, operand: args[i + 1], rest: args.slice(i + 2) };
    const optionLike = t.startsWith("-") || (isShell && t.startsWith("+"));
    if (!optionLike) return { ok: true, operand: t, rest: args.slice(i + 1) };
    const why = verdictOf(t);
    if (why !== null) return { ok: false, reason: rejectLeadingOption(bin, t, why) };
  }
  return { ok: true, operand: undefined, rest: [] };
};
/** 前导选项被拒的统一文案：只点选项名、不回显 `=` 之后的值（值可能是路径 / 令牌） */
const rejectLeadingOption = (bin: string, t: string, why: string): string => {
  const shown = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
  return `旁路只读：${bin} 的前导选项 \`${shown}\` ${why}。前导位置只放白名单里不带值的旗标和白名单里的 --xxx=值 写法；脚本自己的参数请写在脚本之后（npm 用 \`--\` 隔开）。`;
};

/**
 * 仓库脚本执行校验：能跑不能改。
 * node/bash/sh 的脚本 = 「前面只带白名单旗标」之后的第一个操作数（`pickScriptOperand`，K4-01），它必须是工作目录内的脚本文件
 * （相对路径、防逃逸、防 $ 展开偷换）；
 * node 的预加载选项（含 `=` 形态）连同它的值先单独取出、走 `checkNodePreloadTarget`，再在剩下的参数里找真正的脚本操作数（H4-01）；
 * npm/pnpm 只放 run|test（动词 / 脚本名同样按「前面只带白名单旗标」取；脚本名同样过部署发布检查；换目录 / 配置 / shell 的选项任意位置都拒），
 * 它们的 `--node-options` 里嵌的预加载同样过 `checkNodePreloadTarget`。
 * L4-01（第八轮）：`--xxx=值` 形态不再「整体放行」——node 查 NODE_EQ_FLAGS（未知名字拒、值按类型验）、npm / pnpm 查 PKG_EQ_FLAGS（pnpm 的
 * `--config.*` 整类拒）、`--node-options` 里切出的内层选项同样过 node 白名单、npm 脚本名之后 `--` 之前的选项也过白名单；
 * 脚本名里的部署发布关键字按 isDeployLikeName 判（`:` `/` 也是分隔符、带驼峰边界）。
 * 防不住脚本自身的行为——脚本是仓库代码、跑起来就是用户权限；部署发布类靠名字拦截 +
 * 提示词先确认，真有人拿测试脚本干坏事，兜底靠的是无写工具 + 无凭据 + 事件流留痕。
 *
 * 已知残余（K4-10，第七轮 review 拍板记入、不改行为。读码核实属实，并用临时目录 + 一次性临时测试实测过两点：
 * `link -> 仓外` 时 `node link/evil.js` 与 `node -r ./link/evil.js scripts/ok.js` 都是 ok:true；`workingDirectory=sub` 时 `node ../ok.js` 被拒。
 * 没留测试——行为不改，留一条「当前放行」的用例只会把缺陷钉成规格）：
 * ① 相对路径（脚本 / 预加载 / `file:` URL 还原出的路径）按 `cwd` 解析并钳制，而 shell 实际在 `workCwd`（`workingDirectory` 钳到 cwd 内之后的目录）里跑。
 *    两者只在 `workingDirectory` 非空时不同；`workCwd` 永远是 `cwd` 的子目录，所以「按 cwd 解析在界内」蕴含「按 workCwd 解析也在界内」，
 *    这个差异只会让校验偏严（如 `workingDirectory=sub` 时合法的 `../x.js` 被当成越界拒），没有放行方向的绕过；
 * ② 判界全是**纯词法**（`path.resolve` + 前缀比较），不解析符号链接：工作目录内一个指向仓外的符号链接（`link/evil.js`，`link -> /仓外`）会被放行，
 *    这是放行方向的缺口。可利用性受限于「链接得已经在工作区里」——旁路没有写工具、造不出链接，只有仓库自带 / 别处留下的链接才构成问题；
 *    pg-exec 那条路径用的是 realpath（`probeShellPath`），这里没有。要补就得对脚本与预加载目标做 realpath 再钳制（会引入同步 IO 与 TOCTOU，没做）。
 *    （第九轮 N9-01 复核实测：不只脚本 / 预加载——以软链做路径前缀的 `cat` / `node` / `bash` 操作数同样 ok:true。
 *    所以「偏严不偏松」只对 ① 成立，对软链不成立：软链恰恰是放行方向。接线前要改成对**所有路径操作数**做 realpath 再钳。）
 *
 * **接线前必做清单（第九轮复核，全部潜伏、当前没有调用方传 `readOnly: true`；期限：下一个发版 tag 前仍无调用方就整段删，
 * 连同 r8 的守卫测试与预言机 fuzz，不留半截）**：
 *  - N9-01：路径操作数 realpath 后再钳（见上）；
 *  - N9-02：`git show --textconv`、`git diff --ext-diff` 会调 git 配置里的外部程序，只读模式下 agent 改不了配置所以当前无法利用，
 *    接线时把这两个选项加进 git 的拒绝名单；
 *  - N9-03：未加引号的非 ASCII 字符会被字符白名单拒（裸写中文文件名被拒、单引号包住放行）。**报错文案本来就带这句提示**
 *    （「含这类字符的字面量（通配、花括号、~、中文路径等）请用单引号整体包住」，见 `LOCAL_UNQUOTED_ALLOWED_RE` 那处的 deny），无需再改；
 *    接线时只需确认调用方把这条文案原样回给模型。
 */
const checkBypassRunScript = (
  root: string,
  cwd: string,
  bin: string,
  tokens: string[],
): { ok: boolean; reason?: string } => {
  if (tokens.some((t) => isInlineCodeFlag(t))) {
    return {
      ok: false,
      reason: "旁路只读：不允许 -e / --eval / -c 内联代码（只跑仓库里的脚本文件，改文件找任务所有者）。",
    };
  }
  if (hasInlinePreload(tokens)) {
    return {
      ok: false,
      reason: "旁路只读：不允许 data: URL 形态的预加载（--import / --loader / --require / --test-reporter / npm 的 --node-options 里带 data: 等于内联代码，只跑仓库里的脚本文件）。",
    };
  }
  const ctx: OperandCtx = { root, cwd };
  // 预加载的值：只有 node 才有这组选项（bash 的 `-r` 是 restricted、pnpm 的 `-r` 是 recursive，都不带值，不能当预加载）
  let operands = tokens.slice(1);
  const preloadValues: string[] = [];
  if (bin === "node") {
    const split = extractNodePreloads(operands);
    operands = split.rest;
    preloadValues.push(...split.values);
  }
  // npm 的 --node-options：值是整串 NODE_OPTIONS，切开后里面的预加载与上面同样处理（任意 bin 上出现都查，拿不准就拒）
  for (let i = 1; i < tokens.length; i++) {
    const n = NODE_OPTIONS_FLAG_RE.exec(tokens[i] ?? "");
    if (!n) continue;
    const inner = splitShellTokens(n[1] !== undefined ? n[1] : (tokens[i + 1] ?? ""));
    if (inner === null) {
      return { ok: false, reason: "旁路只读：--node-options 的值里引号没有闭合，无法确认其中的预加载目标。" };
    }
    const innerSplit = extractNodePreloads(inner);
    preloadValues.push(...innerSplit.values);
    // L4-01：内层其余的选项也走 node 的白名单（`--inspect=0.0.0.0:9229`、`--redirect-warnings=…` 等原先原样进 NODE_OPTIONS）；
    // NODE_OPTIONS 里只放选项，出现非选项 token 说明写法不对，无从确认含义，拒
    for (const innerTok of innerSplit.rest) {
      const why = innerTok.startsWith("-")
        ? nodeLeadingFlagVerdict(innerTok, ctx)
        : "不是选项（NODE_OPTIONS 里只放选项）";
      if (why !== null) {
        const shown = innerTok.includes("=") ? innerTok.slice(0, innerTok.indexOf("=")) : innerTok;
        return { ok: false, reason: `旁路只读：--node-options 里的 \`${shown}\` ${why}。` };
      }
    }
  }
  for (const value of preloadValues) {
    const verdict = checkNodePreloadTarget(root, cwd, value);
    if (!verdict.ok) return verdict;
  }
  if (PKG_RUN_BINS.has(bin)) {
    // K4-01：换目录 / 配置 / shell 的选项任意位置都拒（空格、等号、缩写形态都算，见 PKG_DENIED_LONG_FLAGS）
    const denied = tokens.slice(1).find(isDeniedPkgOption);
    if (denied !== undefined) {
      const shown = denied.includes("=") ? denied.slice(0, denied.indexOf("=")) : denied; // 不回显 = 之后的值
      return {
        ok: false,
        reason: `旁路只读：${bin} 禁止 \`${shown}\`（--prefix / --dir / -C / --workspace / -w / --userconfig / --globalconfig / --script-shell 会换 package 根目录、配置或执行脚本的 shell，不核实目标一律拒）。`,
      };
    }
    // P2：动词 = 前面只带白名单旗标之后的第一个操作数（npm --silent run test 这类常用写法 tokens[1] 是 flag；
    // 但 `npm --loglevel test run deploy` 里的 test 是 --loglevel 的值，不是动词，所以不能再取「第一个非 flag token」，见 pickScriptOperand）
    const verbPick = pickScriptOperand(bin, tokens.slice(1), ctx);
    if (!verbPick.ok) return verbPick;
    const verb = verbPick.operand ?? "";
    if (verb !== "run" && verb !== "test") {
      return {
        ok: false,
        reason: `旁路只读：${bin} 只允许 run / test（跑 package 脚本）。装包、发包、删包找任务所有者。`,
      };
    }
    let afterScript = verbPick.rest;
    if (verb === "run") {
      const namePick = pickScriptOperand(bin, verbPick.rest, ctx);
      if (!namePick.ok) return namePick;
      const name = namePick.operand;
      if (!name) return { ok: false, reason: `旁路只读：${bin} run 必须给脚本名。` };
      if (isDeployLikeName(name)) {
        return {
          ok: false,
          reason: "旁路只读：部署/发布/上线类脚本先找任务所有者确认（脚本名命中发版关键字）。",
        };
      }
      afterScript = namePick.rest;
    }
    // L4-01：npm 把「脚本名之后、`--` 之前」的选项当成 npm 自己的选项（真 npm 10.9 实测 `npm run test --foo=bar` → 脚本里 npm_config_foo=bar，
    // 不会传给脚本；唯一前缀缩写也认：`--node-opt=--no-warnings` / `--node-o=…` 会写进脚本进程的 NODE_OPTIONS，exact 名字的预加载检查看不到）。
    // 所以这一段也走前导选项的白名单；传给脚本的参数要写在 `--` 之后（真 npm 实测会原样传给脚本）。
    // pnpm 不查：真 pnpm 10 实测脚本名之后的参数会传给脚本；它的 `--config.*` 在上面按「任意位置」拒了。
    // 例外：`--node-options <值>`（空格分隔）。真 npm 10.9.4 实测 `npm test --node-options "--max-old-space-size=4096"` 把下一个 token 整个当成值
    // （脚本里 NODE_OPTIONS 就是它；值是 `--require ./pre.js` 时真的去加载了 ./pre.js）；这个值上面已经按 NODE_OPTIONS 内层规则验过
    //（预加载目标钳在工作目录内、其余选项过 node 白名单），所以这里把它当成「选项 + 值」整体跳过，既有放行行为不变。
    if (bin === "npm") {
      for (let i = 0; i < afterScript.length; i++) {
        const t = afterScript[i] ?? "";
        if (t === "--") break;
        if (!t.startsWith("-")) continue;
        if (NODE_OPTIONS_FLAG_RE.test(t) && !t.includes("=")) {
          if (afterScript[i + 1] !== undefined && afterScript[i + 1] !== "--") i += 1;
          continue;
        }
        const why = pkgLeadingFlagVerdict(t);
        if (why !== null) {
          const shown = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
          return {
            ok: false,
            reason: `旁路只读：npm 脚本名之后的选项 \`${shown}\` ${why}。npm 会把脚本名之后、\`--\` 之前的选项当成自己的选项（含唯一前缀缩写），不会传给脚本；传给脚本的参数请写在 \`--\` 之后。`,
          };
        }
      }
    }
    return { ok: true };
  }
  // node / bash / sh：脚本 = 前面只带白名单旗标之后的第一个操作数，必须是工作目录内的脚本文件
  //（node 已剥掉预加载选项及其值，见上；带值选项的值不会被当成脚本，见 pickScriptOperand）
  const scriptPick = pickScriptOperand(bin, operands, ctx);
  if (!scriptPick.ok) return scriptPick;
  const script = scriptPick.operand;
  if (!script) return { ok: false, reason: `旁路只读：${bin} 必须给工作目录内的脚本文件。` };
  if (script.startsWith("~")) {
    return { ok: false, reason: "旁路只读：脚本文件只能是工作目录内的相对路径。" };
  }
  // 与文件参数同理：引号包着 shell 照样展开，脚本路径里出现一律拒绝（传给脚本的 argv 不管）
  if (script.includes("$") || script.includes("`") || script.includes("$(")) {
    return { ok: false, reason: "旁路只读：脚本路径里不允许 $环境变量 / `...` / $(...)。" };
  }
  const abs = path.isAbsolute(script) ? path.normalize(script) : path.resolve(cwd, script);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { ok: false, reason: `旁路只读：脚本文件只能在工作目录内（${script} 越界）。` };
  }
  if (isBypassBlockedReadPath(abs)) {
    return { ok: false, reason: `旁路只读：凭据文件不允许碰。${BYPASS_GUARD_HINT}` };
  }
  if (isDeployLikeName(path.basename(script))) {
    return {
      ok: false,
      reason:
        "旁路只读：部署/发布/上线类脚本（deploy/publish/release 等）先找任务所有者确认，自己不跑。",
    };
  }
  return { ok: true };
};

const READONLY_SHELL_DENY_SUFFIX =
  "旁路只读 shell 只允许：pg-exec 只读查询（SELECT）、ls/cat/tail/head/grep/wc/pwd/echo 本地查看（工作目录内）、git 只读查看（status/log/diff/show/branch/rev-parse）、跑仓库脚本（node/bash/sh + 工作目录内文件、npm/pnpm run|test，部署发布类除外）。不改文件、不碰线上分支，部署发布/合线上 MR 找任务所有者。";

/**
 * pg-exec 命令头里 `node` 的写法只认两种（N8-01 余项）：
 *   ① 裸名 `node` / `node.exe`（走 PATH，服务端环境里的 PATH 不受 agent 控制）；
 *   ② 系统目录下的绝对路径（目录逐字比较、不做 `..` 归一化）。
 * 为什么不再放行任意 `…/node`：原正则 `^(?:[^=]*[\\/])?node` 放行 `./node`、`../x/node`、`/tmp/x/node`，
 * 工作区 / 仓外只要有个叫 node 的可执行文件，校验通过后就是它在跑（实测会落标记文件）；
 * `/usr/bin/../../tmp/x/node` 这种 `..` 回绕同理，所以目录不归一化、也不接受含 `..` 的写法。
 * 大小写敏感：大小写不敏感的文件系统上 `NODE` 能解析到真 node，但没有任何理由让 agent 这样写。
 */
const PG_EXEC_NODE_SYSTEM_DIRS = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/bin"];
const isTrustedPgExecNodeBin = (bin: string): boolean => {
  if (bin === "node" || bin === "node.exe") return true;
  if (!/^\/[^\\]*\/node(?:\.exe)?$/.test(bin) || bin.includes("..")) return false;
  const dir = bin.slice(0, bin.lastIndexOf("/"));
  if (PG_EXEC_NODE_SYSTEM_DIRS.includes(dir)) return true;
  // 当前进程自己的 node（nvm / volta / 自带安装目录）：execPath 的 basename 必须真是 node，
  // 打包后的 Electron（ELECTRON_RUN_AS_NODE）execPath 是 Electron 二进制，不在此列
  const exec = process.execPath.replace(/\\/g, "/");
  return /\/node(?:\.exe)?$/.test(exec) && exec.slice(0, exec.lastIndexOf("/")) === dir;
};
/**
 * 通用分支（本地查看 / git / node·bash·sh / npm·pnpm）里「命令头」的二进制写法：裸名，或系统目录 / 当前 node 所在目录下的绝对路径。
 * 与上面 pg-exec 头的 node 规则同口径（目录逐字比较、不归一化 `..`），只是不限定 basename 必须是 node。
 */
const isTrustedBinToken = (tok: string): boolean => {
  if (!tok) return false;
  if (!tok.includes("/") && !tok.includes("\\")) return true;
  if (tok.includes("\\") || tok.includes("..") || !tok.startsWith("/")) return false;
  const dir = tok.slice(0, tok.lastIndexOf("/"));
  if (PG_EXEC_NODE_SYSTEM_DIRS.includes(dir)) return true;
  const exec = process.execPath.replace(/\\/g, "/");
  return exec.slice(0, exec.lastIndexOf("/")) === dir;
};
/** pg-exec 脚本：basename 必须恰好是 pg-exec.mjs */
const PG_EXEC_SCRIPT_RE = /^(?:.*[\\/])?pg-exec\.mjs$/;
/** pg-exec 唯一接受的 flag（都带一个值） */
const PG_EXEC_VALUE_FLAGS = new Set(["--env", "--user", "--database"]);
/** 头 token 里会被 shell 再展开的字符：变量 / 反引号 / glob / brace（引号包着的 `$` 双引号内照样展开） */
const PG_EXEC_HEAD_EXPANSION_RE = /[$`*?[\]{}]/;
/** pg-exec 调用整条命令里不许出现的未加引号字符：换行 / 回车（shell 的命令分隔符，且 `--` 后的换行会被校验当空白吞掉） */
const PG_EXEC_UNQUOTED_NEWLINE: ReadonlySet<string> = new Set(["\n", "\r"]);
/**
 * pg-exec 调用整条命令里不许出现的未加引号字符：JS 的 `\s` 当空白、bash 却当普通字符的那一族
 * （NBSP / 全角空格 / U+2028·2029 / BOM / `\v` / `\f` 等）。
 * 为什么必须拦：本函数用 `\s` 找 `--` 分隔符、用 `\s*` 吃 SQL 前后的空白，bash 对这些字符却不分词——
 * `--env t<NBSP>-- 'SELECT 1'` 校验看到「头 + `--` + SQL」，bash 实际 argv 是 `["--env","t<NBSP>--","SELECT 1"]`（没有 `--`），
 * `--<NBSP>'SELECT 1'` 实际是粘成一个参数的 `"-- SELECT 1"`（差分 fuzz 实测 200/202 条都是这一族）。
 * 落到真 pg-exec.mjs 上只会被它自己的解析器报错，但「靠被调脚本的解析器兜底」不是这里该有的前提。
 * 只管未加引号的：引号里的（SQL 数据、带这类字符的仓路径）与分词无关，照常放行。
 * 反斜杠转义的这类字符 hasUnquotedChars 会当「引号内」跳过——头里的反斜杠整个被 checkPgExecHead 拒，
 * SQL 区里夹反斜杠会被「SQL 必须独占一个带引号参数」拒，所以这条缝补得上。
 */
const PG_EXEC_UNQUOTED_ODD_SPACE: ReadonlySet<string> = new Set([
  "\v",
  "\f",
  "\u00a0",
  "\u1680",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff",
  // U+2000 ~ U+200A（en quad … hair space）
  ...Array.from({ length: 11 }, (_, i) => String.fromCharCode(0x2000 + i)),
]);

/**
 * 只读 shell 校验的可选项。
 * `pgExecRepoRoot`：「仓」根目录，可信脚本 = `<pgExecRepoRoot>/scripts/pg-exec.mjs`（及同目录 ssh-exec.mjs，只用来拒）。
 * 缺省 = `process.cwd()`——与 company-env-fs.ts 给 agent 的提示词里的脚本路径同源
 * （那里写的就是 `path.join(process.cwd(), "scripts", "pg-exec.mjs")`），提示词教它跑哪个、这里就只认哪个。
 * 注入口只给测试 / 将来改了脚本落点的调用方用，不要从 agent 可控的输入里取。
 */
export interface ReadonlyShellOptions {
  pgExecRepoRoot?: string;
}

/** 探路结果：存在且能解析 / 条目存在但解析不了（悬空链接、自环、权限）/ 根本不存在 */
type PathProbe =
  | { kind: "resolved"; real: string }
  | { kind: "broken" }
  | { kind: "absent" };

/**
 * 按「shell 实际会怎么找这个文件」探路：不做任何词法归一化。
 * 为什么不用 `path.resolve` / `path.join` 先拼：它们会按**字符串**折叠 `..`，而内核按**物理路径**走——
 * `jump/../scripts/pg-exec.mjs` 在 `jump` 是指向仓外的符号链接时，词法上是仓内脚本、物理上是仓外的同名文件
 * （实测放行并执行了仓外那份）。所以直接把 `<cwd>/<token>` 原样交给 `realpathSync.native`（realpath(3)）。
 * `broken` 与 `absent` 要分开：不存在的路径 shell 也加载不了、没东西可拦（见 checkPgExecScriptPath）；
 * 条目在但解析不了（悬空 / 自环）则按可疑拒绝。
 */
const probeShellPath = (workCwd: string, token: string): PathProbe => {
  const target = path.isAbsolute(token) ? token : `${workCwd}${path.sep}${token}`;
  try {
    return { kind: "resolved", real: realpathSync.native(target) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      try {
        lstatSync(target);
        return { kind: "broken" }; // 链接本身在、指向不存在的地方
      } catch {
        return { kind: "absent" };
      }
    }
    return { kind: "broken" };
  }
};

/** 两条已解析路径是不是同一个文件：realpath 相同，或 dev+ino 相同（硬链接 / 大小写不敏感文件系统上的大小写变体） */
const isSameFile = (a: string, b: string): boolean => {
  if (a === b) return true;
  try {
    const sa = statSync(a, { bigint: true });
    const sb = statSync(b, { bigint: true });
    return sa.ino !== 0n && sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
};

/**
 * 严格路径钳：命令头里的 pg-exec 脚本必须就是「仓内 scripts/pg-exec.mjs 的 realpath」（N8-01 余项，P3）。
 * 只看 basename 是 pg-exec.mjs 不够：`../outside/pg-exec.mjs`、绝对路径的仓外同名、工作区里的副本、
 * 指向仓外的符号链接、`jump/../` 物理回绕，实测全都放行并执行了别人的脚本。
 *
 * 取舍（刻意的，别「顺手」改严）：
 * - **存在则必须 realpath 严格相等**——硬链接（路径不同）也拒；不存在的路径放行：shell 同样加载不了它，
 *   没东西可拦（`node` 报 MODULE_NOT_FOUND）。不对「不存在」fail-closed，是因为那拦不住任何真实攻击
 *   （检查到执行之间的竞态对「存在 / 不存在」两种情形一样存在，没有写工具的旁路本来也造不出这个窗口），
 *   却会让 tests/readonly-bypass-guards.test.ts 等用假路径 `/repo/scripts/pg-exec.mjs` 钉 SQL 门的用例全红；
 * - 条目存在但解析不了（悬空链接 / 自环 / 无权限）→ 拒；可信脚本自己解析不了、而候选又存在 → 拒；
 * - 相对路径按**实际执行时的工作目录**（workCwd，已钳在 cwd 内）解析，不是校验时的 cwd。
 * 校验与执行之间的竞态（符号链接被换）无法在纯校验里消除：旁路没有写工具，且这条路径目前无生产调用方。
 */
const checkPgExecScriptPath = (
  workCwd: string,
  scriptToken: string,
  repoRoot: string,
): { ok: true } | { ok: false; reason: string } => {
  const probe = probeShellPath(workCwd, scriptToken);
  if (probe.kind === "absent") return { ok: true };
  const fail = (why: string): { ok: false; reason: string } => ({
    ok: false,
    reason: `旁路只读：pg-exec 脚本必须是仓内 scripts/pg-exec.mjs（${why}）。路径请写成提示词里给的那一条。`,
  });
  if (probe.kind === "broken") return fail("该路径是悬空链接 / 自环 / 无权限，解析不了");
  const trusted = probeShellPath(repoRoot, path.join(repoRoot, "scripts", "pg-exec.mjs"));
  if (trusted.kind !== "resolved") return fail("服务端找不到仓内 scripts/pg-exec.mjs，无法确认路径");
  if (probe.real !== trusted.real) {
    return fail("它解析到仓外 / 工作区副本 / 别的同名文件，只认仓内那一份的 realpath");
  }
  return { ok: true };
};

/** 通用脚本分支里：一律不许当「普通仓库脚本」去跑的受保护脚本（只能走上面的严格 pg-exec 语法） */
const GUARDED_SCRIPT_BASENAME_RE = /^(?:pg|ssh)-exec\.mjs$/;
const GUARDED_SCRIPT_NAMES = ["pg-exec.mjs", "ssh-exec.mjs"] as const;

/**
 * shell 通配符（`*` `?` `[…]`）的最后一段 → 正则，用来问「它能不能匹配到 pg-exec.mjs / ssh-exec.mjs」。
 * 没有通配符返回 null（走字面量判定）。一律按大小写不敏感匹配：bash 的通配是大小写敏感的，
 * 但在大小写不敏感的文件系统上别的写法也可能指到同一个文件，多匹配只会多拒、不会漏拒。
 * `[[:lower:]]` 这类 POSIX 字符类、没闭合的 `[` 处理得保守：前者当「任意单字符」（宁可多拒），后者 bash 当字面量。
 *
 * L4-01（第八轮）补两处有界化：能走到这里的含通配符 token 只可能在引号里（未加引号的通配符在字符白名单就被拒了），
 * 而引号内的内容长度不受限——
 *   - 超过 GLOB_PATTERN_MAX_LEN 的含通配符 token 不建正则、直接按「可能匹配」处理：20000 个 `*` 的 token 建出的正则
 *     V8 在 `.test` 时抛 `SyntaxError: Invalid regular expression … too large`（测试里实测，原先会一路抛出 validateReadonlyShellCommand）；
 *     受保护脚本名只有十几个字符，没有哪个合法的 `node 脚本 参数` 值得为它放行一个上千字符的通配串（代价：含 `?` / `*` 的超长引号参数会被误拒）；
 *   - 连续的 `*` 合并成一个：bash 里 `**` 在没开 globstar 时等价 `*`，而 `.*.*.*…x` 这类正则在匹配失败时的回溯次数随 `.*` 的个数按高次多项式增长。
 */
const GLOB_PATTERN_MAX_LEN = 1024;
const globBasenameRegex = (pattern: string): RegExp | null => {
  if (!/[*?[]/.test(pattern)) return null;
  if (pattern.length > GLOB_PATTERN_MAX_LEN) return /^.*$/;
  let re = "";
  let lastStar = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? "";
    const afterStar = lastStar;
    lastStar = false;
    if (ch === "*") {
      if (!afterStar) re += ".*";
      lastStar = true;
    } else if (ch === "?") {
      re += ".";
    } else if (ch === "[") {
      // `[]x]` / `[!]x]` 里紧跟开头的 `]` 是字面量，所以从 i+2 起找收尾
      let end = pattern.indexOf("]", i + 2);
      if (end === -1) {
        re += "\\[";
        continue;
      }
      let body = pattern.slice(i + 1, end);
      if (body.includes("[")) {
        // POSIX 字符类 `[:alpha:]` 自带一个 `]`，真正的收尾在后面；算不清就放宽成「任意单字符」
        const real = pattern.indexOf("]", end + 1);
        if (real === -1) {
          re += "\\[";
          continue;
        }
        end = real;
        re += ".";
        i = end;
        continue;
      }
      let neg = false;
      if (body.startsWith("!") || body.startsWith("^")) {
        neg = true;
        body = body.slice(1);
      }
      re += `[${neg ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&")}]`;
      i = end;
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
    }
  }
  try {
    return new RegExp(`^${re}$`, "i");
  } catch {
    // 构不出合法正则（极端畸形的范围）：当「可能匹配」处理——返回一个匹配一切的正则
    return /^.*$/;
  }
};

/**
 * 通用脚本分支（node / bash / sh）的「受保护脚本」拦截（N8-01 余项）：
 * 分派到 pg-exec 严格分支靠的是对**原始命令文本**的正则，文本里没有字面的 `pg-exec.mjs`
 * （`pg-exec"".mjs`、`PG-EXEC.MJS` 在大小写不敏感文件系统上、硬链接、预加载参数把它挤出「第一个非 flag 参数」）
 * 就落到通用脚本分支——那里只查「脚本在不在工作目录里」，于是 pg-exec / ssh-exec 在没有 SQL 门、没有 SSH 拒绝的
 * 情况下被原样执行（实测：`node scripts/pg-exec"".mjs --env t -- 'DELETE …'`、`node scripts/ssh-exec"".mjs …` 都放行并跑了）。
 * 这里对**所有**位置参数（含 `--flag=值` 的值部分）三重判定：
 *   ① 字面：basename 经 NFKC + 小写后是 pg-exec.mjs / ssh-exec.mjs（全角、大小写变体）；
 *   ② 身份：解析后与仓内两个受保护脚本是同一个文件（符号链接 / 硬链接 / 大小写不敏感 FS 的大小写变体）；
 *   ③ 展开：文本里没有字面名、shell 展开后却是它——通配符（`pg-exe?.mjs`、`pg-exec.m*`、`[p]g-exec.mjs`）、
 *      花括号（`{pg-exec,x}.mjs`、`scripts{/,x}pg-exec.mjs`）、`$` / 反引号。工作区就是 Flowship 仓时，
 *      `node scripts/pg-exe?.mjs --env t -- 'DELETE …'` 放行并跑了可信 pg-exec（没有 SQL 门；fuzz 实测）。
 * 命中即拒，返回命中的 token（用于文案）。
 *
 * L4-01（第八轮）之后第 ③ 条的前提变了：调用方先过 scanLocalCommandChars，未加引号的 `{ } * ? [ ] $` 在到这里之前就被拒，
 * 能走到这里的 token 里这些字符只可能在引号内，而 bash 对引号内的花括号 / 通配符不展开、当字面量。所以：
 *   - 删掉了原来的 `expandBraces`（递归、无逗号分支不扣预算：`node` 后接 2000 个 `{x}` 抛 `Maximum call stack size exceeded`，
 *     审查报告实证；现在任何输入都返回结果、不抛错）。引号内的花括号不再被展开判定——bash 本来就不展开，原先的多拒只是误杀；
 *   - 通配符判定（globBasenameRegex）和 `$` / 反引号判定保留，不动：它们对引号内的字面量仍然是「多拒不漏拒」，留作纵深，
 *     字符层白名单万一被改松，这里还有一道。
 */
const findGuardedScriptOperand = (
  operands: string[],
  workCwd: string,
  repoRoot: string,
): string | null => {
  const guarded: string[] = [];
  for (const name of GUARDED_SCRIPT_NAMES) {
    const p = probeShellPath(repoRoot, path.join(repoRoot, "scripts", name));
    if (p.kind === "resolved") guarded.push(p.real);
  }
  for (const raw of operands) {
    const eq = raw.indexOf("=");
    const candidate = raw.startsWith("-") ? (eq === -1 ? "" : raw.slice(eq + 1)) : raw;
    if (!candidate) continue;
    // `$` / 反引号：引号包着 shell 照样展开，展开结果在校验时不可知（`"${X:0:1}"` 这类切片能拼出任意文件名）→ 保守命中
    if (candidate.includes("$") || candidate.includes("`")) return raw;
    const base = candidate.split(/[\\/]/).pop() ?? candidate;
    const norm = base.normalize("NFKC").toLowerCase();
    if (GUARDED_SCRIPT_BASENAME_RE.test(norm)) return raw;
    // 通配符：文本里没有字面的 pg-exec.mjs，shell 展开后却会匹配到它
    const glob = globBasenameRegex(norm);
    if (glob && GUARDED_SCRIPT_NAMES.some((n) => glob.test(n))) return raw;
    const probe = probeShellPath(workCwd, candidate);
    if (probe.kind === "resolved" && guarded.some((g) => isSameFile(probe.real, g))) return raw;
  }
  return null;
};

/**
 * pg-exec 命令头（`--` 之前的部分）必须是严格语法：
 * `node <…/pg-exec.mjs> [--env|--user|--database <值> | --flag=值]*`（N8-01）。
 *
 * 为什么要严格：pg-exec 分支只要整条命令里出现 `…/pg-exec.mjs` 就进来，原先只查 SQL 与「横线开头的 flag」，
 * 头本身不要求以 node 开头——`NODE_OPTIONS="--require x.js" node pg-exec.mjs …`（环境变量前缀）、
 * `touch pwned pg-exec.mjs -- 'SELECT 1'`（头是任意命令）、甚至 `pg-exec.mjs` 只出现在 SQL 字符串里的
 * `git push … -- 'SELECT pg-exec.mjs'` 都能过校验、被 bash 原样执行。
 * 当前无调用方传 readOnly:true（潜伏），重新接线只读旁路前这道门必须在——所以有 tests/readonly-pg-exec-head.test.ts 钉住。
 * 入参是 splitShellTokens 切出来的 token（引号已剥）+ 头的原文（反斜杠只能在原文里查，token 里已被吞掉）；
 * 调用方已拦掉未加引号的拼接符、`#` 注释、括号、JS 与 bash 分词不一致的特殊空白（NBSP 等），以及 `$(` / 反引号。
 * 脚本路径是否就是仓内那一份见 checkPgExecScriptPath。
 */
const checkPgExecHead = (
  tokens: string[],
  rawHead: string,
): { ok: true } | { ok: false; reason: string } => {
  const fail = (why: string): { ok: false; reason: string } => ({
    ok: false,
    reason: `旁路只读：pg-exec 调用必须严格是 node "<…/pg-exec.mjs>" [--env/--user/--database <值>]（${why}）。`,
  });
  if (tokens.some((t) => PG_EXEC_HEAD_EXPANSION_RE.test(t) || t.startsWith("~"))) {
    return fail("参数里不允许 $ / 反引号 / 通配符 / ~，shell 会先展开它们");
  }
  // 反斜杠：bash 在双引号里只转义 `$ ` " \ 换行`，其余反斜杠原样保留；splitShellTokens 却一律吞掉，
  // 校验看到的路径与 shell 实际用的路径可能不是同一个——`"R/scripts/ev\/../pg-exec.mjs"` 在校验器眼里是
  // R/scripts/ev/../pg-exec.mjs（可信），bash 却走名为 `ev\` 的目录（可以是指向仓外的链接）再 `..`，
  // 落到仓外同名脚本（tests/readonly-pg-exec-head.test.ts Q15 用真 shell 复现）。头里没有任何合法用途，直接拒，
  // 必须查原文；Windows 路径请写正斜杠（Git Bash 认）
  if (rawHead.includes("\\")) {
    return fail("头里不允许反斜杠（shell 与校验器对 \\ 的解释不一致），路径请用正斜杠");
  }
  const [bin, script, ...rest] = tokens;
  if (!bin || !isTrustedPgExecNodeBin(bin)) {
    return fail("必须以裸 node（或系统目录下的 node 绝对路径）开头，不能带环境变量前缀、相对路径的 node、也不能换成别的命令");
  }
  if (!script || !PG_EXEC_SCRIPT_RE.test(script)) {
    return fail("node 后面必须直接跟 pg-exec.mjs");
  }
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i] ?? "";
    const eq = t.indexOf("=");
    const name = eq === -1 ? t : t.slice(0, eq);
    if (!PG_EXEC_VALUE_FLAGS.has(name)) return fail(`不认识的参数 ${t}`);
    if (eq !== -1) {
      if (eq === t.length - 1) return fail(`${name} 缺值`);
      continue;
    }
    const value = rest[i + 1];
    if (!value || value.startsWith("-")) return fail(`${name} 缺值`);
    i += 1; // 值已消费
  }
  return { ok: true };
};

export interface ReadonlyShellCheck {
  ok: boolean;
  reason?: string;
  workCwd?: string;
  timeoutMs?: number;
}

/**
 * 旁路只读 shell 校验（纯函数、可单测；默认拒绝）。
 * 允许：① pg-exec 只读查询；② 单条本地查看命令（文件参数钳在 cwd 内）；
 * ③ git 只读动词（status/log/diff/show/branch/rev-parse，看改动看分支）；
 * ④ 仓库脚本执行（node/bash/sh 跑仓内文件、npm/pnpm run|test，能跑不能改，部署发布类照拒）。
 * 其余一律拒绝并给跑法（ask-wait 刻意不放：子串匹配等于万能钥匙，见下）。
 */
export const validateReadonlyShellCommand = (
  cwd: string,
  command: unknown,
  workingDirectory: unknown,
  timeout: unknown,
  opts: ReadonlyShellOptions = {},
): ReadonlyShellCheck => {
  const rawCmd = typeof command === "string" ? command.trim() : "";
  if (!rawCmd) return { ok: false, reason: "command 不能为空" };
  // 可信脚本所在的「仓」：缺省 process.cwd()，与提示词里给 agent 的 pg-exec 路径同源（见 ReadonlyShellOptions）
  const repoRoot = opts.pgExecRepoRoot ?? process.cwd();
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
  if (hasPgExecToken(rawCmd)) {
    if (/(^|\s)--config(\s|=|$)/.test(rawCmd)) {
      return { ok: false, reason: "旁路只读：pg-exec 禁止 --config（用默认配置路径）；SQL 只允许 SELECT。" };
    }
    if (/ssh-exec\.mjs/.test(rawCmd)) {
      return { ok: false, reason: "旁路只读：远程 SSH 命令一律不跑，需要看服务端日志找任务所有者。" };
    }
    // 必须在下面用 `\s` 找 `--` 之前拦：NBSP / 全角空格等 JS 当空白、bash 不当的字符，会让校验与 shell 对 argv 的划分不一致
    if (hasUnquotedChars(rawCmd, PG_EXEC_UNQUOTED_ODD_SPACE)) {
      return {
        ok: false,
        reason:
          "旁路只读：pg-exec 调用里不允许未加引号的 NBSP / 全角空格 / U+2028 / BOM / \\v / \\f 等特殊空白（shell 不把它们当分隔符，实际参数与校验看到的不一致）；请只用普通空格或 tab。",
      };
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
    // 整条命令里不许有未加引号的换行 / 回车：`--` 与 SQL 之间的换行会被上面的 `.replace` 当成分隔空白吞掉，
    // 校验看到的是「头 + 一个单引号 SQL」，shell 实际在换行处把它截成两条命令（先跑一条没有 SQL 的 pg-exec，
    // 再把 `'SELECT 1'` 当命令名）。引号内的换行（多行 SQL）是数据、照常放行
    if (hasUnquotedChars(rawCmd, PG_EXEC_UNQUOTED_NEWLINE)) {
      return { ok: false, reason: "旁路只读：pg-exec 调用里不允许未加引号的换行（shell 会在换行处把命令截成两条）。" };
    }
    if (hasUnquotedChars(head, HEAD_UNQUOTED_DENY) || head.includes("$(")) {
      return {
        ok: false,
        reason:
          "旁路只读：pg-exec 调用部分不允许拼接其他命令、重定向，也不允许未加引号的 # 注释或括号（# 会把后面的 -- 'SQL' 整段吞掉）。",
      };
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
    // 命令头严格语法：只能是 `node <pg-exec.mjs> [--flag 值]*`（环境变量前缀 / 任意命令头一律拒，N8-01）
    const headVerdict = checkPgExecHead(headTokens, head);
    if (!headVerdict.ok) return { ok: false, reason: headVerdict.reason };
    // 脚本路径钳到「仓内 scripts/pg-exec.mjs 的 realpath」（按实际执行目录 workCwd 解析；N8-01 余项）
    const scriptVerdict = checkPgExecScriptPath(workCwd, headTokens[1] ?? "", repoRoot);
    if (!scriptVerdict.ok) return { ok: false, reason: scriptVerdict.reason };
    // SQL 必须独占一个带引号参数（防 `-- 'SELECT 1'; rm -rf /` 这类尾巴拼接），末尾分号允许
    const sqlArgMatch = /^\s*('([\s\S]*)'|"([\s\S]*)")\s*;?\s*$/.exec(sqlPartRaw);
    if (!sqlArgMatch) {
      return {
        ok: false,
        reason:
          "旁路只读：pg-exec 的 SQL 必须独占一个带引号参数，如 node \"<pg-exec>\" --env <环境> -- 'SELECT ...'（-- 后不许跟别的命令）。",
      };
    }
    const sqlInner = sqlArgMatch[2] ?? sqlArgMatch[3] ?? "";
    // 上面的正则是贪婪的：`'SELECT 1'; rm -rf x; 'SELECT 2'` 会被当成一个参数（内容含引号本身）。
    // 引号内不许再出现同种引号——否则 shell 实际会在中间收尾、后面是别的命令/拼接。
    const quote = sqlArgMatch[2] !== undefined ? "'" : '"';
    if (sqlInner.includes(quote)) {
      return {
        ok: false,
        reason: `旁路只读：SQL 参数内不能再出现 ${quote}（shell 会在此处结束引号）；SQL 含单引号请整体用双引号包，含双引号请整体用单引号包。`,
      };
    }
    // 双引号内 shell 仍会展开 `$VAR` / `\x` / 反引号：guard 看到的 SQL（如 `$USER$` 当作美元引用串）
    // 与数据库实际收到的不一致，可借此把多语句 / 写语句藏进「串」里。只放不会被 shell 改写的双引号内容。
    if (quote === '"' && /[$\\`]/.test(sqlInner)) {
      return {
        ok: false,
        reason:
          "旁路只读：双引号包裹的 SQL 里不允许 $ / \\ / 反引号（shell 会展开或转义）；请整体改用单引号包 SQL。",
      };
    }
    const sql = sqlInner.trim();
    if (!sql) return { ok: false, reason: "旁路只读：-- 后必须给 SQL。" };
    if (hasUnquotedChars(sqlPartRaw, SQL_UNQUOTED_DENY) || sqlPartRaw.includes("$(")) {
      return { ok: false, reason: "旁路只读：SQL 参数里不允许 &、|、`...` / $(...)。" };
    }
    const sqlVerdict = checkReadonlySql(sql);
    if (!sqlVerdict.ok) {
      const why =
        sqlVerdict.reason === "multi"
          ? "只允许单条语句（禁止用分号拼多条）"
          : sqlVerdict.reason === "unterminated"
            ? "SQL 里的引号 / 注释 / $$ 没有闭合"
            : sqlVerdict.reason === "empty"
              ? "SQL 为空"
              : sqlVerdict.reason === "func"
                ? "禁止带副作用 / 越权函数，如 pg_terminate_backend、pg_sleep、setval/nextval、pg_read_file、lo_*、dblink、set_config"
                : "禁止 INSERT/UPDATE/DELETE/DDL/SELECT INTO";
      return { ok: false, reason: `旁路只读：查库只允许单条 SELECT（${why}）。` };
    }
    return { ok: true, workCwd, timeoutMs };
  }
  if (/ssh-exec\.mjs/.test(rawCmd)) {
    return { ok: false, reason: "旁路只读：远程 SSH 命令一律不跑，需要看服务端日志找任务所有者。" };
  }
  // ---- 本地安全查看命令（单条、无拼接、无重定向、无命令替换）----
  // L4-01：下面的字符层白名单扫的是「交给 shell 的那串原文」去掉首尾空格 / tab / 换行之后的结果，不是 JS trim 之后的 rawCmd——
  // JS 的 trim 还会吞掉首尾的 CR / NBSP / BOM 等，而 bash 把它们当普通字符（`cat x<CR>` 实际参数是 `x\r`），校验看到的 token 就和 bash 的对不上。
  // pg-exec 分支沿用 rawCmd（它有自己的一套规则）。
  const localCmd = trimAsciiBlank(typeof command === "string" ? command : "");
  const tokens = splitShellTokens(localCmd);
  if (!tokens) return { ok: false, reason: "旁路只读：命令引号未闭合。" };
  if (tokens.length === 0) return { ok: false, reason: "command 不能为空" };
  const scanned = scanLocalCommandChars(localCmd);
  if (scanned !== null) return { ok: false, reason: scanned };
  // 下面三条在字符白名单之后基本是冗余的（白名单已拒未加引号的反引号 / `$` / 反斜杠，双引号里的 `$` ` `\` 也拒了），不再放松、留作纵深，
  // 同时保留它们的既有行为：单引号里的反引号 / `$(` 仍拒（放不放行都不会被执行，这里不放宽）；
  // 反斜杠 + 换行是续行（shell 把它删掉、把前后拼成一个词，而 splitShellTokens 把换行留在 token 里，字面名 / 身份判定会被绕开）；
  // 命令末尾的反斜杠（bash 3.2 把 `-c` 串末尾孤零零的 `\` 吞掉，splitShellTokens 却把它留在 token 里，bash 5 的处理又不一样，不赌版本）。
  if (hasSmuggledExecution(localCmd) || /\\[\r\n]/.test(localCmd) || localCmd.endsWith("\\")) {
    return {
      ok: false,
      reason: `旁路只读：不允许拼接、管道、重定向、` + "`...` / $(...)、反斜杠续行 / 末尾反斜杠。" + READONLY_SHELL_DENY_SUFFIX,
    };
  }
  // 要被 shell 真正执行的那个二进制只认「裸命令名」或「系统目录下的绝对路径」：`./node`、`../outside/node`、`/tmp/x/ls`
  // 的 basename 同样是 node / ls，原先按 basename 判定就放行，shell 实际执行的是工作区 / 仓外的那个文件（fuzz 实测）
  if (!isTrustedBinToken(tokens[0] ?? "")) {
    return {
      ok: false,
      reason:
        `旁路只读：命令必须以裸命令名（如 node / git / ls）或系统目录下的绝对路径开头，不能是工作区 / 相对 / 仓外路径的可执行文件（${tokens[0] ?? ""}）。` +
        READONLY_SHELL_DENY_SUFFIX,
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
    // 动词 = 前面只带白名单布尔旗标之后的第一个 token（L4-01 同类：原先跳过所有 `-` 开头的 token，`--namespace <值>` 的值被当成动词，见 GIT_LEADING_BOOL_FLAGS）
    let verbIdx = -1;
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i] ?? "";
      if (!t.startsWith("-")) {
        verbIdx = i;
        break;
      }
      if (!GIT_LEADING_BOOL_FLAGS.has(t)) {
        const shown = t.includes("=") ? t.slice(0, t.indexOf("=")) : t; // 不回显 = 之后的值
        return {
          ok: false,
          reason: `旁路只读：git 的前导选项 \`${shown}\` 不在白名单（动词之前只放 ${[...GIT_LEADING_BOOL_FLAGS].join(" / ")}）：带值的全局选项（--namespace / --attr-source / -c 等）会把后面的 token 当成它的值，校验看到的动词与 git 实际执行的不是同一个。`,
        };
      }
    }
    const verb = verbIdx === -1 ? undefined : tokens[verbIdx];
    if (!verb || !READONLY_GIT_VERBS.has(verb)) {
      return {
        ok: false,
        reason: `旁路只读：git 只允许 ${[...READONLY_GIT_VERBS].join(" / ")}（只读查看）。改分支、推代码、动线上分支找任务所有者。`,
      };
    }
    // `branch` 在动词表里是为了「看分支」，但 `git branch -D x` / `git branch newbranch` 会改 ref（L4-01）：只放行列表形态
    if (verb === "branch") {
      const why = checkGitBranchArgs(tokens.slice(verbIdx + 1));
      if (why !== null) return { ok: false, reason: why };
    }
    return { ok: true, workCwd, timeoutMs };
  }
  // ---- 仓库脚本执行：能跑不能改（只跑工作目录内的 repo 文件；部署发布类照拒）----
  if (SCRIPT_RUN_BINS.has(bin) || PKG_RUN_BINS.has(bin)) {
    // pg-exec / ssh-exec 不许借「普通仓库脚本」的名义跑（绕过文本分派的写法见 findGuardedScriptOperand）；
    // 要查库只能走上面的严格 pg-exec 语法。只对 node/bash/sh 查：cat/grep 读这两个脚本的源码不受影响
    if (SCRIPT_RUN_BINS.has(bin)) {
      const hit = findGuardedScriptOperand(tokens.slice(1), workCwd, repoRoot);
      if (hit) {
        return {
          ok: false,
          reason: `旁路只读：${hit} 是 pg-exec / ssh-exec 脚本（或含 $ / 反引号 / 通配符 / 花括号、展开后可能指到它们），不能当普通脚本跑。查库只能写成 node "<…/pg-exec.mjs>" --env <环境> -- 'SELECT …'，远程 SSH 一律不跑。`,
        };
      }
    }
    const r = checkBypassRunScript(root, cwd, bin, tokens);
    if (!r.ok) return { ok: false, reason: r.reason ?? READONLY_SHELL_DENY_SUFFIX };
    return { ok: true, workCwd, timeoutMs };
  }
  if (!READONLY_SAFE_BINS.has(bin)) {
    return { ok: false, reason: `旁路只读：不允许跑 ${tokens[0] ?? ""}。${READONLY_SHELL_DENY_SUFFIX}` };
  }
  // 文件参数钳在 cwd 内 + 凭据文件拦。
  // L4-01：ls / cat / head / tail / grep / wc 先按旗标白名单解析（布尔旗标 + 数字值；`-f` / `--file` / `--files0-from` / `--exclude-from`
  // 这类路径值选项一律拒，见 LOCAL_VIEW_SPECS），剩下的才是操作数；原先只是把「以 `-` 开头的 token」整体跳过，
  // 路径值选项的值要么被当成 pattern 跳过（`grep -f <凭据文件> x file`），要么粘在 `=` 后面根本没人看（`wc --files0-from=<凭据文件>`）。
  // echo / pwd 不在表里：它们不读文件，沿用「非 `-` 开头的 token 都是文件参数」——echo 与 ls / pwd / wc 一样走下面的路径钳制，
  // 所以 `echo 'cost$'` 会被「文件参数里不允许 $」拒掉；只有 grep 的 pattern 槽是 `$` 的唯一豁免。
  const viewSpec = LOCAL_VIEW_SPECS.get(bin);
  let operands: string[];
  let patternGiven = false;
  if (viewSpec) {
    const parsed = parseLocalViewArgs(bin, tokens.slice(1), viewSpec);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    operands = parsed.operands;
    patternGiven = parsed.patternGiven;
  } else {
    operands = tokens.slice(1).filter((t) => t && !t.startsWith("-"));
  }
  // grep 没有 -e 时第一个操作数是 pattern（不是文件参数，跳过它）
  const pathArgs = (bin === "grep" && !patternGiven ? operands.slice(1) : operands).filter((t) => t !== "");
  if ((bin === "cat" || bin === "tail" || bin === "head") && pathArgs.length === 0) {
    return { ok: false, reason: `旁路只读：${bin} 必须带工作目录内的文件参数。` };
  }
  if (bin === "grep" && !patternGiven && operands.length === 0) {
    return { ok: false, reason: "旁路只读：grep 必须带 pattern（文件参数只能在工作目录内）。" };
  }
  for (const arg of pathArgs) {
    if (arg.startsWith("~")) {
      return { ok: false, reason: "旁路只读：文件参数只能是工作目录内的相对路径。" };
    }
    // shell 会展开 $VAR / `...` / $(...)：引号包着也一样展开，文件参数里出现一律拒绝
    //（grep 的 pattern 已跳过，所以 "cost$" 这类 pattern 不受影响；echo 不跳过，见上）
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
const readonlyShellTool = (cwd: string, shellOpts: ReadonlyShellOptions = {}): ToolDefinition => {
  // 只读 shell 无条件摘 GitLab token 环境变量（见 shellTool 里 omitGitToken 的注释）
  const full = shellTool(cwd, { omitGitToken: true });
  const fullExecute = (
    full as unknown as { execute: (...args: unknown[]) => Promise<unknown> }
  ).execute.bind(full);
  return asTool({
    ...(full as unknown as Record<string, unknown>),
    name: "shell",
    label: "跑命令（只读）",
    description:
      "旁路 shell（能跑不能改）：pg-exec 只读查询（SELECT）；ls/cat/tail/head/grep/wc/pwd/echo 本地查看（工作目录内）；git 只读查看（status/log/diff/show/branch/rev-parse）；跑仓库脚本（node/bash/sh + 工作目录内文件，npm/pnpm run|test）。不允许拼接/管道/重定向，不改文件，不跑部署发布类脚本，不调远程、不发请求，线上分支相关找任务所有者。合 test MR 调 merge_test_mr。timeout 为秒，默认 60。",
    execute: async (...args: unknown[]) => {
      const params = (args[1] ?? {}) as {
        command?: unknown;
        timeout?: unknown;
        workingDirectory?: unknown;
      };
      const checked = validateReadonlyShellCommand(cwd, params.command, params.workingDirectory, params.timeout, shellOpts);
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

/**
 * 子 agent 执行回调：入参已解析好（prompt / 类型 / 原始 model / effort），
 * signal 是父工具调用的取消信号（父会话被停时中止子会话）。
 * 用法错误（model / effort 无效）抛 SubagentUsageError，其它异常算子会话失败。
 */
export type SubagentRunner = (
  request: SubagentRequest,
  signal: AbortSignal | undefined,
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
      _toolCallId: string,
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
        out = await runSubagent(parsed.request, signal);
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
 * 只读轮次的 customTools：read（凭据文件守卫 + 目录钳制）/ grep·glob（基址钳制）+ 只读 shell
 *（纯函数白名单校验：查数据、看改动、跑仓内脚本）+ merge_test_mr（服务端执行、只合 test 分支）。
 * 不推进、不改文件；查数据（pg-exec SELECT、读本地日志）、跑测试查看脚本是允许的操作。
 * 写类（write/edit/delete）、子代理 task、系统工具、MCP 全不给；裸 shell 不给，只给校验版。
 * 白名单数组（custom-agent-backend 的 tools 白名单与这里保持一致）。
 * 注：旁路 honor-system 后不再走本数组（两端默认全开），此处转单元覆盖留着，哪天收紧直接接回去。
 */
export const READONLY_CUSTOM_TOOL_NAMES = [
  "read",
  "grep",
  "glob",
  "shell",
  "merge_test_mr",
] as const;
export const buildReadOnlyToolDefs = (
  cwd: string,
  spill?: ModelBudgetSpill,
  /** 只读 shell 的校验选项（测试注入「仓」根；生产不传，缺省与提示词给的 pg-exec 路径同源） */
  shellOpts: ReadonlyShellOptions = {},
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
    withModelBudget(readonlyShellTool(cwd, shellOpts), spill),
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
