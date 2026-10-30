/**
 * Cursor 路径的子代理工具 `subagent`（Flowship 自有，与 pi 的 `task` 同参同语义）
 *
 * # 为什么要自己做
 * Cursor SDK 的原生 `task` 子代理在本地运行**固定用 composer 系**：
 *   - `AgentOptions.agents[x].model` 类型上有，但本地运行里被忽略（2026-10-13 实测：声明
 *     `claude-sonnet-5-5`，SDK 下发的 task 调用 model 仍是 `composer-2.5-fast`，子代理自述 Composer）；
 *   - `task` 的入参也没有 effort。
 * 所以模型 / effort 想自己定，只能 Flowship 自己起子 agent：`local.customTools` 里挂一个工具，
 * 工具回调里 `Agent.create` 一个嵌套子 agent（模型 / effort 由入参决定）、跑完把最终文本当工具结果返回。
 *
 * # 实测过的前提（2026-10-13，真实 Cursor SDK 1.0.37，composer-2.5 当父、claude-sonnet-5-5 当子）
 * 1. 自定义工具回调可以同步阻塞很久：75s / 330s 都正常返回，没有 MCP 那个 ~60s 超时
 *    （所以不需要 ask_user 那套「立刻返回 + shell curl 长轮询」）。
 * 2. 回调里可以直接嵌套 `Agent.create`，子 agent 用 `claude-sonnet-5-5` + `reasoning_effort=low`
 *    跑通；`RunResult.model` 回读出的就是请求的模型和参数。
 * 3. 同一轮里并行发起多个自定义工具调用是并行执行的（两个 20s 的调用总共 20s）。
 * 4. **取消不联动**：父 `run.cancel()` 后，回调拿不到 AbortSignal（`SDKCustomToolContext` 里没有），
 *    子 agent 会一直跑到自然结束（实测 shell 子进程 sleep 活到结束、白烧 token）。所以必须自己联动：
 *    每个父 agent 实例一个 link，记着在跑的子 run；覆盖父 `run.cancel()` / `close()` /
 *    `[Symbol.asyncDispose]()`，先取消子 run 再放行。实测联动后子 run 立即 CANCELLED、
 *    回调立即结束、子 shell 进程也跟着没了。
 *
 * # 范围（用户拍板）
 * - 只能选**当前 provider（Cursor）**的模型；缺省 / inherit = 沿用父会话当前模型（含其思考档）。
 * - fast 变体不在代码里拦，也不再有规则约束（原 `.cursor/rules/subagent-no-fast.mdc` 已按用户要求删除）；
 *   模型怎么选完全由调用方（用户 / 模型）决定，缺省 inherit 沿用父会话模型。
 * - **挂了 `subagent` 就关掉原生 `task`**（`withNativeTaskDisabled`，由 agent-backend 在挂工具时加进
 *   `disallowedTools`）：原生 `task` 在本地运行固定用 composer 系、选不了模型，留着只会让模型
 *   顺手选到它、子任务悄悄降级成另一个模型（2026-10-13 用户会话里实际发生过）。
 *   没挂 `subagent` 的会话（一次性调用 / 受限答疑 / 只读轮次）不动——它们本来就不派子代理。
 *   原生 `task` 的 `fork` 等这里**没有**对应物（用户确认不需要）；`resume`、`run_in_background` 见下。
 *
 * # run_in_background（后台运行，只在 chat 会话开）
 * 主 AI 派出几个子代理后，用户要能继续和它聊别的。工具回调是阻塞的，主 AI 被卡在里面，
 * 用户的话（排队 / 「立即发送」steer 都一样）要等子代理全返回才到得了主 AI——所以子代理要能放后台：
 *   - 主 AI 传 `run_in_background=true`：建好子 agent、发出任务后**立刻返回**，子代理在后台干；
 *   - 用户插话时，正在前台等的子代理**自动转后台**（`control.detachForeground()`，chat-runner 在 steer 时调），
 *     工具回调立刻返回、主 AI 马上读到用户的话；
 *   - 后台子代理收尾 → 经 `subagent-background` 的 hub 通知 chat-runner，由它把结果作为一条消息送回主 AI。
 * 取消口径不变：父 run 被取消 / 会话被关（含停止键、任务删除、应用退出）一律连后台子代理一起取消；
 * 父这一轮**自然结束**不取消——后台子代理活过这一轮，正是它的意义。
 * 护栏：同时在跑的后台子代理有上限、单个后台子代理有最长运行时间（超时按失败收尾并取消）。
 *
 * # resume（接着之前某个子代理继续）
 * 每个成功的子代理结果末尾带上它的 `agentId`；之后再调本工具传 `resume: <agentId>`，
 * 用 `Agent.resume` 接上同一个子 agent——它记得之前的全部上下文，省得每次重讲背景。
 *   - 范围：只能接**本父会话派出的**（登记表按父 agentId 分桶，进程内存，应用重启 / 父会话换了新 agent
 *     就接不上，报清楚的错、让模型另起一个）。不按「任何 agentId 都能 resume」做——模型能传任意字符串，
 *     那样等于能把别的任务 / 别的会话的 agent 当子代理接上。
 *   - 模型 / effort / 子代理类型沿用当初的，填了不一致的直接报错（不静默忽略）。
 *   - 同一个子代理同时只允许一个 run（resume 时占位，跑完释放）。
 *   - 登记表挂 globalThis（Next 多个路由 chunk 各 import 一份模块也共用）、有容量上限。
 *
 * # 子 agent 的边界
 * 不带系统工具（submit_work / ask_user…）、不带用户 MCP、不带 `subagent`/`task`——防递归与副作用。
 * explore = 只读白名单（read / grep / glob / ls）；其余 = 默认内置工具、去掉 `task`。
 */

import { randomUUID } from "node:crypto";

import { Agent as CursorAgent } from "@cursor/sdk";
import type { ModelSelection, SDKCustomTool, ToolName } from "@cursor/sdk";

import type { BackgroundSubagentJobView } from "@/lib/background-subagents";
import { withoutHiddenModelSelection } from "@/lib/model-params";
import {
  catalogDefaultEffort,
  catalogFromModelOptions,
  currentEffortValue,
  formatModelCatalog,
  normalizeSubagentType,
  parseSubagentRequest,
  resolveSubagentModel,
  SUBAGENT_INPUT_JSON_SCHEMA,
  SUBAGENT_TOOL_DESCRIPTION,
  SubagentUsageError,
  subagentNeedsCatalog,
  wantsModelList,
  type ModelCatalogEntry,
  type SubagentModelSelection,
  type SubagentRequest,
} from "@/lib/subagent-spec";

import { getCachedModelOptions, listModelOptions } from "./model-catalog";
import { withCursorJsonlStore } from "./sdk-agent-store";
import {
  SDK_CREATE_RESUME_TIMEOUT_MS,
  SDK_SEND_TIMEOUT_MS,
  withSdkDeadline,
} from "./sdk-deadline";
import {
  emitBackgroundSubagentJobsChanged,
  emitBackgroundSubagentSettled,
  formatDuration,
  setSubagentSessionControl,
  SUBAGENT_TRAILER_PREFIX,
  type BackgroundSubagentEvent,
  type SubagentSessionControl,
} from "./subagent-background";
import {
  setSubagentDisplayLookup,
  setSubagentParentModel,
} from "./subagent-parent-model";
import type { SubagentRunHandle, SubagentRunInit } from "./subagent-transcript";

/** explore（只读）：读 / 搜，不写文件、不跑命令（与 pi 的 read/grep/find/ls 对齐） */
export const CURSOR_SUBAGENT_READONLY_TOOLS: ToolName[] = [
  "read",
  "grep",
  "glob",
  "ls",
];

/**
 * 工具说明：共用文案 + Cursor 特有的两点（可并行；resume）。
 * 原生 task 已被关掉（见头注释），所以这是本会话里派子代理的唯一入口，不再需要「与原生 task 的区别」。
 */
export const CURSOR_SUBAGENT_DESCRIPTION =
  SUBAGENT_TOOL_DESCRIPTION +
  "同一轮里可以并行发起多个本工具调用（并行执行）。" +
  "每次成功返回的末尾会给出这个子代理的 id；之后想让同一个子代理接着做（追问、补充、让它改刚才的结果），" +
  "再调本工具并传 resume=<该 id>：它记得之前的全部上下文，不用重讲背景；此时 model / effort / subagentType 沿用原来的、不要再填。" +
  "只能接着本会话里派出的子代理；换了话题或需要不同模型就另起一个新的（不传 resume）。";

/** Cursor 专用入参 schema：共享 schema + resume（pi 的 `task` 没有这个字段，共享 schema 保持与它一致） */
export const CURSOR_SUBAGENT_INPUT_JSON_SCHEMA = {
  ...SUBAGENT_INPUT_JSON_SCHEMA,
  properties: {
    ...SUBAGENT_INPUT_JSON_SCHEMA.properties,
    resume: {
      type: "string",
      description:
        "接着之前某个子代理继续：填它上次结果末尾给出的 id。此时不要再填 model / effort / subagentType",
    },
  },
} as const;

/** 后台运行的护栏默认值：同时在跑的后台子代理数 / 单个后台子代理最长运行时间 */
export const BACKGROUND_SUBAGENT_MAX_CONCURRENT = 4;
export const BACKGROUND_SUBAGENT_MAX_RUNTIME_MS = 30 * 60 * 1000;
/**
 * 超时 cancel 之后给「子 run 收尾」的宽限：到点还没收尾就强制收尾（R14 Q11b-03）。
 * SDK 的 `cancel()` 自己可能抛 / 被忽略 / 挂死——只发一次 cancel 就指望流会结束，job 就会永远留在表里：
 * 占后台名额（4 个挂死后再也派不了）、占 resume 的 busy、让会话永不被空闲回收、侧栏一直转圈。
 */
export const BACKGROUND_SUBAGENT_CANCEL_GRACE_MS = 30_000;
/** 发给 SDK 的 cancel / close 自己的硬上限：超过就放弃等待，收尾不能被它们拖住 */
const SUBAGENT_SDK_CANCEL_DEADLINE_MS = 30_000;
const SUBAGENT_SDK_CLOSE_DEADLINE_MS = 30_000;
/**
 * 前台已跑过头（超过上限）才转后台时的最短剩余时间：不立刻掐（给 1 秒），
 * 但也不再多给一个完整的上限。maxRuntimeMs 比它还小（测试注入的小数值）时取 maxRuntimeMs 本身。
 */
const BACKGROUND_MIN_REMAINING_MS = 1_000;

/** 开了后台运行的会话：在基础说明后追加的一段（数字取自本 link 实际生效的护栏） */
export const cursorSubagentBackgroundNote = (limits: {
  maxConcurrent: number;
  maxRuntimeMs: number;
}): string =>
  "run_in_background=true：派出后立刻返回（给你一个后台任务 id），子代理在后台干活，做完后系统会把它的输出作为一条消息发给你——" +
  "适合与你接下来的工作无关、耗时较长的独立子任务，这样你可以继续回应用户或做别的事；" +
  "你自己要拿到它的结果才能往下走的任务不要放后台（直接等它返回）。" +
  `同时最多 ${limits.maxConcurrent} 个后台子代理，每个最长跑 ${Math.round(limits.maxRuntimeMs / 60000)} 分钟。` +
  "你正在前台等的子代理，遇到用户插话时会自动转到后台继续跑——所以不必为了「怕用户插话」而特意放后台。" +
  "后台结果到达前不要编造它的内容；用户问起进度就如实说「还在跑」。";

/** 开了后台运行的会话用的入参 schema：基础 schema + run_in_background */
export const CURSOR_SUBAGENT_INPUT_JSON_SCHEMA_WITH_BACKGROUND = {
  ...CURSOR_SUBAGENT_INPUT_JSON_SCHEMA,
  properties: {
    ...CURSOR_SUBAGENT_INPUT_JSON_SCHEMA.properties,
    run_in_background: {
      type: "boolean",
      description:
        "true = 后台运行：立刻返回，做完后系统把输出作为一条消息发给你；省略 / false = 等它做完返回结果",
    },
  },
} as const;

/**
 * 原生 `task` 在 Flowship 里一律关掉：挂了 `subagent` 工具的会话把它加进 `disallowedTools`。
 * 已有的 disallowedTools 原样保留（去重）。SDK 的 `disallowedTools` 不持久化，
 * create / resume 每次都要传——调用方（agent-backend 的 attachFlowshipTools）两条路径都走它。
 */
export const withNativeTaskDisabled = (
  existing: readonly ToolName[] | undefined,
): ToolName[] =>
  existing?.includes("task") ? [...existing] : [...(existing ?? []), "task"];

// ----------------- 依赖（可注入，单测不碰真实 SDK） -----------------

/** 子 run 的最小形状（真实 SDK 的 Run 是它的超集） */
export interface SubagentChildRun {
  stream(): AsyncIterable<unknown>;
  wait(): Promise<{
    status: string;
    result?: string;
    error?: { message?: string } | null;
  }>;
  cancel(): Promise<void>;
}

/** 子 agent 的最小形状（真实 SDK 的 SDKAgent 是它的超集） */
export interface SubagentChildAgent {
  /** SDK 分配的 agent id；有它才能登记成可 resume 的子代理、结果里才给模型这个 id */
  agentId?: string;
  send(prompt: string): Promise<SubagentChildRun>;
  close?: () => unknown;
}

/** 记录器工厂（装配层把 taskId / provider 绑好）：子代理工具只管给内容 */
export interface SubagentTranscriptSink {
  start: (init: Omit<SubagentRunInit, "taskId" | "provider">) => SubagentRunHandle;
}

export interface CursorSubagentDeps {
  /** 父会话当前模型（inherit 的基线）；没有 = 父会话没显式选模型 */
  parentModel?: SubagentModelSelection;
  /** 当前 provider 的模型目录；拿不到返回 null（此时不校验 model id） */
  loadCatalog: () => Promise<ModelCatalogEntry[] | null>;
  /**
   * 同步偷看「已缓存」的模型目录（不发网络请求、没缓存返回 null）。只给展示用：卡片徽标 /
   * 过程记录要写「该模型的默认 effort」，而这个时机往往还没人拉过目录（纯沿用不拉）。
   * 不提供 = 只用本 link 之前 loadCatalog 成功拿到过的那份。
   */
  peekCatalog?: () => ModelCatalogEntry[] | null;
  /** 起子 agent；model 为空 = 沿用 SDK 默认（仅父会话没选模型且 inherit 时） */
  createChild: (opts: {
    model?: SubagentModelSelection;
    explore: boolean;
  }) => Promise<SubagentChildAgent>;
  /**
   * 接上之前派出的子 agent（`Agent.resume`）。模型 / explore 用当初登记的——
   * `tools` / `disallowedTools` 都不持久化，resume 必须原样再传一遍。
   * 不提供 = 这个环境不支持 resume（工具会明确报错）。
   */
  resumeChild?: (opts: {
    agentId: string;
    model?: SubagentModelSelection;
    explore: boolean;
  }) => Promise<SubagentChildAgent>;
  /**
   * 开启后台运行（`run_in_background` + 用户插话自动转后台）。不提供 = 一律前台、
   * 工具不带该参数（task 模式 / 一次性调用 / pi 都不提供）。
   */
  background?: {
    /** 一个后台子代理收尾（完成 / 失败 / 取消）时调；不得抛（抛了只告警） */
    onSettled: (evt: BackgroundSubagentEvent) => void;
    /**
     * 后台子代理的集合变了（有一个转入后台 / 有一个收尾）时调，之后 `control.backgroundJobs()` 读到的就是新清单。
     * 界面据此画「子代理在后台干活」条。不得抛（抛了只告警、不影响子代理收尾）。
     */
    onJobsChanged?: () => void;
    /** 同时在跑的后台子代理上限，缺省 {@link BACKGROUND_SUBAGENT_MAX_CONCURRENT} */
    maxConcurrent?: number;
    /** 单个后台子代理最长运行时间，缺省 {@link BACKGROUND_SUBAGENT_MAX_RUNTIME_MS}；超时取消并按失败收尾 */
    maxRuntimeMs?: number;
    /**
     * 超时取消之后的宽限：到点子 run 还没收尾（cancel 失败 / 被忽略 / 流挂死）就强制按失败收尾，
     * 缺省 {@link BACKGROUND_SUBAGENT_CANCEL_GRACE_MS}
     */
    cancelGraceMs?: number;
  };
  /**
   * 子代理过程记录（详情面板用：任务书全文 + 子代理自己的 thinking / 工具调用 / 回复）。
   * 不提供 = 不记（单测 / 没有 taskId 的一次性调用）。记录器**绝不能影响子代理本身**：
   * start 抛错只告警、当没记；句柄的方法这里也都包了 try/catch。
   */
  transcripts?: SubagentTranscriptSink;
  /**
   * 父 run 被取消 / 会话被关（`run.cancel()` / `close()` / `asyncDispose`，即 {@link SubagentLink.cancelAll}）时
   * 同步调一次——给「同样拿不到取消信号、需要被叫醒」的兄弟工具（`wait`）搭便车，省得它再包一层 Proxy。
   * 不得抛（抛了只告警，不影响取消本身）。
   */
  onParentCancel?: () => void;
}

export interface SubagentLink {
  /** 挂进 `local.customTools` 的工具 */
  tool: SDKCustomTool;
  /** 给父 agent 接上取消联动（覆盖 send 返回的 run.cancel / close / asyncDispose）；返回同一对象 */
  attach: <A extends object>(agent: A) => A;
  /** 取消所有在跑的子 run（父 run 被取消 / 会话被关时调） */
  cancelAll: () => Promise<void>;
  /** 会话级控制面（转后台 / 后台计数）；也登记在 attach 返回的 agent 上，chat-runner 经它取 */
  control: SubagentSessionControl;
}

const CANCELLED_TEXT = "子任务已取消";

const noop = (): void => {};

const toText = (v: unknown): string => {
  if (!v || typeof v !== "object") return "";
  const content = (v as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const c of content) {
    if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") {
      out += (c as { text: string }).text;
    }
  }
  return out;
};

/** 子 run 终态不是 finished 时给模型看的原因 */
const describeRunFailure = (res: {
  status: string;
  error?: { message?: string } | null;
}): string => {
  const detail = res.error?.message?.trim();
  return detail ? `${res.status}：${detail}` : res.status;
};

const textResult = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError ? { isError: true } : {}),
});

// ----------------- 可 resume 的子代理登记表 -----------------

/** 一个能被 resume 的子代理（只在本进程内记） */
interface ResumableChild {
  /** 当初解析出的模型（含思考档）；undefined = 当初沿用 SDK 默认（父会话没显式选模型） */
  model?: SubagentModelSelection;
  /** 当初是不是只读（explore）——`tools` 白名单不持久化，resume 要原样再传 */
  explore: boolean;
  /** 正在跑：同一个子代理同时只允许一个 run */
  busy: boolean;
}

/** 登记表容量：最多记这么多个父会话 / 每个父会话最多这么多个子代理（超出按最久未用淘汰，防泄漏） */
export const RESUMABLE_PARENTS_MAX = 64;
export const RESUMABLE_CHILDREN_PER_PARENT_MAX = 32;

type ResumableRegistry = Map<string, Map<string, ResumableChild>>;
type RegistryHolder = typeof globalThis & {
  __flowshipSubagentResumables?: ResumableRegistry;
};

/** 挂 globalThis：Next 的多个路由 chunk 各 import 一份本模块时共用同一张表（与 sdk-agent-store 同理） */
const registry = (): ResumableRegistry => {
  const g = globalThis as RegistryHolder;
  g.__flowshipSubagentResumables ??= new Map();
  return g.__flowshipSubagentResumables;
};

/** 仅测试：清空登记表 */
export const __resetSubagentResumablesForTests = (): void => {
  (globalThis as RegistryHolder).__flowshipSubagentResumables = undefined;
};

/** 仅测试：当前登记了哪些子代理 id（按父会话） */
export const __resumableChildIdsForTests = (parentKey: string): string[] => [
  ...(registry().get(parentKey)?.keys() ?? []),
];

/** 取父会话名下的子代理表；顺手把这个父会话标成「最近用过」（Map 的插入序当 LRU） */
const childrenOf = (
  parentKey: string,
  create: boolean,
): Map<string, ResumableChild> | undefined => {
  const reg = registry();
  const found = reg.get(parentKey);
  if (found) {
    reg.delete(parentKey);
    reg.set(parentKey, found);
    return found;
  }
  if (!create) return undefined;
  const fresh = new Map<string, ResumableChild>();
  reg.set(parentKey, fresh);
  while (reg.size > RESUMABLE_PARENTS_MAX) {
    const oldest = reg.keys().next().value;
    if (oldest === undefined) break;
    reg.delete(oldest);
  }
  return fresh;
};

const rememberChild = (
  parentKey: string,
  childId: string,
  info: ResumableChild,
): void => {
  const children = childrenOf(parentKey, true)!;
  children.delete(childId);
  children.set(childId, info);
  while (children.size > RESUMABLE_CHILDREN_PER_PARENT_MAX) {
    const oldest = children.keys().next().value;
    if (oldest === undefined) break;
    children.delete(oldest);
  }
};

const forgetChild = (parentKey: string, childId: string): void => {
  registry().get(parentKey)?.delete(childId);
};

/** 模型的一行描述（结果末尾给模型 / 用户看实际用了什么）：`id (param=value, …)` */
const describeChildModel = (model: SubagentModelSelection | undefined): string => {
  if (!model) return "SDK 默认模型";
  const params = (model.params ?? []).map((p) => `${p.id}=${p.value}`);
  return params.length > 0 ? `${model.id} (${params.join(", ")})` : model.id;
};

/**
 * 成功结果末尾附的一段：这个子代理的 id + 实际用的模型 + 怎么接着做。
 * 给模型看（它才知道 id、才知道能 resume），也给用户看（展开卡片能看到实际模型，不再只有 inherit）。
 * 开头用 {@link SUBAGENT_TRAILER_PREFIX}：后台结果超长截断时，`subagent-background` 靠它认出这段并整段保住
 * （可 resume 的 id 只在这里，被截掉就接不上了）——改格式时两边要一起看。
 */
export const formatSubagentTrailer = (opts: {
  agentId: string;
  model?: SubagentModelSelection;
}): string =>
  `${SUBAGENT_TRAILER_PREFIX}${opts.agentId} · ${describeChildModel(opts.model)}] ` +
  `想让它接着做：再调用 subagent 并传 resume="${opts.agentId}"` +
  "（它记得刚才的全部上下文；model / effort / subagentType 沿用原来的，不要再填）。";

/**
 * 每个父 agent 实例建一个 link：工具闭包、在跑的子 run 集合、取消代数都绑在这个实例上
 *（不按 agentId 全局存——恢复会话的新旧实例 agentId 相同，全局按 id 存会互相误杀）。
 */
export const createCursorSubagentLink = (
  deps: CursorSubagentDeps,
): SubagentLink => {
  const live = new Set<SubagentChildRun>();
  /**
   * 取消代数：cancelAll 每调一次 +1。工具回调开头记一份，每个 await 之后对一下——
   * 变了说明父 run 在这期间被取消了（回调拿不到 AbortSignal，只能这样接力），
   * 补取消刚起好的子 run 并退出，不留孤儿。永久标志位不行：同一个 agent 的下一轮还要能正常派子任务。
   */
  let generation = 0;

  /**
   * 登记表里这个父会话的桶 key：attach 之前是个随机占位，attach 后换成父 agent 的 id——
   * 同一个持久化会话被恢复成新实例时 agentId 不变，新 link 能接着看到之前派出的子代理。
   */
  let parentKey = `link:${randomUUID()}`;

  // ----------------- 展示用：子代理实际生效的 effort -----------------
  // 不传 effort 时子代理走该模型自己的默认档，目录里有（isDefault 预设）。卡片徽标 / 过程记录把它写出来，
  // 而不是留空。目录只在「显式选模型」时才会拉（纯沿用不为此多一次网络往返），所以这里额外记住拉到过的那份当兜底；
  // 平时优先偷看进程里已缓存的（peekCatalog，新鲜优先），缓存没有 / 过期才用记住的。全程同步、不发请求——事件流热路径要用。
  let catalogMemo: ModelCatalogEntry[] | null = null;
  const loadCatalog = async (): Promise<ModelCatalogEntry[] | null> => {
    const catalog = await deps.loadCatalog();
    if (catalog) catalogMemo = catalog;
    return catalog;
  };
  const peekCatalogSafe = (): ModelCatalogEntry[] | null => {
    // 进程缓存（peekCatalog）优先：它有 10 分钟 TTL、会随目录刷新；link 记住的那份只在缓存过期 / 没有时兜底，
    // 否则长会话里目录变了，卡片会一直用第一次拉到的旧默认档
    try {
      const fresh = deps.peekCatalog?.();
      if (fresh) return fresh;
    } catch {
      /* 只是展示用，偷看失败当没有、退回记住的那份 */
    }
    return catalogMemo;
  };
  const defaultEffortOf = (modelId: string): string | undefined =>
    catalogDefaultEffort(peekCatalogSafe(), modelId);
  /** 一个子代理实际生效的 effort：显式 / 沿用的档位参数优先，没有再用该模型的默认档 */
  const effectiveEffortOf = (
    model: SubagentModelSelection | undefined,
  ): string | undefined =>
    model
      ? (currentEffortValue(model.params) ?? defaultEffortOf(model.id))
      : undefined;
  /** resume 卡片徽标：接着的子代理当初用的模型 / 档位（登记表里没有 → undefined，不硬造） */
  const resumedChildOf = (
    agentId: string,
  ): { model?: string; effort?: string } | undefined => {
    const model = childrenOf(parentKey, false)?.get(agentId)?.model;
    if (!model) return undefined;
    const effort = effectiveEffortOf(model);
    return { model: model.id, ...(effort ? { effort } : {}) };
  };

  const cancelAll = async (): Promise<void> => {
    generation += 1;
    // 先于等子 run 取消：兄弟工具（wait）的唤醒是同步的、不该排在子 run 的取消后面
    try {
      deps.onParentCancel?.();
    } catch (err) {
      console.warn(
        "[cursor-subagent] onParentCancel 抛错（已忽略）：",
        err instanceof Error ? err.message : err,
      );
    }
    await Promise.allSettled([...live].map((r) => r.cancel()));
  };

  /**
   * resume 入口检查 + 占位（**同步**：查表和置 busy 之间不能有 await，否则同一个子代理会被并发 resume）。
   * 任何不满足的情形都抛 SubagentUsageError（工具层原样回给模型、让它改对），不静默回退成「另起一个新的」。
   */
  const claimResumable = (
    req: SubagentRequest,
    rawSubagentType: string | undefined,
  ): { id: string; info: ResumableChild } => {
    const id = req.resume!;
    const info = childrenOf(parentKey, false)?.get(id);
    if (!info) {
      throw new SubagentUsageError(
        `找不到子代理「${id}」：resume 只能接着本会话里、本次应用运行期间派出的子代理（应用重启、或会话换了新的 agent 之后就接不上了）。去掉 resume，把需要的背景写进 prompt 另起一个新的。`,
      );
    }
    const wantedModel = req.model?.trim().toLowerCase();
    if ((wantedModel && wantedModel !== "inherit") || req.effort?.trim()) {
      throw new SubagentUsageError(
        "resume 时 model / effort 沿用这个子代理原来的，不能改；去掉它们。要换模型就不要 resume，另起一个新的子代理。",
      );
    }
    if (
      rawSubagentType &&
      (normalizeSubagentType(rawSubagentType) === "explore") !== info.explore
    ) {
      throw new SubagentUsageError(
        `resume 时 subagentType 沿用原来的（${info.explore ? "explore 只读" : "可读写"}），与你填的不一致；去掉 subagentType，或不要 resume、另起一个。`,
      );
    }
    if (info.busy) {
      throw new SubagentUsageError(
        `子代理「${id}」还在运行，等它返回后再 resume。`,
      );
    }
    info.busy = true;
    return { id, info };
  };

  /** 接上之前的子 agent；SDK 那边接不上（会话记录被 GC 清了等）→ 忘掉这条登记、给模型一句能照做的话 */
  const openResumed = async (
    id: string,
    model: SubagentModelSelection | undefined,
    explore: boolean,
  ): Promise<SubagentChildAgent> => {
    if (!deps.resumeChild) {
      throw new SubagentUsageError(
        "这个环境不支持 resume；去掉 resume，把需要的背景写进 prompt 另起一个新的子代理。",
      );
    }
    try {
      return await deps.resumeChild({ agentId: id, model, explore });
    } catch (err) {
      forgetChild(parentKey, id);
      const msg = err instanceof Error ? err.message : String(err);
      throw new SubagentUsageError(
        `无法接着子代理「${id}」（它的会话记录可能已被清理）：${msg}。去掉 resume，把需要的背景写进 prompt 另起一个新的。`,
      );
    }
  };

  // ----------------- 后台运行（见文件头「run_in_background」） -----------------

  const bg = deps.background;
  const maxConcurrent = bg?.maxConcurrent ?? BACKGROUND_SUBAGENT_MAX_CONCURRENT;
  const maxRuntimeMs = bg?.maxRuntimeMs ?? BACKGROUND_SUBAGENT_MAX_RUNTIME_MS;
  const cancelGraceMs = bg?.cancelGraceMs ?? BACKGROUND_SUBAGENT_CANCEL_GRACE_MS;

  /** 一次子代理调用（前台等待中 / 后台运行中）；收尾即从表里删 */
  interface Job {
    id: string;
    description: string;
    startedAt: number;
    /** false = 前台：工具回调还在等它；true = 后台：回调已返回 */
    background: boolean;
    /** 是前台转后台的（用户插话触发） */
    detached: boolean;
    /** 前台才有：触发转后台（让回调立刻返回） */
    detach?: () => void;
    /** 后台运行超时的计时器 */
    timer?: NodeJS.Timeout;
    /** 超时 cancel 之后的宽限计时器：到点子 run 还没收尾就强制收尾（Q11b-03） */
    graceTimer?: NodeJS.Timeout;
    timedOut?: boolean;
    /** 这次调用的过程记录（没配记录器 / 起不来时为空） */
    rec?: SubagentRunHandle;
  }
  const jobs = new Map<string, Job>();
  /** 已通过上限检查、还没登记进 jobs 的后台调用数（见 runSubagent 里的占位） */
  let reservedBackgroundSlots = 0;
  /**
   * 本会话内每个 job 的开始时间严格递增（同一毫秒里连派两个，第二个 +1ms）。
   * 清单按 (startedAt, id) 排序、id 是随机串——时间戳撞车时顺序会随机翻转，界面上的行会跳、测试也会抖；
   * 让时间戳唯一，「先派的在前」就是确定的（耗时误差 ≤ 个位数毫秒，可忽略）。
   */
  let lastStartedAt = 0;
  const nextStartedAt = (): number => {
    lastStartedAt = Math.max(Date.now(), lastStartedAt + 1);
    return lastStartedAt;
  };
  /** 父 agent 的 agentId（attach 时记下）：后台收尾事件带上，投递时核对是不是同一个会话 */
  let parentAgentId: string | undefined;

  const backgroundRunning = (): number => {
    let n = 0;
    for (const j of jobs.values()) if (j.background) n += 1;
    return n;
  };

  /** 后台在跑的清单（界面视图，按开始时间升序；前台等待中的不算，与 backgroundRunning 同口径） */
  const backgroundJobs = (): BackgroundSubagentJobView[] =>
    [...jobs.values()]
      .filter((j) => j.background)
      .map((j) => ({
        id: j.id,
        description: j.description,
        startedAt: j.startedAt,
        detached: j.detached,
        ...(j.rec ? { runKey: j.rec.key } : {}),
      }))
      .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));

  /** 过程记录的任何调用都不许影响子代理本身：抛了只告警 */
  const recSafe = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      console.warn(
        "[cursor-subagent] 过程记录出错（已忽略）：",
        err instanceof Error ? err.message : err,
      );
    }
  };

  /** 通知「后台清单变了」：订阅方抛错只告警，绝不能挡住子代理自己的收尾 / 转后台 */
  const notifyJobsChanged = (): void => {
    try {
      bg?.onJobsChanged?.();
    } catch (err) {
      console.warn(
        "[cursor-subagent] 后台清单变化回调抛错（已忽略）：",
        err instanceof Error ? err.message : err,
      );
    }
  };

  const control: SubagentSessionControl = {
    detachForeground: () => {
      let n = 0;
      for (const j of [...jobs.values()]) {
        if (!j.background && j.detach) {
          j.detach();
          n += 1;
        }
      }
      return n;
    },
    backgroundRunning,
    backgroundJobs,
  };

  /** 3-5 个词的摘要；模型没给就取 prompt 开头 */
  const describeJob = (req: SubagentRequest): string =>
    req.description?.trim() ||
    req.prompt.replace(/\s+/g, " ").trim().slice(0, 30) ||
    "子任务";

  /** 后台运行超时被终止的说明（送主 AI 的失败事件与过程记录共用同一句） */
  const timeoutMessage = (): string =>
    `超过 ${formatDuration(maxRuntimeMs)} 仍未完成，已被终止`;

  /** 后台收尾：结果交给订阅方（chat-runner）。订阅方抛错只告警。 */
  const settleBackground = (
    job: Job,
    outcome: { ok: true; text: string } | { ok: false; err: unknown },
  ): void => {
    if (job.timer) clearTimeout(job.timer);
    if (job.graceTimer) clearTimeout(job.graceTimer);
    jobs.delete(job.id);
    if (!bg) return;
    // 先于 onSettled：这个子代理已经不在跑了，界面上的「后台工作中」条先更新，
    // 再由 onSettled 去唤醒主 AI / 落提示行（唤醒后的 run 会立刻把输入框切回「运行中」）
    notifyJobsChanged();
    const base = {
      jobId: job.id,
      parentAgentId,
      description: job.description,
      durationMs: Math.max(0, Date.now() - job.startedAt),
      detached: job.detached,
    };
    let evt: BackgroundSubagentEvent;
    if (outcome.ok) {
      evt = { ...base, status: "done", text: outcome.text };
    } else {
      const msg =
        outcome.err instanceof Error ? outcome.err.message : String(outcome.err);
      if (job.timedOut) {
        evt = {
          ...base,
          status: "failed",
          text: timeoutMessage(),
        };
      } else if (msg === CANCELLED_TEXT) {
        evt = { ...base, status: "cancelled", text: "" };
      } else {
        evt = { ...base, status: "failed", text: msg };
      }
    }
    try {
      bg.onSettled(evt);
    } catch (err) {
      console.warn(
        "[cursor-subagent] 后台子代理收尾回调抛错：",
        err instanceof Error ? err.message : err,
      );
    }
  };

  /**
   * 超时终止子 run：cancel 加期限、失败 / 超时只告警。
   * SDK 的 cancel 自己也会抛 / 挂死（半死连接），所以收尾**不指望它**——见 goBackground 的宽限计时器。
   * 包一层 `.then`：cancel 同步抛错也变成 rejection，不会炸在计时器回调里。
   */
  const cancelRunBounded = async (run: SubagentChildRun): Promise<void> => {
    try {
      await withSdkDeadline(
        Promise.resolve().then(() => run.cancel()),
        SUBAGENT_SDK_CANCEL_DEADLINE_MS,
        "subagent.cancel",
      );
    } catch (err) {
      console.warn(
        "[cursor-subagent] 后台子代理超时终止：cancel 失败 / 超时（宽限到点后强制收尾）：",
        err instanceof Error ? err.message : err,
      );
    }
  };

  /** 把一个已在跑的 job 正式转成后台：计时 + 收尾时通知订阅方 */
  const goBackground = (
    job: Job,
    run: SubagentChildRun,
    settled: Promise<{ ok: true; text: string } | { ok: false; err: unknown }>,
    /** 强制收尾：让 settle 里的赛跑以这个错误让位（cancel 无效时的最后手段） */
    expire: (err: Error) => void,
  ): void => {
    job.background = true;
    job.detach = undefined;
    recSafe(() => job.rec?.setBackground(job.detached));
    // 上限从「子代理开始」算，不是从转后台这一刻：前台已经跑的时间要扣掉
    // （否则前台跑了 25 分钟再被插话转后台的，总共能跑 55 分钟，与提示词里承诺的「每个最长跑 N 分钟」不符）。
    // 前台本身没有上限：转后台时已经超了的，短暂收尾（至少 1 秒），不再多给一个完整的上限
    const remainingMs = maxRuntimeMs - Math.max(0, Date.now() - job.startedAt);
    const delayMs = Math.max(
      Math.min(BACKGROUND_MIN_REMAINING_MS, maxRuntimeMs),
      remainingMs,
    );
    job.timer = setTimeout(() => {
      // 只打标、不在这里给记录收尾：cancel 来得太晚时子 run 可能其实已经成功返回，
      // 主 AI 会收到 done——详情面板必须和主 AI 看到的一致。记录统一由 settle 按真实结局收尾
      // （超时被杀 → settle 看到 cancelled 且 job.timedOut，写成「失败·超时」）
      job.timedOut = true;
      void cancelRunBounded(run);
      // 宽限：cancel 之后流 / wait 仍不结束（cancel 抛错 / 被忽略 / 流挂死）→ 强制收尾，
      // 不留僵尸 job。正常收尾（settleBackground）会把这个计时器清掉
      job.graceTimer = setTimeout(
        () => expire(new Error(timeoutMessage())),
        cancelGraceMs,
      );
      job.graceTimer.unref?.();
    }, delayMs);
    job.timer.unref?.();
    void settled.then((outcome) => settleBackground(job, outcome));
    // 此刻起它算「后台在跑」：界面要画出来（前台转后台的那一刻同理）
    notifyJobsChanged();
  };

  const runSubagent = async (
    req: SubagentRequest,
    rawSubagentType?: string,
    /** SDK 给工具回调的 toolCallId：过程记录用它精确绑到事件流卡片的 callId */
    toolCallId?: string,
  ): Promise<string> => {
    const gen0 = generation;
    const cancelled = (): boolean => generation !== gen0;

    const wantsBackground = req.runInBackground === true;
    // 不支持后台的会话（task 模式 / 一次性调用）收到了也明说，不静默当前台跑——
    // 模型以为「已经放后台」会接着往下做、实际却卡在这里等
    if (wantsBackground && !bg) {
      throw new SubagentUsageError(
        "当前会话不支持 run_in_background（后台运行只在对话里可用）；去掉它，直接等子代理返回结果。",
      );
    }
    // 同一步里模型常一口气发好几个调用：占位必须和检查同步（建子 agent 要 await，
    // 等它们各自登记进 jobs 再数就全放行了）。占位在 job 登记（之后算进 backgroundRunning）或出错时归还。
    if (wantsBackground && backgroundRunning() + reservedBackgroundSlots >= maxConcurrent) {
      throw new SubagentUsageError(
        `后台子代理已有 ${backgroundRunning() + reservedBackgroundSlots} 个在跑（上限 ${maxConcurrent}）；等其中一个完成，或这次改成前台（不传 run_in_background）。`,
      );
    }
    let slotReserved = false;
    const releaseSlot = (): void => {
      if (!slotReserved) return;
      slotReserved = false;
      reservedBackgroundSlots -= 1;
    };
    if (wantsBackground) {
      slotReserved = true;
      reservedBackgroundSlots += 1;
    }

    // 占位之后的每条退出路径都要归还后台名额、并释放 busy。成功走到 settle（它接管 busy 的释放）之前，由外层 finally 释放。
    // claimResumable 会抛（id 找不到 / 在忙 / model·effort·subagentType 对不上），所以必须放进 try 里：
    // 放在 try 外面时，上面已占的后台名额没人归还，一个会话泄漏 maxConcurrent 次就再也派不了后台子代理
    // （应用重启后找不到旧子代理是最常见的触发）。它只在检查全过之后才置 busy，所以抛错时没有 busy 要还。
    let claimed: ReturnType<typeof claimResumable> | undefined;
    let settleOwnsBusy = false;
    try {
      claimed = req.resume ? claimResumable(req, rawSubagentType) : undefined;
      const resumed = claimed;
      let childModel: SubagentModelSelection | undefined;
      let explore: boolean;
      if (resumed) {
        // 沿用当初登记的模型 / 只读属性：不拉目录、不重新解析（model / effort 没被改已在 claimResumable 确认）
        childModel = resumed.info.model;
        explore = resumed.info.explore;
      } else {
        const parentSel: SubagentModelSelection = deps.parentModel ?? {
          id: "default",
        };

        const catalog = subagentNeedsCatalog(req)
          ? await loadCatalog()
          : null;
        if (wantsModelList(req.model)) {
          return catalog
            ? `当前模型：${deps.parentModel?.id ?? "(未指定)"}\n可选模型（当前 provider）：\n${formatModelCatalog(catalog)}`
            : "拿不到当前 provider 的模型清单；可直接填模型 id，或省略 model 沿用当前模型。";
        }
        // Cursor 各模型的 effort 参数 id 不统一（reasoning_effort / effort / thinking），
        // 没有目录就没法知道该写哪个 id——宁可明确报错也不乱猜（猜错 SDK 会静默忽略）
        if (req.effort && !catalog) {
          throw new SubagentUsageError(
            "拿不到当前 provider 的模型清单，无法确定 effort 该用哪个参数；先省略 effort（沿用当前档位），或稍后重试。",
          );
        }
        const resolved = resolveSubagentModel(req, parentSel, catalog);
        if (!resolved.ok) throw new SubagentUsageError(resolved.error);
        if (cancelled()) throw new Error(CANCELLED_TEXT);

        // 父会话没显式选模型且这次也没换 → 不替它编一个模型 id，让 SDK 走默认
        childModel =
          resolved.inherited && !deps.parentModel ? undefined : resolved.model;
        explore = req.subagentType === "explore";
      }

      const closeChild = async (c: SubagentChildAgent | undefined): Promise<void> => {
        try {
          // close 自己也可能挂（半死连接）：超过期限就放弃等待——收尾（摘 live / 放 busy / 通知后台清单）不能被它拖住
          await withSdkDeadline(
            Promise.resolve(c?.close?.()),
            SUBAGENT_SDK_CLOSE_DEADLINE_MS,
            "subagent.close",
          );
        } catch {
          /* 关闭失败 / 超时不影响结果 */
        }
      };

      // 建 / 接上子 agent 并发出任务——后台运行也要同步做完这一步：
      // 用法错误（resume 接不上等）要在这次工具调用里报给模型，不能等到后台才发现
      let child: SubagentChildAgent | undefined;
      let run: SubagentChildRun | undefined;
      try {
        child = resumed
          ? await openResumed(resumed.id, childModel, explore)
          : await deps.createChild({ model: childModel, explore });
        if (cancelled()) throw new Error(CANCELLED_TEXT);
        run = await child.send(req.prompt);
        // 先登记再复查（同步、中间无 await）：cancelAll 要么看得到它、要么先于它改了代数
        live.add(run);
        if (cancelled()) {
          await run.cancel().catch(noop);
          throw new Error(CANCELLED_TEXT);
        }
      } catch (err) {
        if (run) live.delete(run);
        await closeChild(child);
        throw err;
      }
      const startedChild = child;
      const startedRun = run;

      // 过程记录：子 run 已经起来了才开始记（建子 agent 失败的用法错误不值得留一份）
      let rec: SubagentRunHandle | undefined;
      if (deps.transcripts) {
        try {
          rec = deps.transcripts.start({
            description: describeJob(req),
            prompt: req.prompt,
            model: childModel?.id,
            effort: effectiveEffortOf(childModel),
            explore,
            resumed: !!resumed,
            agentId: startedChild.agentId ?? resumed?.id,
            toolCallId,
            background: wantsBackground,
          });
        } catch (err) {
          console.warn(
            "[cursor-subagent] 过程记录起不来（已忽略、照常跑）：",
            err instanceof Error ? err.message : err,
          );
        }
      }

      // job 先于 settle 建好：settle 收尾记录时要读 job.timedOut（超时被杀 ≠ 用户取消）
      const job: Job = {
        id: `bg_${randomUUID().slice(0, 8)}`,
        description: describeJob(req),
        startedAt: nextStartedAt(),
        background: false,
        detached: false,
        rec,
      };

      // 强制收尾的出口：goBackground 的宽限计时器到点调 expire(err)，settle 里的赛跑随即让位（Q11b-03）
      let abandoned = false;
      let rejectExpiry!: (err: Error) => void;
      const expiry = new Promise<never>((_, reject) => {
        rejectExpiry = reject;
      });
      expiry.catch(noop); // settle 已收尾、没人在等时的 reject 不算未处理
      const expire = (err: Error): void => {
        abandoned = true;
        rejectExpiry(err);
      };

      /** 等子 run 跑完、产出给调用方的文本；收尾（摘 live / 关子 agent / 释放 busy）都在这里 */
      const settle = async (): Promise<string> => {
        try {
          let streamed = "";
          // 流 + wait 放进 drive，与 expiry 赛跑：cancel 无效 / 流挂死时 settle 不被它拖住——
          // 否则永远走不到下面的 finally（子 agent 不关、busy 不放、job 不收尾）。
          // 赛输的 drive 在后台自生自灭：它迟到的结果一律丢弃（成功路径的副作用都在赛跑之后）
          const drive = async () => {
            try {
              for await (const m of startedRun.stream()) {
                if (abandoned) break;
                streamed += toText(m);
                recSafe(() => rec?.onMessage(m));
              }
            } catch {
              // 流中途断：终态以 wait() 为准（失败会在下面抛出来）
            }
            return startedRun.wait();
          };
          const res = await Promise.race([drive(), expiry]);
          if (res.status === "cancelled") throw new Error(CANCELLED_TEXT);
          if (res.status !== "finished") {
            const partial = (res.result ?? streamed).trim();
            const reason = describeRunFailure(res);
            throw new Error(
              partial
                ? `${reason}\n（子任务中途失败，已产出的部分内容：）\n${partial}`
                : reason,
            );
          }
          const text = (res.result ?? streamed).trim() || "(子任务无输出)";
          // 只有成功才登记 / 给 id：失败、取消的子代理状态不确定，不鼓励接着做
          const childId = startedChild.agentId ?? resumed?.id;
          // 两步各自兜底：setAgentId 抛了也不能跳过 finish，否则记录会一直停在 running
          recSafe(() => rec?.setAgentId(childId)); // 有的 SDK 版本 send 之后才有 agentId
          recSafe(() => rec?.finish({ status: "done", result: text }));
          if (!childId) return text;
          rememberChild(
            parentKey,
            childId,
            resumed ? resumed.info : { model: childModel, explore, busy: false },
          );
          return text + formatSubagentTrailer({ agentId: childId, model: childModel });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          recSafe(() =>
            rec?.finish(
              // 超时被杀：子 run 被我们 cancel、这里看到的是 cancelled，但原因是超时、不是用户取消
              job.timedOut
                ? { status: "failed", error: timeoutMessage() }
                : msg === CANCELLED_TEXT
                  ? { status: "cancelled" }
                  : { status: "failed", error: msg },
            ),
          );
          throw err;
        } finally {
          live.delete(startedRun);
          await closeChild(startedChild);
          if (resumed) resumed.info.busy = false;
        }
      };

      settleOwnsBusy = true;
      // settle 永不 reject：统一成 { ok } 结果，前台 / 后台 / 转后台三条出口共用
      const settled = settle().then(
        (text) => ({ ok: true as const, text }),
        (err: unknown) => ({ ok: false as const, err }),
      );

      if (wantsBackground) {
        jobs.set(job.id, job);
        releaseSlot(); // 已登记进 jobs，从此算进 backgroundRunning
        goBackground(job, startedRun, settled, expire);
        return (
          `已在后台启动子代理「${job.description}」（后台任务 ${job.id}）。` +
          "它做完后系统会把它的输出作为一条消息发给你——不用轮询、也不要等它，现在可以继续做别的事、或回应用户。"
        );
      }

      // 前台：回调等着它；开了后台运行的会话里，用户一插话就把它转后台（回调立刻返回）
      if (bg) {
        jobs.set(job.id, job);
        const detachedP = new Promise<"detached">((resolve) => {
          job.detach = () => resolve("detached");
        });
        const first = await Promise.race([settled, detachedP]);
        if (first === "detached") {
          job.detached = true;
          goBackground(job, startedRun, settled, expire);
          return (
            `[这个子代理已转到后台继续运行] 用户有新的话要先跟你说。子代理「${job.description}」（后台任务 ${job.id}）还在干活，` +
            "做完后系统会把它的输出作为一条消息发给你；现在先回应用户，不要等它。"
          );
        }
        jobs.delete(job.id);
        if (!first.ok) throw first.err;
        return first.text;
      }
      const outcome = await settled;
      if (!outcome.ok) throw outcome.err;
      return outcome.text;
    } finally {
      releaseSlot();
      if (claimed && !settleOwnsBusy) claimed.info.busy = false;
    }
  };

  /** 原始 subagentType（parse 之后只剩归一化的 explore / general，分不出「没填」和「填了 general」） */
  const rawSubagentTypeOf = (args: unknown): string | undefined => {
    if (!args || typeof args !== "object") return undefined;
    const t = (args as Record<string, unknown>).subagentType;
    return typeof t === "string" && t.trim() ? t.trim() : undefined;
  };

  const tool: SDKCustomTool = {
    description: bg
      ? `${CURSOR_SUBAGENT_DESCRIPTION}${cursorSubagentBackgroundNote({ maxConcurrent, maxRuntimeMs })}`
      : CURSOR_SUBAGENT_DESCRIPTION,
    inputSchema: JSON.parse(
      JSON.stringify(
        bg
          ? CURSOR_SUBAGENT_INPUT_JSON_SCHEMA_WITH_BACKGROUND
          : CURSOR_SUBAGENT_INPUT_JSON_SCHEMA,
      ),
    ) as NonNullable<SDKCustomTool["inputSchema"]>,
    execute: async (args, context) => {
      const parsed = parseSubagentRequest(args);
      // 用法错误（prompt 空 / model / effort 无效）：isError 标出来，message 原样给模型改
      if (!parsed.ok) return textResult(parsed.error, true);
      try {
        const out = await runSubagent(
          parsed.request,
          rawSubagentTypeOf(args),
          context?.toolCallId,
        );
        return textResult(out || "(子任务无输出)");
      } catch (err) {
        if (err instanceof SubagentUsageError) {
          return textResult(err.message, true);
        }
        const msg = err instanceof Error ? err.message : String(err);
        // 取消不是失败：不加「子任务失败」前缀，也别当错误吓模型
        if (msg === CANCELLED_TEXT) return textResult(CANCELLED_TEXT);
        return textResult(`子任务失败：${msg}`, true);
      }
    },
  };

  const attach = <A extends object>(agent: A): A => {
    // 先读 id 再包代理（登记表按父 agent id 分桶，见 parentKey）
    const id = (agent as { agentId?: unknown }).agentId;
    if (typeof id === "string" && id) {
      parentKey = id;
      parentAgentId = id;
    }
    const wrapped = wrapAgentWithCancelLink(agent, cancelAll);
    // 事件流卡片徽标要显示「沿用」的实际模型：登记在返回给调用方的这个对象上（见 subagent-parent-model）
    setSubagentParentModel(wrapped, deps.parentModel);
    // 同样登记「查默认档 / resume 子代理模型」的查表函数（事件流卡片徽标用，见 subagent-parent-model）
    setSubagentDisplayLookup(wrapped, { defaultEffortOf, resumedChildOf });
    // 转后台 / 后台计数的控制面同样登记在 wrapped 上，chat-runner 经 rec.agent 取
    setSubagentSessionControl(wrapped, control);
    return wrapped;
  };

  return { tool, attach, cancelAll, control };
};

// ----------------- 取消联动（Proxy 包一层：send→run.cancel / close / asyncDispose） -----------------

type AnyFn = (...args: unknown[]) => unknown;

/**
 * 为什么用 Proxy 而不是直接改对象的方法：
 * 原地替换 `run.cancel` / `agent.close` 会换掉 SDK 对象上的方法本身——任何持有原对象、
 * 对原方法做比较 / 断言的代码都会失效（实测：chat-runner 一批测试断言 `fakeRun.cancel` 这个 spy，
 * 被替换后报「not a spy」）。代理不碰原对象，原方法原封不动，只是经代理调用时多做一步联动。
 *
 * 取属性一律 `Reflect.get(target, prop, target)` 且函数绑回 target：SDK 的 Run / Agent 是 class 实例，
 * 方法里可能读私有字段 / getter，`this` 必须是原对象，不能是代理。
 */
const getFromTarget = (target: object, prop: string | symbol): unknown => {
  const v = Reflect.get(target, prop, target);
  return typeof v === "function" ? (v as AnyFn).bind(target) : v;
};

/** 冻结的对象 Proxy 不得改 get 的返回值（违反不变式会抛 TypeError），这种直接不代理 */
const canProxy = (o: unknown): o is object =>
  o !== null && typeof o === "object" && !Object.isFrozen(o);

/** run 的代理：`cancel` 先把取消发给子 run、再放行父的 cancel（父的结果 / 错误原样返回） */
const wrapRunWithCancelLink = <R>(
  run: R,
  cancelChildren: () => Promise<void>,
): R => {
  if (!canProxy(run)) return run;
  return new Proxy(run, {
    get(target, prop) {
      if (prop !== "cancel") return getFromTarget(target, prop);
      const orig = getFromTarget(target, "cancel");
      if (typeof orig !== "function") return orig;
      return (...args: unknown[]): Promise<unknown> => {
        // 父 cancel 先发出去（它的 rejection 必须有人接住，否则等子取消期间会冒成 unhandled）
        const parent = Promise.resolve()
          .then(() => (orig as AnyFn)(...args))
          .then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
        return cancelChildren()
          .catch(noop)
          .then(() => parent)
          .then((settled) => {
            if (!settled.ok) throw settled.error;
            return settled.value;
          });
      };
    },
  }) as R;
};

/**
 * agent 的代理：
 *  - `send` 返回的 run 套上 {@link wrapRunWithCancelLink}；
 *  - `close` / `[Symbol.asyncDispose]` 先停子 run（会话被关后子代理不能继续烧 token）。
 * 其余属性 / 方法原样透传。
 */
const wrapAgentWithCancelLink = <A extends object>(
  agent: A,
  cancelChildren: () => Promise<void>,
): A => {
  if (!canProxy(agent)) {
    // 冻结的 agent 没法代理：退化成无联动（子 run 靠自然结束 / 用户取消），但要留痕、别装作联动了
    console.warn("[cursor-subagent] agent 不可代理，取消不联动子代理");
    return agent;
  }
  return new Proxy(agent, {
    get(target, prop) {
      const v = getFromTarget(target, prop);
      if (typeof v !== "function") return v;
      if (prop === "send") {
        return async (...args: unknown[]): Promise<unknown> =>
          wrapRunWithCancelLink(await (v as AnyFn)(...args), cancelChildren);
      }
      if (prop === "close") {
        return (...args: unknown[]): unknown => {
          void cancelChildren().catch(noop);
          return (v as AnyFn)(...args);
        };
      }
      if (prop === Symbol.asyncDispose) {
        return async (...args: unknown[]): Promise<unknown> => {
          await cancelChildren().catch(noop);
          return (v as AnyFn)(...args);
        };
      }
      return v;
    },
  });
};

// ----------------- 真实依赖（Cursor SDK） -----------------

/**
 * 为一个父 agent 实例建 link（真实 SDK 依赖）。
 * 子 agent 一律：同 apiKey / cwd、`settingSources:[]`（不加载 .cursor/，与父会话一致）、
 * 不带 customTools / mcpServers；模型参数过 `withoutHiddenModelSelection`（与 facade 同口径）。
 */
export const createCursorSubagentLinkForSession = (opts: {
  apiKey: string;
  parentModel?: ModelSelection;
  cwd?: string;
  /** 给了 = 开后台运行（chat 会话）：后台子代理收尾事件按这个 taskId 投递给 chat-runner */
  backgroundTaskId?: string;
  /** 父 run 被取消 / 会话被关时同步调一次（见 {@link CursorSubagentDeps.onParentCancel}） */
  onParentCancel?: () => void;
  /** 子代理过程记录器（装配层绑好 taskId）；不给 = 不记 */
  transcripts?: SubagentTranscriptSink;
}): SubagentLink => {
  const parentModel = opts.parentModel
    ? withoutHiddenModelSelection(opts.parentModel)
    : undefined;
  const backgroundTaskId = opts.backgroundTaskId;
  return createCursorSubagentLink({
    parentModel,
    ...(opts.onParentCancel ? { onParentCancel: opts.onParentCancel } : {}),
    ...(opts.transcripts ? { transcripts: opts.transcripts } : {}),
    ...(backgroundTaskId
      ? {
          background: {
            onSettled: (evt) =>
              emitBackgroundSubagentSettled(backgroundTaskId, evt),
            onJobsChanged: () =>
              emitBackgroundSubagentJobsChanged(backgroundTaskId),
          },
        }
      : {}),
    peekCatalog: () => {
      const cached = getCachedModelOptions({
        kind: "cursor",
        apiKey: opts.apiKey,
      });
      return cached ? catalogFromModelOptions(cached) : null;
    },
    loadCatalog: async () => {
      try {
        const options = await listModelOptions({
          kind: "cursor",
          apiKey: opts.apiKey,
        });
        return catalogFromModelOptions(options);
      } catch (err) {
        console.warn(
          "[cursor-subagent] 模型清单拿不到、跳过校验：",
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    },
    // create 与 resume 共用同一份选项：`tools` / `disallowedTools` 都不持久化，
    // resume 不原样再传一遍，只读子代理就会悄悄拿到写权限（或多出 task）
    createChild: async ({ model, explore }) => {
      // 与父会话同口径：create / send 都有硬上限（半死连接不能让父会话永远停在「子代理工作中」）；
      // 超时后迟到才返回的 agent / run 由 withSdkDeadline 自动 close / cancel，不留孤儿。
      // 只管「受理」，不限子任务本身跑多久（那由用户取消 / 整轮 24h 顶兜）。
      const agent = await withSdkDeadline(
        withCursorJsonlStore(childAgentOptions(opts, model, explore)).then((b) =>
          CursorAgent.create(b),
        ),
        SDK_CREATE_RESUME_TIMEOUT_MS,
        "subagent.create",
      );
      return wrapChildAgent(agent);
    },
    resumeChild: async ({ agentId, model, explore }) => {
      const agent = await withSdkDeadline(
        withCursorJsonlStore(childAgentOptions(opts, model, explore)).then((b) =>
          CursorAgent.resume(agentId, b),
        ),
        SDK_CREATE_RESUME_TIMEOUT_MS,
        "subagent.resume",
      );
      return wrapChildAgent(agent);
    },
  });
};

/** 子 agent 的创建 / 恢复选项（两处共用，见上） */
const childAgentOptions = (
  opts: { apiKey: string; cwd?: string },
  model: SubagentModelSelection | undefined,
  explore: boolean,
): Parameters<typeof CursorAgent.create>[0] => ({
  apiKey: opts.apiKey,
  ...(model ? { model: withoutHiddenModelSelection(model) } : {}),
  local: {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    settingSources: [],
  },
  // explore：只给读 / 搜白名单；其余：默认内置工具、去掉 task 防递归
  ...(explore
    ? { tools: [...CURSOR_SUBAGENT_READONLY_TOOLS] }
    : { disallowedTools: withNativeTaskDisabled(undefined) }),
});

/** 真实 SDK agent → 工具层用的最小形状（带上 agentId，供登记 / resume） */
const wrapChildAgent = (agent: {
  agentId: string;
  send: (prompt: string) => Promise<SubagentChildRun>;
  close: () => unknown;
}): SubagentChildAgent => ({
  agentId: agent.agentId,
  send: (prompt) =>
    withSdkDeadline(agent.send(prompt), SDK_SEND_TIMEOUT_MS, "subagent.send"),
  close: () => agent.close(),
});

export { CURSOR_SUBAGENT_TOOL_NAME } from "@/lib/cursor-subagent-display";
